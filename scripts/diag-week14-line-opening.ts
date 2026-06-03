/**
 * 14주차 cluster-4-card 라인 "개설처럼 표시" 진단.
 *   npx tsx --env-file=.env.local scripts/diag-week14-line-opening.ts
 *
 * 점검:
 *   Q1. 현재(오늘) 주차 및 14주차가 휴식(공식) 주차로 판정되는가
 *       - DB weeks.is_official_rest
 *       - 캘린더 규칙(isSeasonRuleRestForWeekStart / describeWeekByStartMs)
 *       - official_rest_periods overlap
 *   Q2. cluster4_line_targets 에 14주차(weekId) 레코드가 실제 존재하는가
 *   Q3. (구조) 캘린더 week_number 와 DB weeks.week_number 의 정합 — off-by-one 탐지
 *   Q4. resolveWeekResultStatus 가 14주차에 내리는 최종 resultStatus
 *       → restWeekIds 포함 여부(=cluster-4-card 미배정 라인 게이트가 막는지)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getSeasonForDate,
  getSeasonWeekStatusForDate,
  isTransitionWeekStart,
} from "@/lib/seasonCalendar";
import { describeWeekByStartMs } from "@/lib/cluster4WeekPolicy";
import {
  fetchActiveRestPeriods,
  isSeasonRuleRestForWeekStart,
} from "@/lib/officialRestPeriodsData";
import { matchOfficialRestPeriods } from "@/lib/officialRestPeriodsTypes";
import { resolveWeekResultStatus } from "@/lib/growthCore";

const DAY_MS = 86_400_000;
function toMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

async function main() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const season = getSeasonForDate(todayIso);
  console.log("=== TODAY / SEASON (calendar) ===");
  console.log("today:", todayIso);
  console.log("season:", season);
  const currentWeekStart =
    season != null
      ? (() => {
          const idx = Math.floor(
            (toMs(todayIso) - toMs(season.startDate)) / (7 * DAY_MS),
          );
          return new Date(toMs(season.startDate) + idx * 7 * DAY_MS)
            .toISOString()
            .slice(0, 10);
        })()
      : null;
  console.log("currentWeekStart (calendar):", currentWeekStart);

  const seasonKey = season
    ? `${season.year}-${{ 겨울: "winter", 봄: "spring", 여름: "summer", 가을: "autumn" }[season.type]}`
    : null;
  console.log("seasonKey:", seasonKey);

  console.log("\n=== official_rest_periods (active) ===");
  const restPeriods = await fetchActiveRestPeriods();
  console.log(JSON.stringify(restPeriods, null, 2));

  console.log("\n=== DB weeks (current season) vs CALENDAR ===");
  const { data: weeksData, error: weeksErr } = await supabaseAdmin
    .from("weeks")
    .select(
      "id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name,result_published_at",
    )
    .eq("season_key", seasonKey ?? "__none__")
    .order("week_number", { ascending: true });
  if (weeksErr) {
    console.error("weeks query error:", weeksErr.message);
  }
  const weeks = weeksData ?? [];

  type Row = {
    id: string;
    week_number: number | null;
    start_date: string | null;
    end_date: string | null;
    is_official_rest: boolean;
    result_published_at: string | null;
  };

  for (const w of weeks as Row[]) {
    const start = w.start_date ?? "";
    const calStatus = start ? getSeasonWeekStatusForDate(start) : null;
    const desc = start ? describeWeekByStartMs(toMs(start)) : null;
    const ruleRest = start ? isSeasonRuleRestForWeekStart(start) : false;
    const periodOverlap =
      start
        ? matchOfficialRestPeriods(
            { startDate: start, endDate: w.end_date ?? start },
            restPeriods,
          ).length > 0
        : false;
    const weekIsOfficialRest = ruleRest || periodOverlap;
    const mismatch =
      desc && w.week_number != null && desc.weekNumber !== w.week_number
        ? "  <<< WEEKNUM MISMATCH"
        : "";
    console.log(
      [
        `dbWk=${String(w.week_number).padStart(2)}`,
        `start=${start}`,
        `dbRest=${w.is_official_rest}`,
        `calWk=${desc?.weekNumber ?? "?"}`,
        `calStatus=${calStatus}`,
        `ruleRest=${ruleRest}`,
        `periodOverlap=${periodOverlap}`,
        `=>officialRest=${weekIsOfficialRest}`,
        `transition=${start ? isTransitionWeekStart(start) : "?"}`,
        `published=${Boolean(w.result_published_at)}`,
        mismatch,
      ].join(" | "),
    );
  }

  // --- focus: 14주차 (DB week_number = 14) ---
  const wk14 = (weeks as Row[]).find((w) => w.week_number === 14);
  console.log("\n=== FOCUS: DB week_number = 14 ===");
  if (!wk14) {
    console.log("(no weeks row with week_number=14 for this season)");
  } else {
    console.log("weeks row:", wk14);
    const start = wk14.start_date ?? "";
    const ruleRest = isSeasonRuleRestForWeekStart(start);
    const periodOverlap =
      matchOfficialRestPeriods(
        { startDate: start, endDate: wk14.end_date ?? start },
        restPeriods,
      ).length > 0;
    const weekIsOfficialRest = ruleRest || periodOverlap;
    const isCurrentWeek = start === currentWeekStart;

    // Q2: line targets for this weekId
    const { data: targetData, error: targetErr } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select(
        "id,line_id,week_id,target_mode,target_user_id,created_at,cluster4_lines(id,part_type,line_code,main_title,is_active)",
      )
      .eq("week_id", wk14.id);
    if (targetErr) console.error("line_targets error:", targetErr.message);
    const targets = targetData ?? [];
    console.log(`\ncluster4_line_targets for weekId=${wk14.id}: count=${targets.length}`);
    console.log(JSON.stringify(targets, null, 2));

    // Q4: resolve resultStatus for several uws scenarios
    console.log("\nresolveWeekResultStatus (weekIsOfficialRest =", weekIsOfficialRest, ", isCurrentWeek =", isCurrentWeek, ")");
    for (const uws of [null, "success", "fail", "official_rest", "personal_rest"] as const) {
      for (const published of [true, false]) {
        const r = resolveWeekResultStatus({
          uwsStatus: uws as never,
          isCurrentWeek,
          isPublished: published,
          weekIsOfficialRest,
          experienceVerdictStatus: null,
        });
        const isRest =
          r.status === "official_rest" || r.status === "personal_rest";
        const inRestWeekIds = isRest || isTransitionWeekStart(start);
        console.log(
          `  uws=${String(uws).padEnd(13)} published=${published} -> resultStatus=${String(r.status).padEnd(13)} | inRestWeekIds(gate blocks)=${inRestWeekIds}`,
        );
      }
    }
  }

  // Also: which weeks actually have line_targets at all (this season)?
  console.log("\n=== line_targets distribution across season weeks ===");
  const weekIds = (weeks as Row[]).map((w) => w.id);
  if (weekIds.length > 0) {
    const { data: allTargets } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("week_id")
      .in("week_id", weekIds);
    const byWeek = new Map<string, number>();
    for (const t of (allTargets ?? []) as { week_id: string }[]) {
      byWeek.set(t.week_id, (byWeek.get(t.week_id) ?? 0) + 1);
    }
    for (const w of weeks as Row[]) {
      const c = byWeek.get(w.id) ?? 0;
      if (c > 0)
        console.log(`dbWk=${w.week_number} start=${w.start_date} targets=${c}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
