import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@supabase/supabase-js";
import { resolvePeriodLabelFromWeek } from "@/lib/cluster4PeriodLabel";

type Mode = "weekly" | "recurring_weekly";

type SheetSpec = {
  sheetName: string;
  activityTypeId: "wisdom" | "essay" | "forum" | "infodesk" | "calendar";
  mode: Mode;
};

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

type ImportCandidate = {
  activityTypeId: string;
  sheetName: string;
  mode: Mode;
  rowNumber: number;
  periodLabel: string | null;
  startDate: string;
  endDate: string;
  weekId: string;
  weekLabel: string;
  mainTitle: string;
  // org SoT = line_code 토큰(OK/EC/PX). common(또는 org 미지정) = null → 전체 공통 노출.
  // parseLineCodeOrg(BS>EC>OK>PX) · resolveCluster4LineOrgScope 와 동일 정책 단일 출처.
  lineCode: string | null;
  outputLinks: OutputLink[];
  sourceType: "excel_import";
  recognitionMode: "legacy_allowed";
  isReadonly: false;
  isRecurringContent: boolean;
  recurringSourceSheetName: string | null;
};

// 조직 → line_code org 토큰. common/미지정 = null(line_code 미기입 → 'common' 노출).
//   parseLineCodeOrg(lib/cluster4LineOrg.ts) 가 대문자 토큰을 contains 로 검사하므로
//   토큰은 반드시 대문자, 나머지 구성요소(activityTypeId 등)는 소문자만 사용해 오탐을 막는다.
const ORG_LINE_CODE_TOKEN: Record<string, string | null> = {
  oranke: "OK",
  encre: "EC",
  phalanx: "PX",
  common: null,
};

function isKnownOrg(value: string): boolean {
  return value in ORG_LINE_CODE_TOKEN;
}

// week 기준 안정적 식별자(YYYYwWW, 없으면 weekId 앞 8자) — 동일 (org·activity·week) 재실행 시 동일 코드.
function weekRefForLineCode(week: WeekRow): string {
  if (week.iso_year && week.iso_week) {
    return `${week.iso_year}w${String(week.iso_week).padStart(2, "0")}`;
  }
  return week.id.slice(0, 8);
}

// org 전용 info 라인 코드. 토큰 없으면(common) null → 기존 공통 동작 그대로(하위호환).
//   형식: info-{TOKEN}-{activityTypeId}-{weekRef}  (TOKEN 만 대문자)
function buildInfoLineCode(
  orgToken: string | null,
  activityTypeId: string,
  week: WeekRow,
): string | null {
  if (!orgToken) return null;
  return `info-${orgToken}-${activityTypeId}-${weekRefForLineCode(week)}`;
}

type OutputLink = {
  label: string | null;
  url: string;
};

type Failure = {
  sheetName: string;
  activityTypeId: string;
  rowNumber: number | null;
  periodLabel?: string;
  startDate?: string | null;
  endDate?: string | null;
  mainTitle?: string | null;
  reason: string;
};

type Duplicate = {
  sheetName: string;
  activityTypeId: string;
  rowNumber: number;
  weekId: string;
  weekLabel: string;
  startDate: string;
  mainTitle: string;
  existingLineId: string;
  action: "upsert_update";
};

type ImportActionResult = {
  row: ImportCandidate;
  lineId: string | null;
  action: "inserted" | "updated" | "skipped" | "failed";
  error?: string;
};

type SheetData = {
  name: string;
  rows: Record<number, string>[];
};

// sheetName = 정규(base) 이름. 실제 시트는 공백/("수정") 변형이 있어 normalizeSheetName 으로 매칭한다.
//   260326 본(위즈덤 (수정)) · 260521 본(위즈덤 , 공백) 둘 다 같은 base 로 매칭된다.
const SHEETS: SheetSpec[] = [
  { sheetName: "위즈덤", activityTypeId: "wisdom", mode: "weekly" },
  { sheetName: "에세이", activityTypeId: "essay", mode: "weekly" },
  { sheetName: "포럼", activityTypeId: "forum", mode: "weekly" },
  { sheetName: "인포데스크", activityTypeId: "infodesk", mode: "recurring_weekly" },
  { sheetName: "캘린더", activityTypeId: "calendar", mode: "recurring_weekly" },
];

// 시트명 정규화: 공백 제거 + "(수정)"/"수정" 접미 제거 → "위즈덤 "·"위즈덤 (수정)" 모두 "위즈덤".
function normalizeSheetName(name: string): string {
  return name.replace(/\(?\s*수정\s*\)?/g, "").replace(/\s+/g, "");
}

// spec 에 맞는 실제 시트 찾기. 동일 base 가 여러 개면 "수정"본 우선(260326 호환), 없으면 첫 번째.
function findSheetForSpec(allSheets: SheetData[], baseName: string): SheetData | null {
  const target = normalizeSheetName(baseName);
  const matches = allSheets.filter((s) => normalizeSheetName(s.name) === target);
  if (matches.length === 0) return null;
  return matches.find((s) => /수정/.test(s.name)) ?? matches[0];
}

const WEEKLY_ACTIVITY_TYPES = new Set(["wisdom", "essay", "forum"]);
const DAY_MS = 86_400_000;

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run with --env-file=.env.local if needed.`);
  }
  return value;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

function textOf(xml: string, tagName: string): string {
  const matches = [...xml.matchAll(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "g"))];
  return matches.map((m) => m[1].replace(/<[^>]+>/g, "")).join("");
}

function columnIndex(cellRef: string): number {
  const letters = cellRef.replace(/[0-9]/g, "").toUpperCase();
  let value = 0;
  for (const ch of letters) {
    value = value * 26 + (ch.charCodeAt(0) - 64);
  }
  return value - 1;
}

function extractXlsx(filePath: string): string {
  const outDir = join(tmpdir(), `vraxium-info-lines-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(outDir, { recursive: true });
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = $env:VRAXIUM_XLSX_ZIP_PATH",
    "$dest = $env:VRAXIUM_XLSX_DEST_PATH",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)",
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        VRAXIUM_XLSX_ZIP_PATH: filePath,
        VRAXIUM_XLSX_DEST_PATH: outDir,
      },
    },
  );
  return outDir;
}

function readXml(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function parseSharedStrings(root: string): string[] {
  const path = join(root, "xl", "sharedStrings.xml");
  if (!existsSync(path)) return [];
  const xml = readFileSync(path, "utf8");
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) {
    const raw = match[1];
    const text = textOf(raw, "t").replace(/\s+/g, " ").trim();
    strings.push(decodeXml(text));
  }
  return strings;
}

function parseSheets(root: string): SheetData[] {
  const workbook = readXml(root, "xl/workbook.xml");
  const rels = readXml(root, "xl/_rels/workbook.xml.rels");
  const sharedStrings = parseSharedStrings(root);

  const relTargetById = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target) relTargetById.set(id, target);
  }

  const sheets: SheetData[] = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = match[0];
    const name = attr(tag, "name");
    const relId = attr(tag, "r:id");
    if (!name || !relId) continue;
    const target = relTargetById.get(relId);
    if (!target) continue;
    const sheetPath = target.startsWith("/")
      ? target.slice(1)
      : join("xl", target).replace(/\\/g, "/");
    const xml = readXml(root, sheetPath);
    sheets.push({ name, rows: parseSheetRows(xml, sharedStrings) });
  }
  return sheets;
}

