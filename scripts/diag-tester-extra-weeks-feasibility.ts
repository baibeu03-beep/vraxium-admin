/**
 * 진단(read-only): 더미 테스터 전용 "추가 활동 주차" 생성 방식 타당성 조사 (2026-06-06).
 *
 *   npx tsx --env-file=.env.local scripts/diag-tester-extra-weeks-feasibility.ts
 *
 * 확인:
 *   1) weeks 캘린더 실태 — 시즌별 주차 수·최소/최대·후보 공백(캘린더 시작 이전)
 *   2) 실사용자 최소 uws 주차 vs 테스터 최소 uws 주차 (카드 범위 lowerBound 영향권)
 *   3) 후보 날짜의 seasonCalendar 하드코딩 규칙 판정 (시즌/전환/규칙휴식)
 *   4) official_rest_periods 활성 행과의 overlap
 *   5) 통합 라인 마스터 존재 여부, season_definitions 목록
 *   6) 강등 6명 activity_started_at (시작일이 신규 주차보다 늦으면 기간 필터 확인 필요)
 * DB 변경 없음.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const OUT = "claudedocs/diag-tester-extra-weeks-feasibility-20260606.json";

const SIX_IDS = [
  "bf3b4305-751a-49e3-88ad-95a20e5c4dad",
  "42864260-e4ea-4150-a87f-cff545b02af1",
  "4a81b6d1-e488-4f14-8530-0cad60fe4f0d",
  "05ff6b96-b3e7-4050-97f1-080633f183d3",
  "e4dcb97e-a515-4ec5-a91e-32ca4e629dae",
  "cc1b58e6-b14d-45a0-b389-2df3c27a0b25",
];

async function pageAll<T>(
  table: string,
  select: string,
  filter?: (q: any) => any,
  orderCol = "user_id",
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const cal = await import("@/lib/seasonCalendar");
  const report: Record<string, unknown> = { runAt: new Date().toISOString() };

  // ── 1) weeks 캘린더 실태 ─────────────────────────────────────────────
  const weeks = await pageAll<{
    id: string;
    start_date: string;
    end_date: string | null;
    season_key: string | null;
    week_number: number | null;
    is_official_rest: boolean | null;
  }>("weeks", "id,start_date,end_date,season_key,week_number,is_official_rest", undefined, "start_date");
  const bySeason = new Map<string, { count: number; min: string; max: string }>();
  for (const w of weeks) {
    const k = w.season_key ?? "(null)";
    const e = bySeason.get(k) ?? { count: 0, min: w.start_date, max: w.start_date };
    e.count++;
    if (w.start_date < e.min) e.min = w.start_date;
    if (w.start_date > e.max) e.max = w.start_date;
    bySeason.set(k, e);
  }
  console.log(`=== 1) weeks 캘린더: ${weeks.length}행, ${weeks[0]?.start_date} ~ ${weeks[weeks.length - 1]?.start_date} ===`);
  for (const [k, e] of [...bySeason.entries()].sort((a, b) => a[1].min.localeCompare(b[1].min))) {
    console.log(`  ${k}: ${e.count}주 (${e.min} ~ ${e.max})`);
  }
  report.weeksBySeason = Object.fromEntries(bySeason);
  report.weeksMin = weeks[0]?.start_date;
  report.weeksMax = weeks[weeks.length - 1]?.start_date;

  // ── 2) 실사용자 vs 테스터 최소 uws 주차 ──────────────────────────────
  console.log("\n=== 2) 최소 uws 주차 (카드 범위 lowerBound) ===");
  const markers = await pageAll<{ user_id: string }>("test_user_markers", "user_id");
  const testerIds = new Set(markers.map((m) => m.user_id));
  const uwsAll = await pageAll<{ user_id: string; week_start_date: string }>(
    "user_week_statuses",
    "user_id,week_start_date",
    undefined,
    "id",
  );
  let realMin: string | null = null;
  let testerMin: string | null = null;
  const realMinByUser = new Map<string, string>();
  for (const r of uwsAll) {
    if (testerIds.has(r.user_id)) {
      if (!testerMin || r.week_start_date < testerMin) testerMin = r.week_start_date;
    } else {
      if (!realMin || r.week_start_date < realMin) realMin = r.week_start_date;
      const cur = realMinByUser.get(r.user_id);
      if (!cur || r.week_start_date < cur) realMinByUser.set(r.user_id, r.week_start_date);
    }
  }
  console.log(`  uws 총 ${uwsAll.length}행 | 실사용자 최소 주차=${realMin} | 테스터 최소 주차=${testerMin}`);
  console.log(`  실사용자 보유자 수=${realMinByUser.size}, 최소주차 분포(앞 5): ${[...new Set([...realMinByUser.values()])].sort().slice(0, 5).join(", ")}`);
  report.uws = { total: uwsAll.length, realMinWeek: realMin, testerMinWeek: testerMin, realUserCount: realMinByUser.size };

  // ── 3) 후보 날짜(캘린더 시작 이전 12주) 캘린더 규칙 판정 ────────────
  console.log("\n=== 3) 캘린더 시작 이전 후보 주차 — seasonCalendar 규칙 판정 ===");
  const minStart = new Date(weeks[0]?.start_date + "T00:00:00Z").getTime();
  const WEEK = 7 * 86400000;
  const candidates: any[] = [];
  for (let i = 12; i >= 1; i--) {
    const ms = minStart - i * WEEK;
    const iso = new Date(ms).toISOString().slice(0, 10);
    let info: any = {};
    try {
      const s = (cal as any).getSeasonForDate?.(new Date(ms)) ?? null;
      const st = (cal as any).getSeasonWeekStatusForDate?.(new Date(ms)) ?? null;
      const trans = (cal as any).isTransitionWeekStart?.(iso) ?? null;
      info = {
        seasonKey: s?.seasonKey ?? s?.key ?? JSON.stringify(s)?.slice(0, 60) ?? null,
        weekStatus: typeof st === "object" ? JSON.stringify(st)?.slice(0, 120) : st,
        isTransition: trans,
      };
    } catch (e) {
      info = { error: (e as Error).message };
    }
    candidates.push({ start: iso, ...info });
    console.log(`  ${iso} → ${JSON.stringify(info)}`);
  }
  report.candidates = candidates;

  // ── 4) official_rest_periods 전수 ────────────────────────────────────
  console.log("\n=== 4) official_rest_periods 활성 행 ===");
  const { data: orp, error: orpErr } = await sb.from("official_rest_periods").select("*");
  if (orpErr) console.warn(`  조회 실패: ${orpErr.message}`);
  for (const r of (orp ?? []) as any[]) {
    console.log(`  ${JSON.stringify(r)}`);
  }
  report.officialRestPeriods = orp ?? [];

  // ── 5) 통합 라인 마스터 / season_definitions ─────────────────────────
  console.log("\n=== 5) 통합 라인 마스터 + season_definitions ===");
  const { data: master } = await sb
    .from("cluster4_experience_line_masters")
    .select("id,line_code,line_name,organization_slug,experience_slot_order")
    .ilike("line_name", "%통합%");
  for (const m of (master ?? []) as any[]) console.log(`  master: ${JSON.stringify(m)}`);
  const { data: sdefs } = await sb.from("season_definitions").select("*").order("season_key");
  for (const s of (sdefs ?? []) as any[]) console.log(`  season_def: ${JSON.stringify(s).slice(0, 200)}`);
  report.unifiedMasters = master ?? [];
  report.seasonDefinitions = sdefs ?? [];

  // ── 6) 강등 6명 activity_started_at + uws 최소/최대 ─────────────────
  console.log("\n=== 6) 강등 6명 activity_started_at / uws 범위 ===");
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,display_name,activity_started_at")
    .in("user_id", SIX_IDS);
  const item6: any[] = [];
  for (const p of (profs ?? []) as any[]) {
    const mine = uwsAll.filter((r) => r.user_id === p.user_id).map((r) => r.week_start_date).sort();
    const row = {
      name: p.display_name,
      activity_started_at: p.activity_started_at,
      uwsMin: mine[0] ?? null,
      uwsMax: mine[mine.length - 1] ?? null,
      uwsCount: mine.length,
    };
    item6.push(row);
    console.log(`  ${p.display_name} started=${p.activity_started_at?.slice(0, 10)} uws=${row.uwsMin}~${row.uwsMax} (${row.uwsCount}행)`);
  }
  report.sixTesters = item6;

  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n리포트 저장: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
