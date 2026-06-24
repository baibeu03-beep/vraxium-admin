// ─────────────────────────────────────────────────────────────────────────
// 실무정보(info) 라인 import v2 — 신규 멀티시트 포맷 전용.
//   기존 import-info-lines-xlsx.ts 와의 차이(이 파일 구조에 맞춘 보강):
//     1) infodesk 필수 요구 제거. 시트 스펙 = 위즈덤/에세이/포럼/캘린더/세션/아카데미.
//     2) 세션(session)·아카데미(practical_lecture) 활동유형 추가.
//     3) 캘린더(calendar)를 recurring 이 아니라 weekly 로 처리(이 파일은 주차별 고유 콘텐츠).
//     4) 빈 시작일 행은 "{YY} {시즌} {N}주차" 라벨 → (season_key, week_number) 로 week_id 자동 매칭.
//          - 0개 매칭 = skip(보고) · 1개 = 성공 · 2개+ = 모호(자동선택 금지, skip+보고).
//     5) main_title 빈 행 = skip(라인 미개설). 휴식/없음 = skip.
//     6) "라인 개설 대상 크루" 컬럼 = encre display_name → user_id 단일매칭만 cluster4_line_targets 생성 예정.
//          미매칭/동명이인은 생성 금지 + 별도 목록 보고. 기존 대상자 있으면 replace 금지.
//   org SoT = line_code 토큰(EC/OK/PX). common = null.
//   dry-run 기본. --execute 는 별도 구현 필요(현재 미구현 — DB write 안 함).
// ─────────────────────────────────────────────────────────────────────────
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@supabase/supabase-js";
import { resolvePeriodLabelFromWeek } from "@/lib/cluster4PeriodLabel";
import { markWeeklyCardsSnapshotStaleMany, recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

type WeekRow = {
  id: string;
  start_date: string;
  end_date: string;
  iso_year: number | null;
  iso_week: number | null;
  week_number: number | null;
  season_key: string | null;
  is_official_rest: boolean | null;
};

type OutputLink = { label: string | null; url: string };

const ORG_LINE_CODE_TOKEN: Record<string, string | null> = {
  oranke: "OK",
  encre: "EC",
  phalanx: "PX",
  common: null,
};

// 시트 스펙 — 전부 weekly. hasCrew = "라인 개설 대상 크루" 컬럼 보유(수동 대상 지정 가능).
const SHEETS: Array<{ base: string; act: string; hasCrew: boolean }> = [
  { base: "위즈덤", act: "wisdom", hasCrew: false },
  { base: "에세이", act: "essay", hasCrew: false },
  { base: "포럼", act: "forum", hasCrew: true },
  { base: "캘린더", act: "calendar", hasCrew: false },
  { base: "세션", act: "session", hasCrew: true },
  { base: "아카데미", act: "practical_lecture", hasCrew: true },
];

const SEASON_KO_TO_KEY: Record<string, string> = {
  겨울: "winter",
  봄: "spring",
  여름: "summer",
  가을: "autumn",
};

const CAFE_OUTPUT_LINK_LABEL = "카페 공표글 링크";
const DAY_MS = 86_400_000;

// 운영자 확정(2026-06-23): 24봄10주차(2024-spring wn10 결번) → 2024-05-06 주차로 수동 매핑.
//   weeks 테이블 미수정. 별도 정합성 조사 보고서 참조.
const WN10_OVERRIDE_START = "2024-05-06";

// 운영자 확정: 동명이인 자동확정 8건(활동시작일 결정적). key = `${sheetBase}|${weekLabel}|${name}`.
//   나머지 6건(아래 미포함)은 자동확정 불가 → target 미생성·별도 보류.
const DUP_CONFIRM: Record<string, string> = {
  "포럼|2025-W20|이혜인": "787d36ba-ac71-4682-912d-d020b5162000",
  "포럼|2025-W37|김수연": "d09aeeb3-49bc-445a-b0cc-3b7ed9747167",
  "포럼|2025-W39|김수연": "d09aeeb3-49bc-445a-b0cc-3b7ed9747167",
  "포럼|2025-W46|이혜인": "787d36ba-ac71-4682-912d-d020b5162000",
  "포럼|2024-W46|김도연": "b6959224-a3f7-4730-943a-3054e34f48de",
  "아카데미|2025-W31|김수연": "d09aeeb3-49bc-445a-b0cc-3b7ed9747167",
  "아카데미|2025-W31|조서연": "c3ee81af-eb4e-4c52-8d7f-490e5d8c5bb1",
  "아카데미|2024-W40|이혜원": "e6d66843-ae50-4672-9421-d8a04e9b55f2",
};

// ── xlsx 파싱 헬퍼(기존 스크립트와 동일 로직) ──
function decodeXml(v: string) {
  return v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function attr(tag: string, name: string) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}
function textOf(xml: string, t: string) {
  const ms = [...xml.matchAll(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "g"))];
  return ms.map((m) => m[1].replace(/<[^>]+>/g, "")).join("");
}
function colIdx(ref: string) {
  const L = ref.replace(/[0-9]/g, "").toUpperCase();
  let v = 0;
  for (const c of L) v = v * 26 + (c.charCodeAt(0) - 64);
  return v - 1;
}
function extractXlsx(fp: string): string {
  const out = join(tmpdir(), `info-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(out, { recursive: true });
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = $env:VRAXIUM_XLSX_ZIP_PATH",
    "$dest = $env:VRAXIUM_XLSX_DEST_PATH",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "pipe",
    env: { ...process.env, VRAXIUM_XLSX_ZIP_PATH: fp, VRAXIUM_XLSX_DEST_PATH: out },
  });
  return out;
}
function parseSharedStrings(root: string): string[] {
  const p = join(root, "xl", "sharedStrings.xml");
  if (!existsSync(p)) return [];
  const xml = readFileSync(p, "utf8");
  const s: string[] = [];
  for (const m of xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) s.push(decodeXml(textOf(m[1], "t").replace(/\s+/g, " ").trim()));
  return s;
}
function parseSheetRows(xml: string, ss: string[]): Record<number, string>[] {
  const rows: Record<number, string>[] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: Record<number, string> = {};
    for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = attr(`<c ${cm[1]}>`, "r");
      if (!ref) continue;
      const type = attr(`<c ${cm[1]}>`, "t");
      const val = textOf(cm[2], "v");
      let txt = val;
      if (type === "s" && val !== "") txt = ss[Number(val)] ?? "";
      else if (type === "inlineStr") txt = textOf(cm[2], "t");
      row[colIdx(ref)] = decodeXml(txt).replace(/\s+/g, " ").trim();
    }
    rows.push(row);
  }
  return rows;
}
function parseSheets(root: string): Array<{ name: string; rows: Record<number, string>[] }> {
  const wb = readFileSync(join(root, "xl/workbook.xml"), "utf8");
  const rels = readFileSync(join(root, "xl/_rels/workbook.xml.rels"), "utf8");
  const ss = parseSharedStrings(root);
  const rel = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"),
      t = attr(m[0], "Target");
    if (id && t) rel.set(id, t);
  }
  const out: Array<{ name: string; rows: Record<number, string>[] }> = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name"),
      rid = attr(m[0], "r:id");
    if (!name || !rid) continue;
    const tgt = rel.get(rid);
    if (!tgt) continue;
    const sp = tgt.startsWith("/") ? tgt.slice(1) : join("xl", tgt).replace(/\\/g, "/");
    out.push({ name, rows: parseSheetRows(readFileSync(join(root, sp), "utf8"), ss) });
  }
  return out;
}
function normSheet(n: string) {
  return n.replace(/\(?\s*수정\s*\)?/g, "").replace(/\s+/g, "");
}

// ── 날짜/주차 ──
function parseDate(v: string | undefined): string | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * DAY_MS).toISOString().slice(0, 10);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
// "25 겨울 3주차" → { seasonKey:"2025-winter", weekNumber:3 }
function parsePeriodLabel(label: string): { seasonKey: string; weekNumber: number } | null {
  const m = String(label ?? "").match(/(\d{2})\s*(겨울|봄|여름|가을)\s*(\d+)\s*주차/);
  if (!m) return null;
  const key = SEASON_KO_TO_KEY[m[2]];
  if (!key) return null;
  return { seasonKey: `20${m[1]}-${key}`, weekNumber: Number(m[3]) };
}
function weekRefForLineCode(w: WeekRow): string {
  if (w.iso_year && w.iso_week) return `${w.iso_year}w${String(w.iso_week).padStart(2, "0")}`;
  return w.id.slice(0, 8);
}
function buildLineCode(orgToken: string | null, act: string, w: WeekRow): string | null {
  if (!orgToken) return null;
  return `info-${orgToken}-${act}-${weekRefForLineCode(w)}`;
}
function weekLabel(w: WeekRow): string {
  if (w.iso_year && w.iso_week) return `${w.iso_year}-W${String(w.iso_week).padStart(2, "0")}`;
  return `${w.start_date}~${w.end_date}`;
}

// ── 아웃풋 링크 ──
function parseOutputLinks(raw: string): OutputLink[] {
  const text = String(raw ?? "").trim();
  if (!text || text === "(아웃풋 링크 없음)") return [];
  const urlRegex = /https?:\/\/[^\s\[]+/g;
  const matches = [...text.matchAll(urlRegex)];
  const links: OutputLink[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const url = matches[i][0].replace(/[),.;]+$/g, "");
    links.push({ label: CAFE_OUTPUT_LINK_LABEL, url });
  }
  return links;
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1] ?? null;
}
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required (run with --env-file=.env.local)`);
  return v;
}