function parseSheetRows(xml: string, sharedStrings: string[]): Record<number, string>[] {
  const rows: Record<number, string>[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowXml = rowMatch[1];
    const row: Record<number, string> = {};
    for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const cellAttrs = cellMatch[1];
      const cellXml = cellMatch[2];
      const ref = attr(`<c ${cellAttrs}>`, "r");
      if (!ref) continue;
      const type = attr(`<c ${cellAttrs}>`, "t");
      const value = textOf(cellXml, "v");
      let cellText = value;
      if (type === "s" && value !== "") {
        cellText = sharedStrings[Number(value)] ?? "";
      } else if (type === "inlineStr") {
        cellText = textOf(cellXml, "t");
      }
      row[columnIndex(ref)] = decodeXml(cellText).replace(/\s+/g, " ").trim();
    }
    rows.push(row);
  }
  return rows;
}

function excelSerialToIso(value: number): string {
  const base = Date.UTC(1899, 11, 30);
  return new Date(base + value * DAY_MS).toISOString().slice(0, 10);
}

function parseDate(value: string | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 20000 && asNumber < 80000) {
    return excelSerialToIso(Math.floor(asNumber));
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const ms = Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  );
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

function findColumn(headers: Record<number, string>, pattern: RegExp): number | null {
  for (const [index, label] of Object.entries(headers)) {
    if (pattern.test(label)) return Number(index);
  }
  return null;
}

function isBlankRow(row: Record<number, string>): boolean {
  return Object.values(row).every((value) => !String(value ?? "").trim());
}

function isRestOrEmptyTitle(title: string): boolean {
  return /휴식|없음/.test(title);
}

function parseOutputLinks(raw: string): OutputLink[] {
  const text = raw.trim();
  if (!text || text === "(아웃풋 링크 없음)") return [];
  const urlRegex = /https?:\/\/[^\s\[]+/g;
  const matches = [...text.matchAll(urlRegex)];
  const links: OutputLink[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const url = match[0].replace(/[),.;]+$/g, "");
    const labelStart = i === 0 ? 0 : (matches[i - 1].index ?? 0) + matches[i - 1][0].length;
    const label = text.slice(labelStart, match.index).replace(/[:：\s]+$/g, "").trim();
    links.push({ label: label || null, url });
  }
  return links;
}

// 운영 요구: 이 import 로 들어오는 아웃풋 링크 label 은 모두 "카페 공표글 링크" 로 통일한다.
//   (xlsx 셀에는 URL 만 있고 label 이 비어 있음 → 강제로 부여)
const CAFE_OUTPUT_LINK_LABEL = "카페 공표글 링크";

// parseOutputLinks 결과의 label 을 일괄 "카페 공표글 링크" 로 덮어쓴다.
function withCafeLabel(links: OutputLink[]): OutputLink[] {
  return links.map((l) => ({ url: l.url, label: CAFE_OUTPUT_LINK_LABEL }));
}

function urlSetKey(links: Array<{ url: string }>): string {
  return links.map((l) => l.url).sort().join(" ");
}

function allLabelsAreCafe(links: Array<{ label: string | null }>): boolean {
  return links.length > 0 && links.every((l) => (l.label ?? "") === CAFE_OUTPUT_LINK_LABEL);
}

// 기존 행의 현재 아웃풋 링크 정규화. output_links(jsonb) 우선, 없으면 output_link_1/2 컬럼.
function existingOutputLinks(row: {
  output_links: OutputLink[] | null;
  output_link_1: string | null;
  output_link_2: string | null;
}): OutputLink[] {
  if (Array.isArray(row.output_links) && row.output_links.length > 0) {
    return row.output_links
      .filter((l) => l && typeof l.url === "string" && l.url)
      .map((l) => ({ url: l.url, label: l.label ?? null }));
  }
  const out: OutputLink[] = [];
  if (row.output_link_1) out.push({ url: row.output_link_1, label: null });
  if (row.output_link_2) out.push({ url: row.output_link_2, label: null });
  return out;
}

function weekLabel(week: WeekRow): string {
  if (week.iso_year && week.iso_week) {
    return `${week.iso_year}-W${String(week.iso_week).padStart(2, "0")}`;
  }
  return `${week.start_date}~${week.end_date}`;
}

// period_label SoT: Excel 셀(직접 입력)이나 ISO weekLabel 을 신뢰하지 않고, 항상 week 행의
// iso_year(YY) + season_key(시즌명) + week_number(N) 에서 "{YY} {시즌명} {N}주차" 로 생성한다.
// ⛔ start_date 계산 금지. 세 값 중 하나라도 없으면 null(period_label 미기입).
function periodLabelForWeek(week: WeekRow): string | null {
  return resolvePeriodLabelFromWeek({
    isoYear: week.iso_year,
    seasonKey: week.season_key,
    weekNumber: week.week_number,
  });
}

function findWeekByStartDate(weeks: WeekRow[], startDate: string): WeekRow | null {
  return weeks.find((week) => week.start_date === startDate) ?? null;
}

function findWeekByDateRange(weeks: WeekRow[], startDate: string, endDate: string): WeekRow | null {
  return weeks.find((week) => week.start_date === startDate && week.end_date === endDate) ?? null;
}

function buildSheetRows(sheet: SheetData): Array<{ rowNumber: number; values: Record<number, string> }> {
  return sheet.rows
    .map((row, index) => ({ rowNumber: index + 1, values: row }))
    .filter((entry) => entry.rowNumber > 1 && !isBlankRow(entry.values));
}

// upsert 키: line_code(org) + week_id + activity_type_id + main_title.
//   org 전용 라인(line_code=info-OK-…)은 공통 라인(line_code=NULL)과 키가 달라 서로 매칭되지 않는다
//   → org 별 독립 upsert. NULL/"" 정규화로 공통 라인 재실행 시 기존 동작(하위호환) 유지.
function existingKey(row: Pick<ImportCandidate, "activityTypeId" | "weekId" | "mainTitle" | "lineCode">): string {
  return `${row.lineCode ?? ""} ${row.activityTypeId}\u0000${row.weekId}\u0000${row.mainTitle}`;
}

