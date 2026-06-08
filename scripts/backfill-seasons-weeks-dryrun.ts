/**
 * B7: seasons(uuid) / weeks 백필 — DRY-RUN 전용 (DB 쓰기 0건 보장).
 *
 *   npx tsx --env-file=.env.local scripts/backfill-seasons-weeks-dryrun.ts
 *
 * --apply 는 의도적으로 미구현 (전달 시 즉시 종료). 실제 적용은 dry-run 리포트
 * 승인 + B8(37·NET 재감사) 이후 별도 스크립트로 진행한다.
 *
 * ── 입력 계약 (pms 측 export, claudedocs/pms-export/ 에 배치 — 없으면 부분 모드) ──
 *   weekssettings.json        : [{Id,season,week,StartDate,EndDate,confirmStar,IsPublic}]
 *   seasondates.json          : [{Id,SeasonName,Week,StartDate,EndDate,Comment,IsRestWeek,PassingScore}]
 *   reportlogs_weeks.json     : [{Season,Week,minCreated,maxCreated,cnt}]   -- 실적 역산용
 *   pointlogs_activity_dates.json : [{activity_date,rows,date_substituted_rows}] -- 커버리지용
 *   activities_weeks.json     : [{source:'useractivities'|'manageractivities',Season,SeasonWeek,
 *                                 cnt,withActivity,withStar}]               -- 임시 라인 복원성용
 *
 *   pms 측 export SQL (깨진 ActivityTime 보정 규칙 — A5-2 확정 4 반영):
 *     SELECT CASE
 *              WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)  -- 0023 → 2023
 *              WHEN YEAR(ActivityTime) = 1 THEN DATE(createtime)                                       -- 0001 → createtime 대체
 *              ELSE DATE(ActivityTime) END AS activity_date,
 *            SUM(YEAR(ActivityTime) = 1) AS date_substituted_rows,
 *            COUNT(*) AS rows
 *     FROM pointlogs GROUP BY 1 ORDER BY 1;
 *     -- date_substituted 행은 이관 시 ledger payload 에 원본 ActivityTime 보존 + 플래그.
 *
 * ── 반영된 A5-2 수동 확정 ──
 *   1. seasondates.SeasonName='2023' 8행 = 2023-summer. 이 구간 threshold = PassingScore.
 *   2. seasondates Id 193 제외 (194 유효).
 *   3. 2026-winter 결산 실존: W1~7 confirmStar=37 (inferred=true), W8 휴식주.
 *   4. ActivityTime 보정 규칙 (위 export SQL — 본 스크립트는 보정 결과 히스토그램만 소비).
 *   5. 활동 내역 → [실무 경험] 첫 번째 임시 라인(= v17 [통합] LEGACY_UNIFIED_LINE_NAME):
 *      Activity→subtitle, Star→rating, ActivityTime→주차 귀속. 신규 라인 생성 금지,
 *      2026-spring W16 까지만. 본 스크립트는 복원 가능성/충돌 여부만 리포트(이관 안 함).
 *
 * ── 설계 원칙 ──
 *   - season_key = season_type + "종료연도" (예: 2024-12-30~2025-02-23 → 2025-winter).
 *   - check_threshold: weekssettings.confirmStar > (2023-summer) PassingScore > (2026-winter) 확정 37.
 *   - is_official_rest: seasondates.IsRestWeek (라벨 파싱 금지 — 라벨은 holiday_name 보존).
 *   - reportlogs 실적 역산: 두 설정 테이블에 없는 (season,week) 만 inferred 후보로.
 *   - result_published_at: 리포트에 계산값만 표시 — 비가역이므로 apply 대상에서 제외 명시.
 *   - pointlogs 주차 귀속: ActivityTime 날짜 조인 전용 (log/Info 텍스트 파싱 금지).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "fs";

if (process.argv.includes("--apply")) {
  console.error("[backfill-dryrun] --apply 는 미구현 (dry-run 승인 + B8 완료 후 별도 스크립트). 종료.");
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const EXPORT_DIR = "claudedocs/pms-export";
const OUT_PATH = "claudedocs/backfill-seasons-weeks-dryrun-20260605.json";
const LEGACY_CUTOFF = "2026-06-29"; // CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM
const LEGACY_LINE_NAME = "[통합] 주차 활동 내역";

// ── holiday_name 정책 (apply 설계 확정, 2026-06-05) ──────────────────────
//   1) live.holiday_name 비-NULL → 무조건 보존 (덮어쓰기 절대 금지 — diff 미생성)
//   2) 단순 주차 라벨("봄시즌 1주차"/"N주차")  → holiday_name 채택 안 함 (제외)
//   3) 사유성 라벨(설/추석/연휴/명절/중간고사/기말고사/시험) AND 해당 주차가
//      공식 휴식(live 또는 plan) → 신규 반영 후보 (live 가 NULL 일 때만)
//   4) 일반 휴식 키워드("자율 휴식" 등 휴식/휴강/방학)·미분류·휴식주 아님
//      → 보류 큐 (silent 채택 금지 — 306번 라벨-플래그 불일치 quirk 방어)
type HolidayClass = "simple" | "reason" | "generic-rest" | "unknown" | "none";
// "1주차" / "봄시즌 1주차" / "겨울 시즌 8주차" / "테스트 1주차" — 사유 없는 명칭만
const SIMPLE_LABEL_RE = /^(?:[가-힣A-Za-z0-9]+\s*)?(?:시즌\s*)?\d+\s*주차$/;
const REASON_KEYWORDS = ["설", "추석", "연휴", "명절", "중간고사", "기말고사", "시험"];
const GENERIC_REST_KEYWORDS = ["휴식", "휴강", "방학"];
function classifyHolidayLabel(label: string | null | undefined): HolidayClass {
  const t = (label ?? "").trim();
  if (!t) return "none";
  if (SIMPLE_LABEL_RE.test(t)) return "simple";
  if (REASON_KEYWORDS.some(k => t.includes(k))) return "reason";
  if (GENERIC_REST_KEYWORDS.some(k => t.includes(k))) return "generic-rest";
  return "unknown";
}

// ── 시즌명 정규화 사전 (A3-⑩, fail-closed) ─────────────────────────────
const SEASON_DICT: Record<string, string> = {
  "봄": "spring", "봄시즌": "spring",
  "여름": "summer", "여름시즌": "summer",
  "가을": "autumn", "가을시즌": "autumn",
  "겨울": "winter", "겨울시즌": "winter", "거울": "winter", // '거울' = 확인된 오타
  "2023": "__2023_SUMMER__", // A5-2 확정 1: 2023-summer 특례
};
function normalizeSeason(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const key = String(raw).trim().replace(/\s+/g, "").replace(/시즌$/, "") || "";
  if (key === "2023") return "__2023_SUMMER__";
  return SEASON_DICT[key] ?? SEASON_DICT[key + "시즌"] ?? null;
}

function loadJson<T>(name: string): T | null {
  const p = `${EXPORT_DIR}/${name}`;
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as T;
}
const d10 = (s: string) => String(s).slice(0, 10);
const addDays = (iso: string, n: number) => {
  const t = new Date(iso + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

async function pageAll<T>(table: string, select: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select)
      .order(orderCol, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

type PlanWeek = {
  season_key: string;
  week_number: number;
  start_date: string;
  end_date: string;
  check_threshold: number | null;
  threshold_source: string; // weekssettings.confirmStar | seasondates.PassingScore(2023-summer) | confirmed-2026-winter(inferred) | none
  is_official_rest: boolean;
  rest_source: string;
  // 최종 채택값 (phase 3 에서 holiday_name 정책으로 결정). live 보존 절대 우선.
  holiday_name: string | null;
  // pms seasondates 원본 라벨 (분류 전 — 직접 채택 금지)
  holiday_label_raw?: string | null;
  sources: string[]; // weekssettings | seasondates | reportlogs-inferred | confirmed-rule
  inferred: boolean;
  pms_is_public: boolean | null;
  computed_result_published_at: string | null; // 리포트 전용 — apply 제외 (비가역)
  action: "insert" | "update" | "conflict" | "noop";
  live_diff?: Record<string, { live: unknown; plan: unknown }>;
};

async function main() {
  const report: Record<string, unknown> = {
    generatedAt: "2026-06-05 (B7 dry-run)",
    mode: "dry-run (DB writes: 0 — guaranteed; --apply unimplemented)",
  };

  // ── 0) 입력 로드 ──────────────────────────────────────────────────────
  const ws = loadJson<Array<{ Id: number; season: string; week: string; StartDate: string; EndDate: string; confirmStar: number | null; IsPublic: number }>>("weekssettings.json");
  const sd = loadJson<Array<{ Id: number; SeasonName: string; Week: string; StartDate: string; EndDate: string; Comment: string | null; IsRestWeek: number; PassingScore: number | null }>>("seasondates.json");
  const rl = loadJson<Array<{ Season: string; Week: number; minCreated: string; maxCreated: string; cnt: number }>>("reportlogs_weeks.json");
  const plHist = loadJson<Array<{ activity_date: string; rows: number; date_substituted_rows: number }>>("pointlogs_activity_dates.json");
  const actW = loadJson<Array<{ source: string; Season: string; SeasonWeek: number; cnt: number; withActivity: number; withStar: number }>>("activities_weeks.json");
  const missingInputs = [
    !ws && "weekssettings.json", !sd && "seasondates.json", !rl && "reportlogs_weeks.json",
    !plHist && "pointlogs_activity_dates.json", !actW && "activities_weeks.json",
  ].filter(Boolean) as string[];
  report.inputs = {
    exportDir: EXPORT_DIR,
    loaded: { weekssettings: ws?.length ?? 0, seasondates: sd?.length ?? 0, reportlogs_weeks: rl?.length ?? 0, pointlogs_activity_dates: plHist?.length ?? 0, activities_weeks: actW?.length ?? 0 },
    missing: missingInputs,
    partialMode: missingInputs.length > 0,
  };

  // ── 1) Vraxium 라이브 인벤토리 ────────────────────────────────────────
  const liveSeasons = await pageAll<{ id: string; season_index: number; name: string; started_at: string; ended_at: string | null }>("seasons", "id,season_index,name,started_at,ended_at", "season_index");
  const liveDefs = await pageAll<{ season_key: string; season_label: string; season_type: string; start_date: string; end_date: string; year: number | null }>("season_definitions", "season_key,season_label,season_type,start_date,end_date,year", "start_date");
  const liveWeeks = await pageAll<{ id: string; season_id: string; season_key: string | null; week_number: number | null; week_index: number; start_date: string | null; end_date: string | null; is_official_rest: boolean; holiday_name: string | null; check_threshold: number | null; result_published_at: string | null }>("weeks", "id,season_id,season_key,week_number,week_index,start_date,end_date,is_official_rest,holiday_name,check_threshold,result_published_at", "start_date");
  const liveWeekByStart = new Map(liveWeeks.filter(w => w.start_date).map(w => [w.start_date as string, w]));
  const defByKey = new Map(liveDefs.map(s => [s.season_key, s]));

  // 라이브 weeks 의 season_id 정합 (현 데이터 quirk 노출)
  const seasonIds = new Set(liveWeeks.map(w => w.season_id));
  report.liveInventory = {
    seasons: liveSeasons.map(s => ({ index: s.season_index, name: s.name })),
    seasonsCount: liveSeasons.length,
    weeksCount: liveWeeks.length,
    distinctSeasonIdsReferencedByWeeks: seasonIds.size,
    quirk_allWeeksPointToSameSeasonRow: seasonIds.size === 1 && liveWeeks.length > 1,
    seasonDefinitionsCount: liveDefs.length,
  };

  // ── 2) 후보 주차 구성 (소스 머지) ─────────────────────────────────────
  const candidates = new Map<string, PlanWeek>(); // key = start_date
  const excluded: Array<Record<string, unknown>> = [];
  const failClosed: Array<Record<string, unknown>> = [];

  // season_key 결정: season_type + 종료연도 (주차 EndDate 연도가 아니라 "시즌 블록" 종료연도 —
  // season_definitions 와 날짜로 대조해 검증하고, def 가 있으면 def.season_key 채택)
  function resolveSeasonKey(seasonType: string, startDate: string, endDate: string): { key: string | null; via: string } {
    const def = liveDefs.find(s => s.season_type === seasonType && startDate >= addDays(s.start_date, -14) && endDate <= addDays(s.end_date, 21));
    if (def) return { key: def.season_key, via: `season_definitions(${def.season_key})` };
    return { key: null, via: "no-matching-definition" };
  }

  // 2-a) seasondates (달력·휴식 — Id 193 제외)
  for (const r of sd ?? []) {
    if (r.Id === 193) { excluded.push({ table: "seasondates", Id: 193, reason: "확정 2: 중복 — Id 194 유효" }); continue; }
    const norm = normalizeSeason(r.SeasonName);
    const is2023 = norm === "__2023_SUMMER__";
    const seasonType = is2023 ? "summer" : norm;
    if (!seasonType) { failClosed.push({ table: "seasondates", Id: r.Id, SeasonName: r.SeasonName, reason: "시즌명 사전 미등재 (fail-closed)" }); continue; }
    const start = d10(r.StartDate), end = d10(r.EndDate);
    const { key, via } = is2023
      ? { key: "2023-summer", via: "확정 1 (SeasonName='2023')" }
      : resolveSeasonKey(seasonType, start, end);
    if (!key) { failClosed.push({ table: "seasondates", Id: r.Id, start, reason: via }); continue; }
    const cur = candidates.get(start);
    const next: PlanWeek = cur ?? {
      season_key: key, week_number: -1, start_date: start, end_date: end,
      check_threshold: null, threshold_source: "none",
      is_official_rest: false, rest_source: "none", holiday_name: null,
      sources: [], inferred: false, pms_is_public: null, computed_result_published_at: null, action: "noop",
    };
    next.end_date = end; // 달력 속성은 seasondates 우선
    next.is_official_rest = !!r.IsRestWeek;
    next.rest_source = "seasondates.IsRestWeek";
    // 라벨은 raw 보관만 — holiday_name 채택은 phase 3 정책(분류 + live 보존)에서 결정
    next.holiday_label_raw = r.Week?.trim() || r.Comment?.trim() || next.holiday_label_raw;
    if (is2023 && next.check_threshold == null) {
      next.check_threshold = r.PassingScore ?? null;
      next.threshold_source = "seasondates.PassingScore (확정 1: 2023-summer 한정)";
    }
    if (!next.sources.includes("seasondates")) next.sources.push("seasondates");
    candidates.set(start, next);
  }

  // 2-b) weekssettings (결산 속성 — threshold/공개. 달력은 보조)
  for (const r of ws ?? []) {
    const seasonType = normalizeSeason(r.season);
    if (!seasonType || seasonType === "__2023_SUMMER__") {
      if (!seasonType) failClosed.push({ table: "weekssettings", Id: r.Id, season: r.season, reason: "시즌명 사전 미등재" });
      continue;
    }
    const start = d10(r.StartDate), end = d10(r.EndDate);
    const wkNum = Number.parseInt(String(r.week), 10);
    const { key, via } = resolveSeasonKey(seasonType, start, end);
    if (!key) { failClosed.push({ table: "weekssettings", Id: r.Id, start, reason: via }); continue; }
    const cur = candidates.get(start);
    const next: PlanWeek = cur ?? {
      season_key: key, week_number: Number.isFinite(wkNum) ? wkNum : -1, start_date: start, end_date: end,
      check_threshold: null, threshold_source: "none",
      is_official_rest: false, rest_source: "none", holiday_name: null,
      sources: [], inferred: false, pms_is_public: null, computed_result_published_at: null, action: "noop",
    };
    if (Number.isFinite(wkNum)) next.week_number = wkNum;
    next.check_threshold = r.confirmStar ?? next.check_threshold;
    next.threshold_source = r.confirmStar != null ? "weekssettings.confirmStar" : next.threshold_source;
    next.pms_is_public = !!r.IsPublic;
    // 비가역 — 리포트 전용 계산 (apply 제외)
    next.computed_result_published_at = r.IsPublic ? `${addDays(end, 1)}T00:00:00+09:00` : null;
    if (!next.sources.includes("weekssettings")) next.sources.push("weekssettings");
    candidates.set(start, next);
  }

  // 2-c) week_number 미부여(seasondates 단독) → 시즌 내 날짜 순위로 파생 (라벨 비파싱)
  const bySeason = new Map<string, PlanWeek[]>();
  for (const c of candidates.values()) {
    bySeason.set(c.season_key, [...(bySeason.get(c.season_key) ?? []), c]);
  }
  for (const list of bySeason.values()) {
    list.sort((a, b) => a.start_date.localeCompare(b.start_date));
    list.forEach((c, i) => { if (c.week_number < 0) c.week_number = i + 1; });
  }

  // 2-d) reportlogs 실적 역산 — 설정 테이블에 없는 (season,week) 만 inferred
  const inferredRows: Array<Record<string, unknown>> = [];
  for (const r of rl ?? []) {
    const seasonType = normalizeSeason(r.Season);
    if (!seasonType || seasonType === "__2023_SUMMER__") continue;
    const created = d10(r.minCreated);
    const def = liveDefs.find(s => s.season_type === seasonType && created >= s.start_date && created <= addDays(s.end_date, 21));
    if (!def) { failClosed.push({ table: "reportlogs", Season: r.Season, Week: r.Week, reason: "연도 추론 실패" }); continue; }
    const exists = [...candidates.values()].some(c => c.season_key === def.season_key && c.week_number === r.Week);
    if (exists) continue;
    const start = addDays(def.start_date, 7 * (r.Week - 1)); // def anchor 기반 추정 (inferred)
    const cand: PlanWeek = {
      season_key: def.season_key, week_number: r.Week, start_date: start, end_date: addDays(start, 6),
      check_threshold: null, threshold_source: "none (inferred — B8 전 수동 확정 필요)",
      is_official_rest: false, rest_source: "none(inferred)", holiday_name: null,
      sources: ["reportlogs-inferred"], inferred: true,
      pms_is_public: true, computed_result_published_at: null, action: "noop",
    };
    candidates.set(start, candidates.get(start) ?? cand);
    inferredRows.push({ season_key: def.season_key, week: r.Week, start, reportCnt: r.cnt });
  }

  // 2-e) 확정 3: 2026-winter W1~7 threshold=37 (inferred), W8 휴식 — 라이브 행 기반 update 계획
  const winterPlan: Array<Record<string, unknown>> = [];
  for (const w of liveWeeks.filter(x => x.season_key === "2026-winter")) {
    const n = w.week_number ?? -1;
    const start = w.start_date as string;
    const cur = candidates.get(start) ?? {
      season_key: "2026-winter", week_number: n, start_date: start, end_date: w.end_date ?? addDays(start, 6),
      check_threshold: null, threshold_source: "none",
      is_official_rest: w.is_official_rest, rest_source: "live(existing)", holiday_name: w.holiday_name,
      sources: [], inferred: false, pms_is_public: null, computed_result_published_at: null, action: "noop" as const,
    };
    if (n >= 1 && n <= 7 && cur.check_threshold == null) {
      cur.check_threshold = 37;
      cur.threshold_source = "확정 3: 2026-winter W1~7 confirmStar=37 (inferred=true)";
      cur.inferred = true;
      if (!cur.sources.includes("confirmed-rule")) cur.sources.push("confirmed-rule");
      candidates.set(start, cur as PlanWeek);
    }
    winterPlan.push({
      week_number: n, start_date: start, live_is_official_rest: w.is_official_rest,
      expected: n === 8 ? "휴식주 (확정 3)" : n <= 7 ? "threshold 37" : "확정 범위 밖 (전환/예비 — 수동 확인)",
      restMatchesConfirmation: n === 8 ? w.is_official_rest === true : null,
    });
  }
  report.winter2026 = winterPlan;

  // ── 3) 라이브 대조 → action 결정 ─────────────────────────────────────
  const plan = [...candidates.values()].sort((a, b) => a.start_date.localeCompare(b.start_date));
  const conflicts: Array<Record<string, unknown>> = [];
  // holiday_name 정책 집계 (apply 설계 검증용)
  const holidayPreservedLive: Array<Record<string, unknown>> = []; // live 비-NULL 보존 (pms 라벨 무시)
  const holidayNewlyAdopted: Array<Record<string, unknown>> = [];  // live NULL → 사유성 라벨 신규 반영
  const holidayExcludedSimple = new Map<string, number>();          // 단순 주차 라벨 (채택 안 함)
  const holidayHeldForReview: Array<Record<string, unknown>> = []; // generic-rest/unknown/휴식주 아님 — 보류 큐
  let inserts = 0, updates = 0, noops = 0;
  for (const c of plan) {
    const live = liveWeekByStart.get(c.start_date);
    // ── holiday_name 정책 적용 (분류 → 채택/보존/제외/보류) ──────────────
    {
      const raw = c.holiday_label_raw ?? null;
      const cls = classifyHolidayLabel(raw);
      const weekIsRest = live?.is_official_rest === true || c.is_official_rest === true;
      const liveLabel = live?.holiday_name ?? null;
      let adopted: string | null = null;
      if (cls === "reason" && weekIsRest) adopted = raw;
      else if (cls === "simple" && raw) holidayExcludedSimple.set(raw, (holidayExcludedSimple.get(raw) ?? 0) + 1);
      else if (raw && (cls === "generic-rest" || cls === "unknown" || (cls === "reason" && !weekIsRest))) {
        holidayHeldForReview.push({ start: c.start_date, season: c.season_key, week: c.week_number, label: raw, class: cls, weekIsRest, reason: cls === "reason" ? "사유성 라벨이나 휴식주 아님" : "일반/미분류 라벨 — silent 채택 금지" });
      }
      if (liveLabel != null) {
        // 절대 규칙: live 의미 라벨 보존 — 어떤 plan 라벨로도 덮지 않는다.
        if (raw && raw !== liveLabel) {
          holidayPreservedLive.push({ start: c.start_date, season: c.season_key, week: c.week_number, live: liveLabel, ignoredPlanLabel: raw, planLabelClass: cls, wouldHaveAdopted: adopted != null, note: "live 보존 — pms 라벨 미반영" });
        }
        c.holiday_name = liveLabel; // diff 자체가 생기지 않도록 live 값 고정
      } else {
        c.holiday_name = adopted;
        if (adopted != null) holidayNewlyAdopted.push({ start: c.start_date, season: c.season_key, week: c.week_number, before: null, after: adopted, weekIsRest, liveAction: live ? "update" : "insert" });
      }
    }
    if (!live) {
      // 날짜 겹침(경계 불일치) 충돌 검사
      const overlap = liveWeeks.find(w => w.start_date && w.end_date && !(c.end_date < (w.start_date as string) || c.start_date > (w.end_date as string)));
      if (overlap) {
        c.action = "conflict";
        conflicts.push({ plan: { start: c.start_date, end: c.end_date, season: c.season_key }, live: { start: overlap.start_date, end: overlap.end_date, season: overlap.season_key }, reason: "경계 불일치 겹침" });
      } else { c.action = "insert"; inserts++; }
      continue;
    }
    const diff: Record<string, { live: unknown; plan: unknown }> = {};
    if ((live.season_key ?? null) !== c.season_key) diff.season_key = { live: live.season_key, plan: c.season_key };
    if ((live.week_number ?? null) !== c.week_number) diff.week_number = { live: live.week_number, plan: c.week_number };
    if ((live.check_threshold ?? null) !== c.check_threshold && c.check_threshold != null) diff.check_threshold = { live: live.check_threshold, plan: c.check_threshold };
    if (live.is_official_rest !== c.is_official_rest && c.rest_source.startsWith("seasondates")) diff.is_official_rest = { live: live.is_official_rest, plan: c.is_official_rest };
    if ((live.holiday_name ?? null) !== (c.holiday_name ?? null) && c.holiday_name) diff.holiday_name = { live: live.holiday_name, plan: c.holiday_name };
    // result_published_at 은 비가역 — diff 에 절대 포함하지 않음 (리포트 별도 항목)
    if (diff.season_key || diff.week_number || (diff.is_official_rest && live.result_published_at)) {
      c.action = "conflict"; c.live_diff = diff;
      conflicts.push({ start: c.start_date, diff, note: "키/판정 속성 충돌 — 수동 검토" });
    } else if (Object.keys(diff).length > 0) {
      c.action = "update"; c.live_diff = diff; updates++;
    } else { c.action = "noop"; noops++; }
  }

  // ── 4) seasons(uuid) 백필 계획 ────────────────────────────────────────
  const neededKeys = [...new Set(plan.map(c => c.season_key))].sort();
  const liveSeasonNames = new Set(liveSeasons.map(s => s.name));
  const seasonPlan = neededKeys.map(k => {
    const def = defByKey.get(k);
    const name = def?.season_label ?? k;
    return { season_key: k, name, exists: liveSeasonNames.has(name), action: liveSeasonNames.has(name) ? "noop" : "insert", started_at: def?.start_date, ended_at: def?.end_date };
  });
  report.seasonsPlan = {
    rows: seasonPlan,
    inserts: seasonPlan.filter(s => s.action === "insert").length,
    note: "weeks.season_id NOT NULL — insert 주차는 신설 seasons.id 참조. 기존 42행의 season_id 재배선 여부는 별도 결정(현재 단일 행 참조 quirk).",
  };

  // ── 5) weeks 계획 요약 ────────────────────────────────────────────────
  report.weeksPlan = {
    totalCandidates: plan.length,
    actions: { insert: inserts, update: updates, conflict: conflicts.length, noop: noops },
    rowCount: { before: liveWeeks.length, afterExpected: liveWeeks.length + inserts },
    rows: plan.map(c => ({
      start: c.start_date, end: c.end_date, season: c.season_key, week: c.week_number,
      threshold: c.check_threshold, thresholdSource: c.threshold_source,
      rest: c.is_official_rest, restSource: c.rest_source,
      holiday: c.holiday_name, sources: c.sources, inferred: c.inferred,
      pmsIsPublic: c.pms_is_public,
      computedPublishedAt_REPORT_ONLY: c.computed_result_published_at,
      action: c.action, diff: c.live_diff ?? null,
    })),
  };
  report.excludedRows = excluded;
  report.failClosedRows = failClosed;
  report.inferredFromReportlogs = inferredRows;
  report.conflicts = conflicts;

  // ── 5-b) holiday_name 정책 리포트 + 불변식 검증 ───────────────────────
  // 불변식: 최종 plan 의 holiday_name diff 중 live 비-NULL(=덮어쓰기) 은 0건.
  const holidayDiffs = plan
    .filter(c => c.live_diff?.holiday_name)
    .map(c => ({ start: c.start_date, season: c.season_key, week: c.week_number, before: c.live_diff!.holiday_name.live, after: c.live_diff!.holiday_name.plan }));
  const liveOverwrites = holidayDiffs.filter(d => d.before != null);
  report.holidayNamePolicy = {
    rules: [
      "1) live.holiday_name 비-NULL → 무조건 보존 (덮어쓰기 금지, diff 미생성)",
      "2) 단순 주차 라벨(SIMPLE_LABEL_RE) → 채택 안 함",
      `3) 사유성 라벨(${REASON_KEYWORDS.join("/")}) AND 공식 휴식 주차(live∨plan) AND live NULL → 신규 반영`,
      `4) 일반 휴식 라벨(${GENERIC_REST_KEYWORDS.join("/")})·미분류·휴식주 아님 → 보류 큐 (silent 채택 금지)`,
    ],
    invariant_liveOverwriteCandidates: liveOverwrites.length, // 반드시 0
    invariantHolds: liveOverwrites.length === 0,
    diffsBeforeAfter: holidayDiffs, // 변경 전/후 전체 (live NULL → 신규 반영만 존재해야 함)
    preservedLive: holidayPreservedLive,
    newlyAdopted: holidayNewlyAdopted,
    excludedSimpleLabels: {
      distinct: holidayExcludedSimple.size,
      totalRows: [...holidayExcludedSimple.values()].reduce((a, b) => a + b, 0),
      labels: Object.fromEntries([...holidayExcludedSimple.entries()].sort()),
    },
    heldForReview: holidayHeldForReview,
  };
  if (liveOverwrites.length > 0) {
    console.error("[backfill-dryrun] ❌ holiday_name 불변식 위반 — live 덮어쓰기 후보:", JSON.stringify(liveOverwrites));
    process.exitCode = 1;
  }
  report.irreversibleGuard = {
    result_published_at: "dry-run 계산값만 리포트 (computedPublishedAt_REPORT_ONLY). apply 설계에서 위 컬럼은 쓰기 페이로드에서 구조적으로 제외 — publish 는 기존 PATCH publish-result 경로(409 비가역)만 사용.",
  };

  // ── 6) pointlogs 주차 귀속 커버리지 (히스토그램 입력 시) ─────────────
  if (plHist) {
    const ranges = plan.concat(
      liveWeeks.filter(w => w.start_date && !candidates.has(w.start_date as string)).map(w => ({
        start_date: w.start_date as string, end_date: (w.end_date ?? addDays(w.start_date as string, 6)) as string,
      }) as PlanWeek),
    );
    let covered = 0, uncovered = 0, substituted = 0;
    const gaps = new Map<string, number>();
    for (const h of plHist) {
      const hit = ranges.some(r => h.activity_date >= r.start_date && h.activity_date <= r.end_date);
      if (hit) covered += h.rows; else { uncovered += h.rows; gaps.set(h.activity_date.slice(0, 7), (gaps.get(h.activity_date.slice(0, 7)) ?? 0) + h.rows); }
      substituted += h.date_substituted_rows ?? 0;
    }
    report.pointlogsCoverage = {
      coveredRows: covered, uncoveredRows: uncovered,
      coveragePct: covered + uncovered > 0 ? +(100 * covered / (covered + uncovered)).toFixed(2) : null,
      dateSubstitutedRows: substituted,
      note: "date_substituted 행은 이관 시 ledger payload 에 원본 ActivityTime 보존 + 플래그 (확정 4)",
      uncoveredByMonth: Object.fromEntries([...gaps.entries()].sort()),
    };
  } else {
    report.pointlogsCoverage = { skipped: "pointlogs_activity_dates.json 미제공 — pms export 후 재실행" };
  }

  // ── 7) B8 재감사 week set (37·NET 기준) ───────────────────────────────
  const b8Set = plan
    .filter(c => c.check_threshold != null && (c.pms_is_public === true || liveWeekByStart.get(c.start_date)?.result_published_at))
    .map(c => ({ season_key: c.season_key, week_number: c.week_number, start_date: c.start_date, check_threshold: c.check_threshold, thresholdSource: c.threshold_source, inferred: c.inferred }));
  report.b8AuditWeekSet = {
    count: b8Set.length, weeks: b8Set,
    usage: "B8: 이 set 의 (week, threshold)로 checks_migrated=true 행 보유 사용자의 read-time 판정(NET points >= threshold)을 재감사",
  };

  // ── 8) [실무 경험] 첫 번째 임시 라인 — 복원 가능성 + v17 충돌 검사 ───
  const { data: master } = await sb.from("cluster4_experience_line_masters")
    .select("id,line_code,line_name,experience_slot_order,organization_slug,is_active")
    .eq("line_name", LEGACY_LINE_NAME).limit(1).maybeSingle();
  let legacyLines: Array<{ id: string; week_id: string | null }> = [];
  let legacyTargets = 0;
  if (master) {
    legacyLines = await pageAll<{ id: string; week_id: string | null }>("cluster4_lines", "id,week_id", "id")
      .then(rows => rows) // pageAll 전량 후 필터 (PostgREST cap 방어)
      .then(async () => {
        const { data } = await sb.from("cluster4_lines").select("id,week_id").eq("experience_line_master_id", (master as { id: string }).id).range(0, 4999);
        return (data ?? []) as Array<{ id: string; week_id: string | null }>;
      });
    if (legacyLines.length) {
      const { count } = await sb.from("cluster4_line_targets").select("*", { count: "exact", head: true })
        .in("line_id", legacyLines.map(l => l.id).slice(0, 500));
      legacyTargets = count ?? 0;
    }
  }
  const legacyWeeksLive = liveWeeks.filter(w => (w.start_date ?? "") < LEGACY_CUTOFF);
  const springW16End = "2026-06-21"; // 2026-spring W16 end (확정 5 적용 상한)
  report.tempLineRestorability = {
    master: master ? { found: true, line_code: (master as Record<string, unknown>).line_code, slot: (master as Record<string, unknown>).experience_slot_order, active: (master as Record<string, unknown>).is_active } : { found: false, note: "마스터 부재 — v17 마이그레이션 미적용 신호 (이관 전 필수)" },
    liveLegacyLines: legacyLines.length,
    liveLegacyTargets_sample: legacyTargets,
    mappingRule: "Activity→cluster4_line_submissions.subtitle / Star→cluster4_experience_line_evaluations.rating / ActivityTime→week 귀속 (확정 5)",
    schemaReady: { "submissions.subtitle": true, "evaluations.rating(smallint)": true }, // live-schema-dump 검증 완료
    applyWindow: `~ 2026-spring W16 (end ${springW16End}) — 신규 라인 생성 금지, 기존 [통합] 라인 타깃에 적재`,
    restorable: actW
      ? {
          bySource: actW.map(a => ({ source: a.source, season: a.Season, week: a.SeasonWeek, rows: a.cnt, subtitleRestorablePct: a.cnt ? +(100 * a.withActivity / a.cnt).toFixed(1) : null, ratingRestorablePct: a.cnt ? +(100 * a.withStar / a.cnt).toFixed(1) : null })),
        }
      : { skipped: "activities_weeks.json 미제공 — subtitle/rating 복원률은 pms export 후 산출" },
    v17ConflictCheck: {
      legacyBoundary: `start_date < ${LEGACY_CUTOFF} (isLegacyUnifiedWeekStart 와 동일)`,
      spring2026W16WithinLegacy: springW16End < LEGACY_CUTOFF,
      summerW1OrLaterExcluded: "확정 5 상한(2026-spring W16) < 컷오프(06-29) — 신구조 혼합 없음",
      newLineCreation: "없음 — 기존 마스터/라인 재사용, week 별 타깃·평점·제출만 추가 (v17 설계 그대로)",
      verdictPath: "reduceLegacyUnifiedVerdict (평점4↑ AND checks_migrated=true 시 check 게이트) — 본 백필로 코드 변경 없음",
    },
  };

  // ── 9) 영향 범위 분석 (snapshot/demoUserId/DTO) ───────────────────────
  // checks_migrated=true 보유 사용자 (threshold 변경의 실제 영향 범위)
  const { data: cmRows } = await sb.from("user_weekly_points")
    .select("user_id").eq("checks_migrated", true).range(0, 9999);
  const cmUsers = new Set((cmRows ?? []).map((r: { user_id: string }) => r.user_id));
  const { count: snapCount } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  report.impactAnalysis = {
    writesInThisScript: 0,
    applyWouldTouch: ["seasons(insert)", "weeks(insert/update: check_threshold·holiday_name·is_official_rest)"],
    notTouched: ["snapshot 생성/조회 로직", "DTO/API contract", "demoUserId 경로(조회대상 override only)", "uws/uwp", "cluster4 라인/타깃", "result_published_at(비가역 — 제외)"],
    checkGateContract: "판정 전환 조건 = user_weekly_points.checks_migrated 플래그 단독 (크기/분포 추론 금지). 본 백필은 플래그를 건드리지 않음 — threshold 값만 공급.",
    snapshotRecomputePolicy: {
      affectedUsers_checksMigratedTrue: cmUsers.size,
      currentSnapshots: snapCount ?? null,
      analysis: "weeks.check_threshold 변경(NULL→37 등)은 checks_migrated=true 주차 보유 사용자의 read-time 판정 입력을 바꿈 → 해당 사용자 snapshot 은 재계산 전까지 '내용 stale'(is_stale=false 인데 구판정). apply 후 cmUsers 전원 snapshot 재계산 필수 — 정책 변경 아님(기존 '원장 직접수정 시 명시 재계산' 룰 그대로).",
      checksMigratedFalseUsers: "게이트 미강제(fail-safe) — threshold 변경 무영향, 재계산 불필요.",
    },
  };

  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`[backfill-dryrun] report → ${OUT_PATH}`);
  console.log(JSON.stringify({
    partialMode: (report.inputs as Record<string, unknown>).partialMode,
    missingInputs,
    seasons: report.seasonsPlan && (report.seasonsPlan as Record<string, unknown>).inserts,
    weeks: (report.weeksPlan as Record<string, unknown>).actions,
    rowCount: (report.weeksPlan as Record<string, unknown>).rowCount,
    conflicts: conflicts.length,
    b8Weeks: b8Set.length,
    winter2026Checked: winterPlan.length,
    legacyLineMaster: !!master,
    checksMigratedTrueUsers: cmUsers.size,
    holidayPolicy: {
      liveOverwriteCandidates: liveOverwrites.length,
      preservedLive: holidayPreservedLive.length,
      newlyAdopted: holidayNewlyAdopted.length,
      excludedSimpleRows: [...holidayExcludedSimple.values()].reduce((a, b) => a + b, 0),
      heldForReview: holidayHeldForReview.length,
    },
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