type Candidate = {
  act: string;
  sheet: string;
  rowNumber: number;
  week: WeekRow;
  lineCode: string | null;
  mainTitle: string;
  outputLinks: OutputLink[];
  crewRaw: string | null;
  targetUserIds?: string[];
};

function submissionWindowForWeek(startDate: string): { submission_opens_at: string; submission_closes_at: string } {
  const weekStartMs = Date.UTC(Number(startDate.slice(0, 4)), Number(startDate.slice(5, 7)) - 1, Number(startDate.slice(8, 10)));
  const wednesdayMs = weekStartMs + 2 * DAY_MS;
  return {
    submission_opens_at: new Date(weekStartMs - 9 * 3600_000).toISOString(),
    submission_closes_at: new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString(),
  };
}

function linePayload(c: Candidate, fileName: string) {
  const links = c.outputLinks.slice(0, 2);
  const w = submissionWindowForWeek(c.week.start_date);
  return {
    part_type: "info",
    activity_type_id: c.act,
    main_title: c.mainTitle,
    line_code: c.lineCode,
    output_link_1: links[0]?.url ?? null,
    output_link_2: links[1]?.url ?? null,
    output_links: links,
    output_images: [],
    submission_opens_at: w.submission_opens_at,
    submission_closes_at: w.submission_closes_at,
    is_active: true,
    source_type: "excel_import",
    recognition_mode: "legacy_allowed",
    is_readonly: false,
    period_label: resolvePeriodLabelFromWeek({ isoYear: c.week.iso_year, seasonKey: c.week.season_key, weekNumber: c.week.week_number }),
    start_date: c.week.start_date,
    end_date: c.week.end_date,
    week_id: c.week.id,
    source_file_name: fileName,
    source_sheet_name: c.sheet,
    is_recurring_content: false,
    recurring_source_sheet_name: null,
  };
}