async function main() {
  const file = argValue("--file");
  if (!file) throw new Error("--file is required");
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const execute = hasArg("--execute");

  // 조직 스코프. 미지정 = common(line_code 미기입, 기존 동작). 지정 시 line_code org 토큰을 부여한다.
  const organization = (argValue("--organization") ?? "common").trim();
  if (!isKnownOrg(organization)) {
    throw new Error(
      `--organization must be one of: ${Object.keys(ORG_LINE_CODE_TOKEN).join(", ")}`,
    );
  }
  const orgToken = ORG_LINE_CODE_TOKEN[organization];

  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const { data: weeksData, error: weeksError } = await supabase
    .from("weeks")
    .select("id,start_date,end_date,iso_year,iso_week,week_number,season_key,is_official_rest")
    .order("start_date", { ascending: true });
  if (weeksError) throw new Error(`weeks query failed: ${weeksError.message}`);
  const weeks = (weeksData ?? []) as WeekRow[];

  const tempDir = extractXlsx(file);
  try {
    const allSheets = parseSheets(tempDir);

    // --inspect: 시트명/헤더(첫 2행)만 덤프하고 종료(읽기 전용 진단). 스펙 매핑 검증용.
    if (hasArg("--inspect")) {
      console.log(
        JSON.stringify(
          {
            mode: "inspect",
            file: basename(file),
            sheets: allSheets.map((s) => ({
              name: JSON.stringify(s.name), // 앞뒤 공백 확인용
              rowCount: s.rows.length,
              firstRows: s.rows.slice(0, 5),
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    const failures: Failure[] = [];
    const weeklyCandidates: ImportCandidate[] = [];
    const weeklyParsedRanges: Array<{ startDate: string; endDate: string }> = [];
    const recurringTemplateRows: Array<{
      spec: SheetSpec;
      rowNumber: number;
      mainTitle: string;
      outputLinks: OutputLink[];
    }> = [];

    for (const spec of SHEETS) {
      const sheet = findSheetForSpec(allSheets, spec.sheetName);
      if (!sheet) {
        failures.push({
          sheetName: spec.sheetName,
          activityTypeId: spec.activityTypeId,
          rowNumber: null,
          reason: "required sheet not found",
        });
        continue;
      }

      const headers = sheet.rows[0] ?? {};
      const periodCol = findColumn(headers, /주차|기간|날짜/i);
      const startCol = findColumn(headers, /시작일/i);
      const titleCol = findColumn(headers, /Main Title|메인/i);
      // Output/아웃풋 컬럼은 선택. "메인타이틀 전달" 본(260521)처럼 없으면 outputLinks=[].
      const linkCol = findColumn(headers, /Output|아웃풋/i);

      if (periodCol === null || titleCol === null) {
        failures.push({
          sheetName: spec.sheetName,
          activityTypeId: spec.activityTypeId,
          rowNumber: 1,
          reason: "required columns not found (주차/Main Title)",
        });
        continue;
      }

      for (const entry of buildSheetRows(sheet)) {
        const periodLabel = entry.values[periodCol] ?? "";
        const mainTitle = (entry.values[titleCol] ?? "").trim();
        const outputLinks =
          linkCol === null ? [] : withCafeLabel(parseOutputLinks(entry.values[linkCol] ?? ""));

        if (!mainTitle) {
          failures.push({
            sheetName: spec.sheetName,
            activityTypeId: spec.activityTypeId,
            rowNumber: entry.rowNumber,
            periodLabel,
            mainTitle,
            reason: "main_title is empty",
          });
          continue;
        }
        if (isRestOrEmptyTitle(mainTitle)) {
          failures.push({
            sheetName: spec.sheetName,
            activityTypeId: spec.activityTypeId,
            rowNumber: entry.rowNumber,
            periodLabel,
            mainTitle,
            reason: "휴식/없음 row는 import 제외",
          });
          continue;
        }

        if (spec.mode === "recurring_weekly") {
          // 반복 템플릿은 반드시 주차 마커(예: "매주 동일")가 있어야 한다. 주차 칸이 비었거나
          // "참고:" 로 시작하는 행은 사람이 단 주석(노트)이므로 템플릿에서 제외한다(오인 import 방지).
          if (!periodLabel.trim() || /^참고[:：]/.test(mainTitle)) {
            failures.push({
              sheetName: spec.sheetName,
              activityTypeId: spec.activityTypeId,
              rowNumber: entry.rowNumber,
              periodLabel,
              mainTitle,
              reason: "주석/노트 row는 템플릿에서 제외",
            });
            continue;
          }
          recurringTemplateRows.push({
            spec,
            rowNumber: entry.rowNumber,
            mainTitle,
            outputLinks,
          });
          continue;
        }

        const startDate = startCol === null ? null : parseDate(entry.values[startCol]);
        if (!startDate) {
          failures.push({
            sheetName: spec.sheetName,
            activityTypeId: spec.activityTypeId,
            rowNumber: entry.rowNumber,
            periodLabel,
            startDate,
            mainTitle,
            reason: "start_date parse failed",
          });
          continue;
        }

        const endDate = addDays(startDate, 6);
        weeklyParsedRanges.push({ startDate, endDate });
        const week = findWeekByStartDate(weeks, startDate);
        if (!week) {
          failures.push({
            sheetName: spec.sheetName,
            activityTypeId: spec.activityTypeId,
            rowNumber: entry.rowNumber,
            periodLabel,
            startDate,
            endDate,
            mainTitle,
            reason: "weeks row 매칭 실패",
          });
          continue;
        }

        weeklyCandidates.push({
          activityTypeId: spec.activityTypeId,
          sheetName: spec.sheetName,
          mode: spec.mode,
          rowNumber: entry.rowNumber,
          // 직접 입력값(Excel 셀)을 신뢰하지 않고 week 기준 정규 표기로 생성한다.
          periodLabel: periodLabelForWeek(week),
          startDate: week.start_date,
          endDate: week.end_date,
          weekId: week.id,
          weekLabel: weekLabel(week),
          mainTitle,
          lineCode: buildInfoLineCode(orgToken, spec.activityTypeId, week),
          outputLinks,
          sourceType: "excel_import",
          recognitionMode: "legacy_allowed",
          isReadonly: false,
          isRecurringContent: false,
          recurringSourceSheetName: null,
        });
      }
    }

    const weeklyDates = weeklyParsedRanges.map((row) => row.startDate).sort();
    const minStartDate = weeklyDates[0] ?? null;
    const maxEndDate = weeklyParsedRanges.map((row) => row.endDate).sort().at(-1) ?? null;
    const recurringWeeks =
      minStartDate && maxEndDate
        ? weeks.filter((week) => week.start_date >= minStartDate && week.end_date <= maxEndDate)
        : [];

    const recurringCandidates: ImportCandidate[] = [];
    for (const template of recurringTemplateRows) {
      for (const week of recurringWeeks) {
        recurringCandidates.push({
          activityTypeId: template.spec.activityTypeId,
          sheetName: template.spec.sheetName,
          mode: template.spec.mode,
          rowNumber: template.rowNumber,
          // 반복 콘텐츠도 동일하게 week 기준 정규 표기(구: ISO weekLabel)로 생성한다.
          periodLabel: periodLabelForWeek(week),
          startDate: week.start_date,
          endDate: week.end_date,
          weekId: week.id,
          weekLabel: weekLabel(week),
          mainTitle: template.mainTitle,
          lineCode: buildInfoLineCode(orgToken, template.spec.activityTypeId, week),
          outputLinks: template.outputLinks,
          sourceType: "excel_import",
          recognitionMode: "legacy_allowed",
          isReadonly: false,
          isRecurringContent: true,
          recurringSourceSheetName: template.spec.sheetName,
        });
      }
    }

    const candidates = [...weeklyCandidates, ...recurringCandidates];
    const activityTypeIds = Array.from(new Set(candidates.map((row) => row.activityTypeId)));
    const weekIds = Array.from(new Set(candidates.map((row) => row.weekId)));

    // ─────────────────────────────────────────────────────────────────────
    // CONVERT-MODE (--convert): common 으로 잘못 저장된 org 라인을 OK 코드로 정정한다.
    //   slot = (week_id, activity_type_id). 동작(삭제 없음):
    //     1) slot 의 기존 common(line_code=NULL) 행 → line_code = info-OK-… 로 CONVERT.
    //     2) 후보와 제목 정합: 정확히 같은 제목 = SKIP / 남은 후보를 남은 행에 매칭 = TITLE UPDATE / 그래도 없으면 INSERT.
    //     3) 후보와 매칭 안 된 변환행(예: 폐기된 반복 개정본) = leftover(제목 보존, 그대로 둠).
    //   dry-run 기본. --execute 시에만 UPDATE/INSERT 수행.
    // ─────────────────────────────────────────────────────────────────────
    if (hasArg("--convert")) {
      if (!orgToken) {
        throw new Error("--convert 는 --organization (oranke/encre/phalanx) 필요 (common 불가)");
      }
      await runConvertMode({
        supabase,
        organization,
        orgToken,
        candidates,
        activityTypeIds,
        weekIds,
        fileName: basename(file),
        execute,
        excludeNullSource: hasArg("--exclude-null-source"),
        deactivateLeftover: hasArg("--deactivate-leftover"),
        // 기본: 비어 있는 행에만 아웃풋 링크 추가 + URL 동일 행 label 만 정정(비파괴).
        //   --overwrite-output-links: URL 이 다른 기존 행(예: youtube 포함 멀티링크)도 xlsx 값으로 덮어씀.
        overwriteOutputLinks: hasArg("--overwrite-output-links"),
      });
      return;
    }

    const { data: existingData, error: existingError } =
      activityTypeIds.length > 0 && weekIds.length > 0
        ? await supabase
            .from("cluster4_lines")
            .select("id,activity_type_id,week_id,main_title,line_code")
            .eq("part_type", "info")
            .eq("source_type", "excel_import")
            .in("activity_type_id", activityTypeIds)
            .in("week_id", weekIds)
        : { data: [], error: null };
    const schemaWarnings: string[] = [];
    if (existingError && existingError.code === "42703") {
      schemaWarnings.push(
        "cluster4_lines import metadata columns are not applied yet; duplicate/upsert detection was skipped.",
      );
    } else if (existingError) {
      throw new Error(`existing import line query failed: ${existingError.message}`);
    }

    const existingByKey = new Map<string, { id: string }>();
    for (const row of (!existingError ? existingData ?? [] : []) as Array<{
      id: string;
      activity_type_id: string;
      week_id: string;
      main_title: string;
      line_code: string | null;
    }>) {
      existingByKey.set(
        `${row.line_code ?? ""} ${row.activity_type_id}\u0000${row.week_id}\u0000${row.main_title}`,
        { id: row.id },
      );
    }

    // ── 공존 진단: 같은 (주차·활동유형)에 line_code 가 다른(특히 common=NULL) 기존 라인이 있는지.
    // 신규 oranke 라인을 INSERT 하면 oranke 고객은 (oranke 신규 + 기존 common) 둘 다 보게 되어
    // 분모A 가 이중계상될 수 있다. 이 목록이 비어있지 않으면 "신규 INSERT vs 기존 전환" 결정이 필요.
    const existingByWeekActivity = new Map<
      string,
      Array<{ id: string; lineCode: string | null; mainTitle: string }>
    >();
    for (const row of (!existingError ? existingData ?? [] : []) as Array<{
      id: string;
      activity_type_id: string;
      week_id: string;
      main_title: string;
      line_code: string | null;
    }>) {
      const waKey = `${row.week_id}::${row.activity_type_id}`;
      const arr = existingByWeekActivity.get(waKey) ?? [];
      arr.push({ id: row.id, lineCode: row.line_code ?? null, mainTitle: row.main_title });
      existingByWeekActivity.set(waKey, arr);
    }
    const coexistenceConflicts: Array<{
      weekId: string;
      weekLabel: string;
      activityTypeId: string;
      newLineCode: string | null;
      newMainTitle: string;
      existingCommonOrOtherOrg: Array<{ id: string; lineCode: string | null; mainTitle: string }>;
    }> = [];
    const seenWa = new Set<string>();
    for (const cand of candidates) {
      if (!cand.lineCode) continue; // common 입력은 공존 진단 대상 아님
      const waKey = `${cand.weekId}::${cand.activityTypeId}`;
      if (seenWa.has(waKey)) continue;
      seenWa.add(waKey);
      const conflicting = (existingByWeekActivity.get(waKey) ?? []).filter(
        (r) => (r.lineCode ?? null) !== cand.lineCode,
      );
      if (conflicting.length > 0) {
        coexistenceConflicts.push({
          weekId: cand.weekId,
          weekLabel: cand.weekLabel,
          activityTypeId: cand.activityTypeId,
          newLineCode: cand.lineCode,
          newMainTitle: cand.mainTitle,
          existingCommonOrOtherOrg: conflicting,
        });
      }
    }

    const duplicates: Duplicate[] = [];
    for (const row of candidates) {
      const existing = existingByKey.get(existingKey(row));
      if (!existing) continue;
      duplicates.push({
        sheetName: row.sheetName,
        activityTypeId: row.activityTypeId,
        rowNumber: row.rowNumber,
        weekId: row.weekId,
        weekLabel: row.weekLabel,
        startDate: row.startDate,
        mainTitle: row.mainTitle,
        existingLineId: existing.id,
        action: "upsert_update",
      });
    }

    const importableRows = candidates.length;
    const byActivityType = SHEETS.map((spec) => {
      const rows = candidates.filter((row) => row.activityTypeId === spec.activityTypeId);
      const specFailures = failures.filter((row) => row.activityTypeId === spec.activityTypeId);
      const specDuplicates = duplicates.filter((row) => row.activityTypeId === spec.activityTypeId);
      return {
        activityTypeId: spec.activityTypeId,
        sheetName: spec.sheetName,
        mode: spec.mode,
        importableRows: rows.length,
        recurringGeneratedRows: rows.filter((row) => row.isRecurringContent).length,
        duplicateRows: specDuplicates.length,
        failedRows: specFailures.length,
      };
    });

    const insertPlanned = candidates.filter(
      (row) => !existingByKey.has(existingKey(row)),
    ).length;
    const dryRunOutput = {
      mode: "dry-run",
      file: basename(file),
      organization: {
        slug: organization,
        lineCodeToken: orgToken,
        scope:
          orgToken == null
            ? "common (line_code 미기입 → 전체 조직 공통 노출)"
            : `${organization} 전용 (line_code 토큰 '${orgToken}')`,
      },
      expectedActions: {
        insert: insertPlanned,
        updateOrUpsert: duplicates.length,
        skip: 0,
        note: "upsert 키 = line_code(org) + week_id + activity_type_id + main_title. 매칭 시 update, 없으면 insert.",
      },
      sampleLineCodes: Array.from(
        new Set(candidates.map((row) => row.lineCode ?? "(null=common)")),
      ).slice(0, 10),
      // 분모A 이중계상 위험 진단: 같은 (주차·활동유형)에 line_code 다른 기존 라인 공존 여부.
      coexistence: {
        conflictCount: coexistenceConflicts.length,
        risk:
          coexistenceConflicts.length > 0
            ? "신규 oranke INSERT 시 기존 common/타org 라인과 공존 → oranke 고객 이중 노출·분모A 이중계상 위험. execute 전 '신규 INSERT vs 기존 전환' 결정 필요."
            : "같은 주차·활동유형에 다른 line_code 기존 라인 없음 — 이중계상 위험 없음.",
        conflicts: coexistenceConflicts.slice(0, 500),
      },
      targetCreation: {
        enabled: false,
        targetRowsToCreate: 0,
        reason: "Excel에는 사용자 식별 정보가 없으므로 cluster4_line_targets를 생성하지 않음",
      },
      selectedSheets: SHEETS,
      schemaWarnings,
      recurringWeekRange: {
        source: "weekly sheets minimum start_date through maximum end_date",
        minStartDate,
        maxEndDate,
        matchedWeeks: recurringWeeks.length,
      },
      summary: {
        totalImportPlannedRows: importableRows,
        weeklyImportPlannedRows: weeklyCandidates.length,
        recurringImportPlannedRows: recurringCandidates.length,
        recurringTemplateRows: recurringTemplateRows.length,
        duplicateOrUpsertRows: duplicates.length,
        failedRows: failures.length,
      },
      byActivityType,
      weekMatchFailures: failures.filter((row) => row.reason === "weeks row 매칭 실패"),
      restExcludedRows: failures.filter((row) => row.reason === "휴식/없음 row는 import 제외"),
      failures,
      duplicates,
      sampleImportRows: candidates.slice(0, 10),
    };

    if (!execute) {
      console.log(JSON.stringify(dryRunOutput, null, 2));
      return;
    }

    const results = await executeImportRows({
      supabase,
      rows: candidates,
      existingByKey,
      fileName: basename(file),
    });
    const inserted = results.filter((row) => row.action === "inserted");
    const updated = results.filter((row) => row.action === "updated");
    const skipped = results.filter((row) => row.action === "skipped");
    const failed = results.filter((row) => row.action === "failed");

    const executeByActivityType = SHEETS.map((spec) => {
      const rows = results.filter((row) => row.row.activityTypeId === spec.activityTypeId);
      return {
        activityTypeId: spec.activityTypeId,
        sheetName: spec.sheetName,
        mode: spec.mode,
        insertedRows: rows.filter((row) => row.action === "inserted").length,
        updatedRows: rows.filter((row) => row.action === "updated").length,
        skippedRows: rows.filter((row) => row.action === "skipped").length,
        failedRows: rows.filter((row) => row.action === "failed").length,
      };
    });

    const executeOutput = {
      mode: "execute",
      file: basename(file),
      targetCreation: dryRunOutput.targetCreation,
      dryRunSummary: dryRunOutput.summary,
      insertedRows: inserted.length,
      updatedRows: updated.length,
      skippedRows: skipped.length,
      failedRows: failed.length,
      byActivityType: executeByActivityType,
      sampleInsertedRows: inserted.slice(0, 10).map((result) => ({
        lineId: result.lineId,
        activityTypeId: result.row.activityTypeId,
        sheetName: result.row.sheetName,
        weekId: result.row.weekId,
        weekLabel: result.row.weekLabel,
        mainTitle: result.row.mainTitle,
      })),
      failures: failed.map((result) => ({
        activityTypeId: result.row.activityTypeId,
        sheetName: result.row.sheetName,
        rowNumber: result.row.rowNumber,
        weekId: result.row.weekId,
        mainTitle: result.row.mainTitle,
        error: result.error ?? "unknown error",
      })),
    };

    console.log(JSON.stringify(executeOutput, null, 2));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CONVERT-MODE 구현. slot = (week_id, activity_type_id). 삭제 없음.
//   적격(eligible) 기존행 = source_type='excel_import'(--exclude-null-source 시 source_type=NULL 제외).
//   동작: common(NULL)→OK CONVERT, 후보 제목 정합(skip/title-update), 미존재 slot은 INSERT,
//        후보와 매칭 안 된 적격 행(폐기 반복 개정본) = --deactivate-leftover 면 is_active=false, 아니면 보존.
//        NULL-source 행은 untouched + 그 slot 의 후보 INSERT 는 이중노출 방지로 SKIP.
//   dry-run 기본 · --execute 시에만 write.
// ─────────────────────────────────────────────────────────────────────────
async function runConvertMode(opts: {
  supabase: any;
  organization: string;
  orgToken: string;
  candidates: ImportCandidate[];
  activityTypeIds: string[];
  weekIds: string[];
  fileName: string;
  execute: boolean;
  excludeNullSource: boolean;
  deactivateLeftover: boolean;
  overwriteOutputLinks: boolean;
}) {
  const {
    supabase, organization, orgToken, candidates, activityTypeIds, weekIds, fileName, execute,
    excludeNullSource, deactivateLeftover, overwriteOutputLinks,
  } = opts;

  const slotKey = (weekId: string, activityTypeId: string) => `${weekId}::${activityTypeId}`;
  const candBySlot = new Map<string, ImportCandidate[]>();
  for (const c of candidates) {
    const k = slotKey(c.weekId, c.activityTypeId);
    const arr = candBySlot.get(k) ?? [];
    arr.push(c);
    candBySlot.set(k, arr);
  }

  // 기존 활성 info 라인 — 후보 (week×activity) 교집합 전부.
  type ExRow = {
    id: string;
    week_id: string | null;
    activity_type_id: string | null;
    line_code: string | null;
    main_title: string | null;
    source_type: string | null;
    is_active: boolean | null;
    output_links: OutputLink[] | null;
    output_link_1: string | null;
    output_link_2: string | null;
  };
  const existing: ExRow[] = [];
  for (let i = 0; i < weekIds.length; i += 100) {
    const wslice = weekIds.slice(i, i + 100);
    const { data, error } = await supabase
      .from("cluster4_lines")
      .select("id,week_id,activity_type_id,line_code,main_title,source_type,is_active,output_links,output_link_1,output_link_2")
      .eq("part_type", "info")
      .eq("is_active", true)
      .in("week_id", wslice)
      .in("activity_type_id", activityTypeIds);
    if (error) throw new Error(`convert existing query failed: ${error.message}`);
    existing.push(...((data ?? []) as ExRow[]));
  }

  // 적격/제외 분리. 제외 = (excludeNullSource && source_type==null).
  const isExcluded = (r: ExRow) => excludeNullSource && r.source_type == null;
  const exBySlot = new Map<string, ExRow[]>(); // 적격만
  const excludedBySlot = new Map<string, ExRow[]>(); // 제외(NULL-source)
  const excludedRows: ExRow[] = [];
  for (const r of existing) {
    if (!r.week_id || !r.activity_type_id) continue;
    const k = slotKey(r.week_id, r.activity_type_id);
    if (!candBySlot.has(k)) continue; // 후보 slot 만 대상
    if (isExcluded(r)) {
      const arr = excludedBySlot.get(k) ?? [];
      arr.push(r);
      excludedBySlot.set(k, arr);
      excludedRows.push(r);
      continue;
    }
    const arr = exBySlot.get(k) ?? [];
    arr.push(r);
    exBySlot.set(k, arr);
  }

  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

  type Role =
    | "matched_skip"
    | "title_update"
    | "deactivate"
    | "leftover_kept"
    | "other_org_left";
  // 아웃풋 링크 액션 분류(유지되는 claimed 행에만 적용):
  //   none           = xlsx 링크 없음(반복 시트) 또는 이미 동일(URL+label 일치) → 무변경
  //   add            = 기존 행에 링크 없음 + xlsx 링크 있음 → 추가(비파괴)
  //   label_only     = URL 동일 + label 만 다름("…진행장소"→"카페 공표글 링크") → label 정정(비파괴)
  //   conflict_skip  = 기존 링크 URL 이 xlsx 와 다름(예: youtube 포함 멀티링크) + overwrite 미지정 → 보존(쓰기 안 함)
  //   conflict_apply = URL 다름 + --overwrite-output-links → xlsx 값으로 덮어씀(파괴적)
  type LinkAction = "none" | "add" | "label_only" | "conflict_skip" | "conflict_apply";
  type RowAction = {
    id: string;
    weekLabel: string;
    activityTypeId: string;
    lineCodeFrom: string | null;
    lineCodeTo: string;
    titleFrom: string;
    titleTo: string;
    convertLineCode: boolean; // null→OK (active 로 유지되는 행만)
    titleChanged: boolean;
    deactivate: boolean;
    role: Role;
    sourceType: string | null;
    linkAction: LinkAction;
    linkFrom: OutputLink[];
    linkTo: OutputLink[];
    applyOutputLinks: boolean; // execute 시 output_links 를 linkTo 로 쓸지
  };
  const rowActions: RowAction[] = [];
  type InsertAction = { weekLabel: string; activityTypeId: string; lineCode: string | null; mainTitle: string };
  const insertActions: InsertAction[] = [];
  type SkippedInsert = { weekLabel: string; activityTypeId: string; reason: string };
  const skippedInserts: SkippedInsert[] = [];

  for (const [k, cands] of candBySlot) {
    const okCode = cands[0].lineCode ?? null;
    const exRows = exBySlot.get(k) ?? [];
    const hasExcludedInSlot = (excludedBySlot.get(k) ?? []).length > 0;
    const plans = exRows.map((r) => {
      const isCommon = r.line_code == null;
      const isAlreadyOk = r.line_code === okCode;
      const otherOrg = !isCommon && !isAlreadyOk;
      return {
        r,
        toCode: otherOrg ? (r.line_code as string) : (okCode as string),
        otherOrg,
        claimed: false,
        claimedCand: null as ImportCandidate | null,
        titleTo: r.main_title ?? "",
        titleChanged: false,
      };
    });
    const okPool = plans.filter((p) => !p.otherOrg);

    // pass1: 정확 제목 일치 → skip.
    const deferred: ImportCandidate[] = [];
    for (const cand of cands) {
      const hit = okPool.find((p) => !p.claimed && norm(p.r.main_title) === norm(cand.mainTitle));
      if (hit) {
        hit.claimed = true;
        hit.claimedCand = cand;
        hit.titleTo = hit.r.main_title ?? cand.mainTitle;
        hit.titleChanged = false;
      } else {
        deferred.push(cand);
      }
    }
    // pass2: 남은 후보 → 남은 적격 행 제목 업데이트, 없으면 INSERT(단 NULL-source 가 slot 점유 시 SKIP).
    for (const cand of deferred) {
      const slot = okPool.find((p) => !p.claimed);
      if (slot) {
        slot.claimed = true;
        slot.claimedCand = cand;
        slot.titleTo = cand.mainTitle;
        slot.titleChanged = norm(slot.r.main_title) !== norm(cand.mainTitle);
      } else if (hasExcludedInSlot) {
        // NULL-source 행이 이미 있는 slot — 손대지 않기로 했으므로 INSERT 하면 이중노출. SKIP.
        skippedInserts.push({
          weekLabel: cand.weekLabel,
          activityTypeId: cand.activityTypeId,
          reason: "NULL-source 행 존재(제외 대상) → 이중노출 방지로 insert 생략",
        });
      } else {
        insertActions.push({
          weekLabel: cand.weekLabel,
          activityTypeId: cand.activityTypeId,
          lineCode: cand.lineCode,
          mainTitle: cand.mainTitle,
        });
      }
    }
    // 행 액션 확정.
    for (const p of plans) {
      let role: Role;
      let deactivate = false;
      let convertLineCode = false;
      if (p.otherOrg) {
        role = "other_org_left";
      } else if (p.claimed) {
        role = p.titleChanged ? "title_update" : "matched_skip";
        convertLineCode = p.r.line_code == null; // 유지되는 행만 OK 로 변환
      } else if (deactivateLeftover) {
        role = "deactivate"; // 폐기 반복 개정본 → 비활성화(변환/리타이틀 안 함)
        deactivate = true;
      } else {
        role = "leftover_kept";
        convertLineCode = p.r.line_code == null;
      }

      // 아웃풋 링크 분류 — 유지되는 claimed 행에만(비활성화/타org/leftover 제외).
      const existingLinks = existingOutputLinks(p.r);
      const candLinks = p.claimedCand?.outputLinks ?? [];
      let linkAction: LinkAction = "none";
      let applyOutputLinks = false;
      if (p.claimed && !deactivate && candLinks.length > 0) {
        if (existingLinks.length === 0) {
          linkAction = "add";
          applyOutputLinks = true;
        } else if (urlSetKey(existingLinks) === urlSetKey(candLinks)) {
          // URL 동일 — label 이 이미 전부 "카페 공표글 링크" 면 무변경, 아니면 label 정정.
          linkAction = allLabelsAreCafe(existingLinks) ? "none" : "label_only";
          applyOutputLinks = linkAction === "label_only";
        } else {
          // URL 이 다름(기존이 더 풍부할 수 있음) — 기본 보존, overwrite 플래그 때만 덮어씀.
          linkAction = overwriteOutputLinks ? "conflict_apply" : "conflict_skip";
          applyOutputLinks = overwriteOutputLinks;
        }
      }

      rowActions.push({
        id: p.r.id,
        weekLabel: cands[0].weekLabel,
        activityTypeId: p.r.activity_type_id ?? cands[0].activityTypeId,
        lineCodeFrom: p.r.line_code,
        lineCodeTo: p.toCode,
        titleFrom: p.r.main_title ?? "",
        titleTo: p.titleTo,
        convertLineCode,
        titleChanged: p.titleChanged,
        deactivate,
        role,
        sourceType: p.r.source_type,
        linkAction,
        linkFrom: existingLinks,
        linkTo: candLinks,
        applyOutputLinks,
      });
    }
  }

  // 집계.
  const convertCount = rowActions.filter((a) => a.convertLineCode).length;
  const titleUpdateCount = rowActions.filter((a) => a.titleChanged).length;
  const insertCount = insertActions.length;
  const deactivateCount = rowActions.filter((a) => a.deactivate).length;
  const leftoverCount = rowActions.filter((a) => a.role === "leftover_kept").length;
  const otherOrgLeft = rowActions.filter((a) => a.role === "other_org_left").length;
  const matchedSkip = rowActions.filter((a) => a.role === "matched_skip").length;

  // 아웃풋 링크 집계.
  const linkAdd = rowActions.filter((a) => a.linkAction === "add");
  const linkLabelOnly = rowActions.filter((a) => a.linkAction === "label_only");
  const linkConflictSkip = rowActions.filter((a) => a.linkAction === "conflict_skip");
  const linkConflictApply = rowActions.filter((a) => a.linkAction === "conflict_apply");
  // INSERT 신규 행도 xlsx 링크를 그대로 들고 들어간다(신규 추가).
  const insertWithLink = insertActions.filter((ins) => {
    const cand = candidates.find(
      (c) => c.weekLabel === ins.weekLabel && c.activityTypeId === ins.activityTypeId && c.mainTitle === ins.mainTitle,
    );
    return (cand?.outputLinks.length ?? 0) > 0;
  });
  const outputLinkNewCount = linkAdd.length + insertWithLink.length;
  const outputLinkChangeCount = linkLabelOnly.length + linkConflictApply.length;

  // slot 별 최종 oranke 가시 행 수 = 유지 적격행(claimed, 비활성화 제외) + insert + 제외 NULL행(활성, oranke 에도 노출).
  const finalCountBySlot = new Map<string, number>();
  for (const [k, cands] of candBySlot) {
    const okCode = cands[0].lineCode;
    const keptEligible = (exBySlot.get(k) ?? []).filter((r) => {
      // 비활성화 대상이면 제외.
      const willDeactivate = deactivateLeftover; // leftover 만 deactivate; claimed 는 유지
      // claimed 여부를 알기 위해 rowActions 참조.
      const act = rowActions.find((a) => a.id === r.id);
      if (act?.deactivate) return false;
      void willDeactivate;
      return r.line_code == null || r.line_code === okCode;
    }).length;
    const excludedActive = (excludedBySlot.get(k) ?? []).length; // 제외 NULL = 그대로 활성·oranke 가시
    const insertsHere = exBySlot.get(k)?.length ? 0 : (excludedBySlot.get(k)?.length ? 0 : cands.length);
    finalCountBySlot.set(k, keptEligible + excludedActive + insertsHere);
  }
  const finalDist: Record<string, number> = {};
  let slotsWithMoreThanOne = 0;
  const multiSlots: Array<{ slot: string; count: number; weekLabel: string; activityTypeId: string }> = [];
  for (const [k, n] of finalCountBySlot) {
    finalDist[String(n)] = (finalDist[String(n)] ?? 0) + 1;
    if (n > 1) {
      slotsWithMoreThanOne += 1;
      const c = candBySlot.get(k)![0];
      multiSlots.push({ slot: k, count: n, weekLabel: c.weekLabel, activityTypeId: c.activityTypeId });
    }
  }
  // 1-line 미달성(0 또는 2+)인 slot 만 보고.
  const oneLinePerSlot = slotsWithMoreThanOne === 0 && !(finalDist["0"] > 0);

  // encre/phalanx 에서 사라지는 행 = common→OK 변환 + 비활성화(전 org 제거). NULL 제외분은 그대로 남음.
  const encrePhalanxRemovedCount = convertCount + deactivateCount;

  const summary = {
    mode: execute ? "convert-execute" : "convert-dry-run",
    organization,
    orgToken,
    file: fileName,
    flags: { excludeNullSource, deactivateLeftover, overwriteOutputLinks },
    candidateSlots: candBySlot.size,
    candidates: candidates.length,
    eligibleExistingRows: rowActions.length,
    excludedNullSourceRows: excludedRows.length,
    // cluster4_line_targets(라인 개설 대상 크루)는 이 모드에서 절대 건드리지 않는다(읽지도/쓰지도 않음).
    targetWrites: {
      cluster4_line_targets: 0,
      note: "convert 모드는 cluster4_lines 만 UPDATE/INSERT. 대상 크루(line_targets) read/write 없음 → 0건.",
    },
    actions: {
      convertCommonToOk: convertCount,
      titleUpdate: titleUpdateCount,
      matchedSkip,
      insert: insertCount,
      deactivate: deactivateCount,
      insertSkippedNullPresent: skippedInserts.length,
      leftoverKept: leftoverCount,
      otherOrgLeftUntouched: otherOrgLeft,
      delete: 0,
    },
    // 사용자 요청 핵심 4지표.
    mainTitleAndOutputLink: {
      mainTitleChanged: titleUpdateCount,
      outputLinkNewlyAdded: outputLinkNewCount,
      outputLinkChanged: outputLinkChangeCount,
      breakdown: {
        existingRowLinkAdded: linkAdd.length,
        insertedRowWithLink: insertWithLink.length,
        labelOnlyFix: linkLabelOnly.length,
        conflictOverwritten: linkConflictApply.length,
        conflictPreservedNoWrite: linkConflictSkip.length,
      },
      label: CAFE_OUTPUT_LINK_LABEL,
      note: "outputLinkChanged = label_only(URL 동일·label 정정) + conflict_apply(--overwrite 시 URL 교체). conflict_skip(기존 멀티링크 보존)은 쓰기 0건이라 제외.",
    },
    outputLinkConflictsPreserved: linkConflictSkip.slice(0, 50).map((a) => ({
      id: a.id,
      weekLabel: a.weekLabel,
      activityTypeId: a.activityTypeId,
      existing: a.linkFrom,
      xlsx: a.linkTo,
    })),
    encrePhalanxRemoval: {
      rowsLeavingOtherOrgVisibility: encrePhalanxRemovedCount,
      breakdown: { convertedToOranke: convertCount, deactivated: deactivateCount },
      nullSourceRowsRemainingCommon: excludedRows.length,
      note: "convert(common→OK) + deactivate(전 org 제거) = encre·phalanx 에서 사라지는 행. NULL-source 제외분은 common 으로 남아 계속 노출.",
    },
    finalOrankeRowsPerSlot: {
      oneLinePerSlotAchieved: oneLinePerSlot,
      distribution: finalDist,
      slotsWithMoreThanOne,
      multiSlotSample: multiSlots.slice(0, 20),
      note: "최종 oranke 가시 행 = 유지 적격행 + insert + (제외 NULL-source 행, common 이지만 oranke 에도 노출). NULL slot 은 1 common 행으로 1개.",
    },
    excludedNullSourceList: excludedRows.map((r) => ({
      id: r.id,
      week_id: r.week_id,
      activity_type_id: r.activity_type_id,
      line_code: r.line_code,
      main_title: r.main_title,
      source_type: r.source_type,
    })),
    sampleConvert: rowActions.filter((a) => a.convertLineCode).slice(0, 50),
    sampleTitleUpdate: rowActions.filter((a) => a.titleChanged).slice(0, 20).map((a) => ({
      id: a.id, weekLabel: a.weekLabel, activityTypeId: a.activityTypeId,
      titleFrom: a.titleFrom, titleTo: a.titleTo,
    })),
    sampleLinkAdd: linkAdd.slice(0, 20).map((a) => ({
      id: a.id, weekLabel: a.weekLabel, activityTypeId: a.activityTypeId, linkTo: a.linkTo,
    })),
    sampleLinkLabelOnly: linkLabelOnly.slice(0, 20).map((a) => ({
      id: a.id, weekLabel: a.weekLabel, activityTypeId: a.activityTypeId,
      labelFrom: a.linkFrom.map((l) => l.label), labelTo: CAFE_OUTPUT_LINK_LABEL,
    })),
    sampleDeactivate: rowActions.filter((a) => a.deactivate).slice(0, 50),
    sampleInsert: insertActions.slice(0, 50),
    skippedInsertsSample: skippedInserts.slice(0, 50),
  };

  if (!execute) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // ── EXECUTE: UPDATE(line_code/main_title) + DEACTIVATE(is_active=false) + INSERT. (삭제 없음)
  // 롤백 대비: 수정 대상 행의 before-state 와 insert 된 id 를 파일로 남긴다.
  const rollbackBefore = rowActions
    .filter((a) => a.role !== "other_org_left" && a.role !== "leftover_kept")
    .map((a) => ({
      id: a.id,
      before: {
        line_code: a.lineCodeFrom,
        main_title: a.titleFrom,
        is_active: true,
        output_links: a.linkFrom,
      },
      action:
        a.deactivate
          ? "deactivate"
          : a.convertLineCode || a.titleChanged || a.applyOutputLinks
            ? "update"
            : "noop",
    }))
    .filter((r) => r.action !== "noop");
  const insertedIds: string[] = [];

  let updated = 0;
  let deactivated = 0;
  let inserted = 0;
  const execErrors: Array<{ id?: string; mainTitle?: string; error: string }> = [];
  for (const a of rowActions) {
    if (a.role === "other_org_left" || a.role === "leftover_kept") continue;
    const patch: Record<string, unknown> = {};
    if (a.deactivate) patch.is_active = false;
    else {
      if (a.convertLineCode) patch.line_code = a.lineCodeTo;
      if (a.titleChanged) patch.main_title = a.titleTo;
      if (a.applyOutputLinks) {
        const links = a.linkTo.slice(0, 2);
        patch.output_links = links;
        patch.output_link_1 = links[0]?.url ?? null;
        patch.output_link_2 = links[1]?.url ?? null;
      }
    }
    if (Object.keys(patch).length === 0) continue;
    const { error } = await supabase
      .from("cluster4_lines")
      .update(patch)
      .eq("id", a.id)
      .eq("part_type", "info");
    if (error) execErrors.push({ id: a.id, error: error.message });
    else if (a.deactivate) deactivated += 1;
    else updated += 1;
  }
  for (const ins of insertActions) {
    const cand = candidates.find(
      (c) => c.weekLabel === ins.weekLabel && c.activityTypeId === ins.activityTypeId && c.mainTitle === ins.mainTitle,
    );
    if (!cand) {
      execErrors.push({ mainTitle: ins.mainTitle, error: "candidate not found for insert" });
      continue;
    }
    const { data, error } = await supabase
      .from("cluster4_lines")
      .insert(linePayload(cand, fileName))
      .select("id")
      .single();
    if (error || !data) execErrors.push({ mainTitle: ins.mainTitle, error: error?.message ?? "insert returned no id" });
    else {
      inserted += 1;
      insertedIds.push((data as { id: string }).id);
    }
  }

  // 롤백 파일 — 수정 전 상태 + insert 된 id. (rollback: before 로 update, insertedIds 는 is_active=false 또는 삭제)
  const rollbackPath = `claudedocs/rollback-convert-${organization}-${orgToken}.json`;
  try {
    writeFileSync(
      rollbackPath,
      JSON.stringify({ organization, orgToken, file: fileName, updatesBefore: rollbackBefore, insertedIds }, null, 2),
      "utf8",
    );
  } catch (e) {
    execErrors.push({ error: `rollback write failed: ${e instanceof Error ? e.message : e}` });
  }

  console.log(
    JSON.stringify(
      {
        ...summary,
        executeResult: { updated, deactivated, inserted, errors: execErrors.length, errorSample: execErrors.slice(0, 10) },
        rollbackFile: rollbackPath,
      },
      null,
      2,
    ),
  );
}

function submissionWindowForWeek(startDate: string): {
  submission_opens_at: string;
  submission_closes_at: string;
} {
  const weekStartMs = Date.UTC(
    Number(startDate.slice(0, 4)),
    Number(startDate.slice(5, 7)) - 1,
    Number(startDate.slice(8, 10)),
  );
  const wednesdayMs = weekStartMs + 2 * DAY_MS;
  return {
    submission_opens_at: new Date(weekStartMs - 9 * 3600_000).toISOString(),
    submission_closes_at: new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString(),
  };
}

function linePayload(row: ImportCandidate, fileName: string) {
  const links = row.outputLinks.slice(0, 2);
  const window = submissionWindowForWeek(row.startDate);
  return {
    part_type: "info",
    activity_type_id: row.activityTypeId,
    main_title: row.mainTitle,
    // org SoT: line_code 토큰(OK/EC/PX). common 은 null → 'common' 노출(하위호환).
    line_code: row.lineCode,
    output_link_1: links[0]?.url ?? null,
    output_link_2: links[1]?.url ?? null,
    output_links: links,
    output_images: [],
    submission_opens_at: window.submission_opens_at,
    submission_closes_at: window.submission_closes_at,
    is_active: true,
    source_type: row.sourceType,
    recognition_mode: row.recognitionMode,
    is_readonly: row.isReadonly,
    period_label: row.periodLabel,
    start_date: row.startDate,
    end_date: row.endDate,
    week_id: row.weekId,
    source_file_name: fileName,
    source_sheet_name: row.sheetName,
    is_recurring_content: row.isRecurringContent,
    recurring_source_sheet_name: row.recurringSourceSheetName,
  };
}

async function executeImportRows({
  supabase,
  rows,
  existingByKey,
  fileName,
}: {
  supabase: any;
  rows: ImportCandidate[];
  existingByKey: Map<string, { id: string }>;
  fileName: string;
}): Promise<ImportActionResult[]> {
  const results: ImportActionResult[] = [];

  for (const row of rows) {
    const existing = existingByKey.get(existingKey(row));
    const payload = linePayload(row, fileName);

    if (existing) {
      const { data, error } = await supabase
        .from("cluster4_lines")
        .update(payload)
        .eq("id", existing.id)
        .eq("part_type", "info")
        .eq("source_type", "excel_import")
        .select("id")
        .maybeSingle();

      if (error || !data) {
        results.push({
          row,
          lineId: existing.id,
          action: "failed",
          error: error?.message ?? "existing excel_import row was not updated",
        });
        continue;
      }
      results.push({ row, lineId: data.id as string, action: "updated" });
      continue;
    }

    const { data, error } = await supabase
      .from("cluster4_lines")
      .insert(payload)
      .select("id")
      .single();

    if (error || !data) {
      results.push({
        row,
        lineId: null,
        action: "failed",
        error: error?.message ?? "insert failed",
      });
      continue;
    }
    results.push({ row, lineId: data.id as string, action: "inserted" });
  }

  return results;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
