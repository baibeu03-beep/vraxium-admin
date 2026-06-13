// 진단(READ-ONLY) — 라인 개설 선택 가능 주차(일반 vs 공식 휴식) 목록.
//   npx tsx --env-file=.env.local scripts/diag-openable-normal-weeks.ts
// weeks-options 라우트 로직 미러(canOpen = !isOfficialRest). DB write 0, snapshot 무접촉.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getCurrentWeekStartMs,
  getOpenableWeekStartMs,
  describeWeekByStartMs,
} from "@/lib/cluster4WeekPolicy";
import { fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
import { matchOfficialRestPeriods } from "@/lib/officialRestPeriodsTypes";

const DAY_MS = 86_400_000;
const LIMIT = 8;

async function main() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentMs = getCurrentWeekStartMs(todayIso);
  const openableMs = getOpenableWeekStartMs(todayIso);
  if (currentMs == null) { console.log("현재 주차 계산 실패"); return; }
  console.log(`오늘=${todayIso}\n`);

  const descriptors: Array<{ isCurrent: boolean; isOpenTarget: boolean; info: any }> = [];
  for (let off = 0; off < LIMIT; off++) {
    const ms = currentMs - off * 7 * DAY_MS;
    const info = describeWeekByStartMs(ms);
    if (!info) continue;
    descriptors.push({ isCurrent: off === 0, isOpenTarget: openableMs != null && ms === openableMs, info });
  }

  // weeks 테이블 매칭(없으면 개설 불가).
  const orExpr = descriptors.map((d) => `and(iso_year.eq.${d.info.isoYear},iso_week.eq.${d.info.isoWeek})`).join(",");
  const { data: weekRows } = await supabaseAdmin.from("weeks").select("id,iso_year,iso_week,start_date,end_date,is_official_rest").or(orExpr);
  const byKey = new Map<string, any>();
  for (const r of (weekRows ?? []) as any[]) byKey.set(`${r.iso_year}::${r.iso_week}`, r);

  const restPeriods = await fetchActiveRestPeriods();

  console.log("선택가능여부 | 주차라벨 | isOfficialRest | canOpen | weeks.is_official_rest(legacy) | week_id | 비고");
  console.log("─".repeat(120));
  const normalSelectable: any[] = [];
  for (const { isCurrent, isOpenTarget, info } of descriptors) {
    const row = byKey.get(`${info.isoYear}::${info.isoWeek}`);
    if (!row) {
      console.log(`  (weeks 행 없음)        | ${info.year} ${info.seasonName} W${info.weekNumber} | rule=${info.isOfficialRest} | — | — | 개설 불가(weeks 미존재)`);
      continue;
    }
    const dateRest = matchOfficialRestPeriods({ startDate: info.weekStart, endDate: info.weekEnd }, restPeriods).length > 0;
    const isOfficialRest = info.isOfficialRest || dateRest;
    const canOpen = !isOfficialRest;
    const tags = [isCurrent ? "현재" : "", isOpenTarget ? "개설대상" : ""].filter(Boolean).join("·");
    console.log(
      `  ${canOpen ? "✅ 선택가능" : "⛔ 차단(휴식)"} | ${info.year} ${info.seasonName} W${info.weekNumber} (${info.weekStart}~${info.weekEnd}) | rule=${info.isOfficialRest}${dateRest ? "+date" : ""} | canOpen=${canOpen} | legacy=${row.is_official_rest} | ${row.id} | ${tags}`,
    );
    if (canOpen) normalSelectable.push({ id: row.id, label: `${info.year} ${info.seasonName} W${info.weekNumber}`, isOpenTarget, isCurrent, start: info.weekStart, end: info.weekEnd });
  }

  console.log("\n── 결론 ──");
  const target = descriptors.find((d) => d.isOpenTarget);
  if (target) {
    const row = byKey.get(`${target.info.isoYear}::${target.info.isoWeek}`);
    const dateRest = row ? matchOfficialRestPeriods({ startDate: target.info.weekStart, endDate: target.info.weekEnd }, restPeriods).length > 0 : false;
    const targetRest = target.info.isOfficialRest || dateRest;
    console.log(`개설 대상 주차(금요일 경계): ${target.info.year} ${target.info.seasonName} W${target.info.weekNumber} → ${targetRest ? "⛔ 공식 휴식(개설 차단 대상)" : "✅ 일반 주차(개설 가능)"} week_id=${row?.id}`);
  }
  console.log(`\n선택 가능한 일반 주차(canOpen=true) ${normalSelectable.length}개:`);
  for (const w of normalSelectable) console.log(`  • ${w.label} (${w.start}~${w.end}) week_id=${w.id}${w.isOpenTarget ? " ← [개설 대상·권장]" : w.isCurrent ? " (현재)" : ""}`);
  if (normalSelectable.length === 0) console.log("  (없음 — 최근 주차가 전부 휴식)");

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