async function main() {
  const file = argValue("--file");
  if (!file) throw new Error("--file required");
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const execute = process.argv.includes("--execute");
  const organization = (argValue("--organization") ?? "encre").trim();
  if (!(organization in ORG_LINE_CODE_TOKEN)) throw new Error(`--organization must be one of ${Object.keys(ORG_LINE_CODE_TOKEN).join(",")}`);
  const orgToken = ORG_LINE_CODE_TOKEN[organization];

  const sb = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

  // weeks
  const { data: weeksData, error: wErr } = await sb
    .from("weeks")
    .select("id,start_date,end_date,iso_year,iso_week,week_number,season_key,is_official_rest")
    .order("start_date");
  if (wErr) throw new Error(`weeks query failed: ${wErr.message}`);
  const weeks = (weeksData ?? []) as WeekRow[];
  const byStart = new Map<string, WeekRow>();
  const bySW = new Map<string, WeekRow[]>();
  for (const w of weeks) {
    byStart.set(String(w.start_date), w);
    const k = `${w.season_key}::${w.week_number}`;
    const a = bySW.get(k) ?? [];
    a.push(w);
    bySW.set(k, a);
  }

  // org profiles (name → user_id)
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", organization);
  const byName = new Map<string, string[]>();
  for (const p of profs ?? []) {
    const n = (p.display_name ?? "").trim();
    if (!n) continue;
    const a = byName.get(n) ?? [];
    a.push(p.user_id);
    byName.set(n, a);
  }
  const orgAudienceCount = (profs ?? []).length;

  const root = extractXlsx(file);
  try {
    const all = parseSheets(root);

    const candidates: Candidate[] = [];
    const skipEmptyTitle: Array<{ sheet: string; row: number; period: string }> = [];
    const skipRest: Array<{ sheet: string; row: number; title: string }> = [];
    const weekFail: Array<{ sheet: string; row: number; period: string; title: string; startCell: string }> = [];
    const resolvedAmbiguous: Array<{ sheet: string; row: number; period: string; title: string; chosenWeekId: string; chosenStart: string; candidateStartDates: string[] }> = [];
    const wn10Mapped: Array<{ sheet: string; row: number; title: string; mappedStart: string; weekId: string }> = [];
    const sheetNotFound: string[] = [];
    let viaDate = 0,
      viaSeasonWeek = 0;

    for (const spec of SHEETS) {
      const sheet = all.find((s) => normSheet(s.name) === normSheet(spec.base));
      if (!sheet) {
        sheetNotFound.push(spec.base);
        continue;
      }
      const headers = sheet.rows[0] ?? {};
      const find = (re: RegExp) => {
        for (const [i, l] of Object.entries(headers)) if (re.test(l)) return Number(i);
        return null;
      };
      const pCol = find(/주차|기간|날짜/);
      const sCol = find(/시작일/);
      const tCol = find(/Main Title|메인/i);
      const lCol = find(/Output|아웃풋/i);
      const cCol = find(/대상\s*크루|개설 대상/);

      for (let r = 1; r < sheet.rows.length; r++) {
        const row = sheet.rows[r];
        if (Object.values(row).every((v) => !String(v ?? "").trim())) continue;
        const rowNumber = r + 1; // 1-based(헤더=1)
        const period = pCol != null ? row[pCol] ?? "" : "";
        const title = ((tCol != null ? row[tCol] : "") ?? "").trim();
        if (!title) {
          skipEmptyTitle.push({ sheet: spec.base, row: rowNumber, period });
          continue;
        }
        if (/휴식|없음/.test(title)) {
          skipRest.push({ sheet: spec.base, row: rowNumber, title });
          continue;
        }
        // 주차 매칭: 시작일 우선, 실패 시 시즌/주차 라벨.
        let week: WeekRow | null = null;
        const startCell = sCol != null ? String(row[sCol] ?? "") : "";
        const sd = sCol != null ? parseDate(row[sCol]) : null;
        if (sd && byStart.has(sd)) {
          week = byStart.get(sd)!;
          viaDate++;
        } else {
          const pp = parsePeriodLabel(period);
          if (pp) {
            const cands = bySW.get(`${pp.seasonKey}::${pp.weekNumber}`) ?? [];
            if (cands.length === 1) {
              week = cands[0];
              viaSeasonWeek++;
            } else if (cands.length > 1) {
              // 운영자 채택: rest=false 우선, 동률이면 iso_week 최소(= dry-run 추천 week_id).
              const sorted = [...cands].sort(
                (a, b) => Number(a.is_official_rest) - Number(b.is_official_rest) || (a.iso_week ?? 0) - (b.iso_week ?? 0),
              );
              week = sorted[0];
              resolvedAmbiguous.push({
                sheet: spec.base,
                row: rowNumber,
                period,
                title,
                chosenWeekId: week.id,
                chosenStart: week.start_date,
                candidateStartDates: cands.map((c) => c.start_date),
              });
            } else if (pp.seasonKey === "2024-spring" && pp.weekNumber === 10 && byStart.has(WN10_OVERRIDE_START)) {
              // 운영자 확정 수동 매핑: 24봄10주차 → 2024-05-06.
              week = byStart.get(WN10_OVERRIDE_START)!;
              wn10Mapped.push({ sheet: spec.base, row: rowNumber, title, mappedStart: WN10_OVERRIDE_START, weekId: week.id });
            }
          }
        }
        if (!week) {
          weekFail.push({ sheet: spec.base, row: rowNumber, period, title, startCell });
          continue;
        }
        candidates.push({
          act: spec.act,
          sheet: spec.base,
          rowNumber,
          week,
          lineCode: buildLineCode(orgToken, spec.act, week),
          mainTitle: title,
          outputLinks: lCol != null ? parseOutputLinks(row[lCol] ?? "") : [],
          crewRaw: spec.hasCrew && cCol != null ? (row[cCol] ?? "").trim() || null : null,
        });
      }
    }

    // ── 기존 라인 조회: upsert 키 매칭(EC excel_import) + 공존(common/타org) ──
    const acts = [...new Set(candidates.map((c) => c.act))];
    const weekIds = [...new Set(candidates.map((c) => c.week.id))];
    const existing: Array<{ id: string; activity_type_id: string; week_id: string; main_title: string; line_code: string | null; source_type: string | null; is_active: boolean | null }> = [];
    for (let i = 0; i < weekIds.length; i += 100) {
      const slice = weekIds.slice(i, i + 100);
      const { data, error } = await sb
        .from("cluster4_lines")
        .select("id,activity_type_id,week_id,main_title,line_code,source_type,is_active")
        .eq("part_type", "info")
        .in("week_id", slice)
        .in("activity_type_id", acts);
      if (error) throw new Error(`existing query failed: ${error.message}`);
      existing.push(...((data ?? []) as any[]));
    }
    const existKey = new Map<string, string>();
    for (const e of existing) existKey.set(`${e.line_code ?? ""} ${e.activity_type_id} ${e.week_id} ${e.main_title}`, e.id);

    // update vs insert
    let insertCount = 0,
      updateCount = 0;
    for (const c of candidates) {
      const k = `${c.lineCode ?? ""} ${c.act} ${c.week.id} ${c.mainTitle}`;
      if (existKey.has(k)) updateCount++;
      else insertCount++;
    }

    // 공존 충돌: 같은 (week, act) 에 다른 line_code 기존행. is_active 로 실제 위험 분리.
    //   - ACTIVE common(null): encre 노출? → 단 null=unknown=fail-closed(미할당 크루 비노출)이라 분모A 미계상.
    //   - ACTIVE 타org(OK/PX): org 토큰 격리 → encre 비노출, 위험 없음.
    //   - INACTIVE(any): 비활성 dead row → 위험 없음(목록만).
    const activeCommonConflicts: Array<{ weekLabel: string; act: string; existingId: string; existingTitle: string }> = [];
    const inactiveCommonConflicts: Array<{ weekLabel: string; act: string; existingId: string; existingTitle: string }> = [];
    const activeOtherOrgCoexist: Record<string, number> = {};
    const seenSlot = new Set<string>();
    for (const c of candidates) {
      const slot = `${c.week.id}::${c.act}`;
      if (seenSlot.has(slot)) continue;
      seenSlot.add(slot);
      for (const e of existing) {
        if (e.week_id !== c.week.id || e.activity_type_id !== c.act) continue;
        if ((e.line_code ?? null) === c.lineCode) continue; // 동일 EC 코드(=update 대상) 제외
        const active = e.is_active === true;
        if (e.line_code == null) {
          (active ? activeCommonConflicts : inactiveCommonConflicts).push({ weekLabel: weekLabel(c.week), act: c.act, existingId: e.id, existingTitle: e.main_title });
        } else if (active) {
          const tok = e.line_code.match(/-(BS|EC|OK|PX)-/)?.[1] ?? "other";
          activeOtherOrgCoexist[tok] = (activeOtherOrgCoexist[tok] ?? 0) + 1;
        }
      }
    }

    // ── 대상 크루 매칭 ──
    type TargetPlan = { sheet: string; act: string; weekLabel: string; mainTitle: string; lineCode: string | null; created: number; userIds: string[]; matchedNames: string[]; dupConfirmedNames: string[]; unmatched: string[]; held: Array<{ name: string; count: number }> };
    const targetPlans: TargetPlan[] = [];
    let targetsToCreate = 0;
    let dupAutoConfirmed = 0;
    const dupHeldList: Array<{ sheet: string; weekLabel: string; name: string; count: number }> = [];
    const allUnmatched: Array<{ sheet: string; weekLabel: string; name: string }> = [];
    let linesWithCrew = 0;
    const crewLinesZeroMatch: Array<{ sheet: string; weekLabel: string; mainTitle: string }> = [];

    for (const c of candidates) {
      if (!c.crewRaw) continue;
      linesWithCrew++;
      const wl = weekLabel(c.week);
      const names = [...new Set(c.crewRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean))];
      const matchedNames: string[] = [];
      const dupConfirmedNames: string[] = [];
      const unmatched: string[] = [];
      const held: Array<{ name: string; count: number }> = [];
      const seenUser = new Set<string>();
      for (const nm of names) {
        const hit = byName.get(nm);
        if (!hit) {
          unmatched.push(nm);
          allUnmatched.push({ sheet: c.sheet, weekLabel: wl, name: nm });
        } else if (hit.length > 1) {
          // 동명이인: 운영자 확정맵에 있고, 그 uid 가 후보군에 속하면 확정. 아니면 보류.
          const confirmed = DUP_CONFIRM[`${c.sheet}|${wl}|${nm}`];
          if (confirmed && hit.includes(confirmed)) {
            if (!seenUser.has(confirmed)) {
              seenUser.add(confirmed);
              dupConfirmedNames.push(nm);
              dupAutoConfirmed++;
            }
          } else {
            held.push({ name: nm, count: hit.length });
            dupHeldList.push({ sheet: c.sheet, weekLabel: wl, name: nm, count: hit.length });
          }
        } else {
          if (!seenUser.has(hit[0])) {
            seenUser.add(hit[0]);
            matchedNames.push(nm);
          }
        }
      }
      const userIds = [...seenUser];
      c.targetUserIds = userIds;
      const created = userIds.length;
      targetsToCreate += created;
      if (created === 0) crewLinesZeroMatch.push({ sheet: c.sheet, weekLabel: wl, mainTitle: c.mainTitle });
      targetPlans.push({ sheet: c.sheet, act: c.act, weekLabel: wl, mainTitle: c.mainTitle, lineCode: c.lineCode, created, userIds, matchedNames, dupConfirmedNames, unmatched, held });
    }

    // 자동검수 대상 = 대상크루 컬럼값이 없는 라인(insert 후보 기준).
    const autoCheckLines = candidates.filter((c) => !c.crewRaw).length;
    const manualTargetLines = linesWithCrew;

    // activity_type 별
    const byAct: Record<string, { insert: number; skipEmptyTitle: number; rest: number; weekFail: number; crewLines: number }> = {};
    for (const spec of SHEETS) byAct[spec.act] = { insert: 0, skipEmptyTitle: 0, rest: 0, weekFail: 0, crewLines: 0 };
    for (const c of candidates) byAct[c.act].insert++;
    for (const s of skipEmptyTitle) {
      const a = SHEETS.find((x) => x.base === s.sheet)?.act;
      if (a) byAct[a].skipEmptyTitle++;
    }
    for (const s of skipRest) {
      const a = SHEETS.find((x) => x.base === s.sheet)?.act;
      if (a) byAct[a].rest++;
    }
    for (const s of weekFail) {
      const a = SHEETS.find((x) => x.base === s.sheet)?.act;
      if (a) byAct[a].weekFail++;
    }
    for (const t of targetPlans) byAct[t.act].crewLines++;

    const out = {
      mode: "dry-run-v2",
      file: basename(file),
      organization: { slug: organization, lineCodeToken: orgToken },
      sheetsFound: SHEETS.filter((s) => !sheetNotFound.includes(s.base)).map((s) => s.base),
      sheetsNotFound: sheetNotFound,
      totals: {
        insert: insertCount,
        update: updateCount,
        skip: skipEmptyTitle.length + skipRest.length + weekFail.length,
        skipBreakdown: {
          emptyTitle: skipEmptyTitle.length,
          restOrNone: skipRest.length,
          weekMatchFail: weekFail.length,
        },
      },
      byActivityType: byAct,
      weekMatch: {
        successViaStartDate: viaDate,
        successViaSeasonWeekLabel: viaSeasonWeek,
        resolvedAmbiguousCount: resolvedAmbiguous.length,
        resolvedAmbiguousList: resolvedAmbiguous,
        wn10MappedCount: wn10Mapped.length,
        wn10MappedList: wn10Mapped,
        successTotal: viaDate + viaSeasonWeek + resolvedAmbiguous.length + wn10Mapped.length,
        failCount: weekFail.length,
        failList: weekFail,
      },
      targets: {
        manualTargetLines,
        targetsToCreate,
        dupAutoConfirmed,
        dupHeldCount: dupHeldList.length,
        dupHeldList,
        unmatchedNameCount: allUnmatched.length,
        crewLinesWithZeroMatch: crewLinesZeroMatch,
        unmatchedList: allUnmatched,
        perLinePlan: targetPlans,
      },
      autoCheck: {
        autoCheckTargetLines: autoCheckLines,
        note: "대상크루 컬럼값이 없는 라인 = 자동검수 대상. 이번 import 에서는 process_acts/status 생성·완료 안 함(분리).",
      },
      coexistence: {
        oneSlotOneLineForEncre: activeCommonConflicts.length === 0,
        activeCommonConflictCount: activeCommonConflicts.length,
        activeCommonConflictList: activeCommonConflicts,
        inactiveCommonConflictCount: inactiveCommonConflicts.length,
        inactiveCommonConflictList: inactiveCommonConflicts,
        activeOtherOrgCoexist: activeOtherOrgCoexist,
        commonCalendarUpdatePlanned: 0,
        note:
          "ACTIVE common(null) = 0 이면 encre 1 slot=1 line 달성(EC insert 만으로). " +
          "null line_code = unknown = fail-closed(미할당 크루 비노출·분모A 미계상) → 17건은 비활성 dead row 라 이중노출 없음. " +
          "타org(OK/PX) active 는 토큰 격리로 encre 비노출. → common 캘린더 reuse/update 불필요(권장: EC insert).",
      },
      snapshotImpact: {
        writesSnapshot: false,
        note: "import 은 cluster4_lines(+targets) write 만. snapshot 미기록 → execute 후 encre audience invalidate/recompute 필요.",
        encreAudienceProfiles: orgAudienceCount,
      },
    };

    if (!execute) {
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    // ───────────────── EXECUTE (가역적: 롤백 파일에 inserted id 기록) ─────────────────
    const fileName = basename(file);
    const insertedLineIds: string[] = [];
    const insertedTargetIds: string[] = [];
    const execErrors: Array<{ where: string; key: string; error: string }> = [];
    let linesInserted = 0;
    let targetsInserted = 0;

    for (const c of candidates) {
      const { data, error } = await sb.from("cluster4_lines").insert(linePayload(c, fileName)).select("id").single();
      if (error || !data) {
        execErrors.push({ where: "line", key: `${c.act}/${weekLabel(c.week)}/${c.mainTitle.slice(0, 20)}`, error: error?.message ?? "no id" });
        continue;
      }
      const lineId = (data as { id: string }).id;
      insertedLineIds.push(lineId);
      linesInserted++;
      const uids = c.targetUserIds ?? [];
      for (const uid of uids) {
        const { data: t, error: te } = await sb
          .from("cluster4_line_targets")
          .insert({ line_id: lineId, week_id: c.week.id, target_mode: "user", target_user_id: uid })
          .select("id")
          .single();
        if (te || !t) execErrors.push({ where: "target", key: `${lineId}/${uid}`, error: te?.message ?? "no id" });
        else {
          insertedTargetIds.push((t as { id: string }).id);
          targetsInserted++;
        }
      }
    }

    // 롤백 파일(write 전 즉시 기록 불가 → write 후 id 기록. rollback = 이 id 들 삭제).
    const rollbackPath = `claudedocs/rollback-info-v2-${organization}-${orgToken}.json`;
    try {
      writeFileSync(rollbackPath, JSON.stringify({ organization, orgToken, file: fileName, insertedLineIds, insertedTargetIds }, null, 2), "utf8");
    } catch (e) {
      execErrors.push({ where: "rollback", key: rollbackPath, error: e instanceof Error ? e.message : String(e) });
    }

    // snapshot: encre audience invalidate(stale) + 명시적 recompute(스크립트 컨텍스트에선 after() 미동작 → 직접 재계산).
    const encreUserIds = (profs ?? []).map((p: any) => p.user_id);
    let staleCount = 0;
    let recomputeCount = 0;
    let recomputeFailed = 0;
    if (encreUserIds.length) {
      await markWeeklyCardsSnapshotStaleMany(encreUserIds);
      staleCount = encreUserIds.length;
      const rc = await recomputeWeeklyCardsSnapshotsForUsers(encreUserIds);
      recomputeCount = rc.recomputed;
      recomputeFailed = rc.failed;
    }

    console.log(
      JSON.stringify(
        {
          mode: "execute-v2",
          file: fileName,
          organization: { slug: organization, lineCodeToken: orgToken },
          linesInserted,
          targetsInserted,
          dupAutoConfirmed,
          snapshotInvalidated: staleCount,
          snapshotRecomputed: recomputeCount,
          snapshotRecomputeFailed: recomputeFailed,
          errors: execErrors.length,
          errorSample: execErrors.slice(0, 10),
          rollbackFile: rollbackPath,
          plannedTotals: out.totals,
          plannedTargets: { targetsToCreate, dupAutoConfirmed, dupHeld: dupHeldList.length },
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
