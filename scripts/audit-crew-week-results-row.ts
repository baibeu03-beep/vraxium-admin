/**
 * 주차 결과(크루) — 한 행(조직 × 주차)의 **사용자 단위 감사**.
 *
 *   집계 숫자만 믿지 않기 위해, 화면에 뜨는 각 지표가 "정확히 누구로 구성됐는지"를 전부 출력한다.
 *   숫자를 바꾸지 않는다 — 읽기 전용.
 *
 *   Usage:
 *     npx tsx --env-file=.env.local scripts/audit-crew-week-results-row.ts [org] [weekNumber] [seasonKey] [mode]
 *   예: ... audit-crew-week-results-row.ts encre 13 2026-spring operating
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { resolveOrgResultScope } from "@/lib/weekOrgResultState";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import {
  loadCrewWeeklyMetricsInputs,
  computeCrewWeeklyMetrics,
} from "@/lib/crewWeeklyMetricsAggregation";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";

const org = (process.argv[2] ?? "encre") as OrganizationSlug;
const weekNumber = Number(process.argv[3] ?? 13);
const seasonKey = process.argv[4] ?? "2026-spring";
const mode = (process.argv[5] ?? "operating") as ScopeMode;

async function main() {
  const activityDate = getCurrentActivityDateIso();

  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date,is_official_rest")
    .eq("season_key", seasonKey)
    .eq("week_number", weekNumber)
    .maybeSingle();
  if (!wk) throw new Error(`주차를 찾을 수 없음: ${seasonKey} W${weekNumber}`);
  const week = wk as {
    id: string;
    season_key: string;
    start_date: string;
    end_date: string;
    is_official_rest: boolean | null;
  };

  console.log("═══ 실행 컨텍스트 ═══");
  console.log(`  DB(project ref)      : ${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^https:\/\/([^.]+).*/, "$1")}`);
  console.log(`  APP_ENV              : ${process.env.APP_ENV ?? "(unset)"}`);
  console.log(`  QA_HIDE_REAL_USERS   : ${QA_HIDE_REAL_USERS}`);
  console.log(`  요청 mode            : ${mode}`);
  console.log(`  검수상태 scope       : ${resolveOrgResultScope(mode)}   ← resolveOrgResultScope(QA 반영)`);
  console.log(`  지표 로스터 scope    : ${resolveOrgResultScope(mode)}   ← 검수상태와 동일 scope`);
  console.log(`  currentActivityDate  : ${activityDate}`);
  console.log(`  organizationSlug     : ${org}`);
  console.log(`  weekId               : ${week.id}`);
  console.log(`  주차                 : ${week.season_key} W${weekNumber} ${week.start_date}~${week.end_date} 공식휴식=${week.is_official_rest === true}`);

  // scope 는 단일 출처(resolveOrgResultScope)이므로 상태와 지표가 구조적으로 항상 일치한다.

  // ⚠ 검수 상태와 동일한 scope 로 로드한다(모집단 일치).
  const scope = resolveOrgResultScope(mode);
  const inputs = await loadCrewWeeklyMetricsInputs(org, scope);
  const metrics = computeCrewWeeklyMetrics({
    inputs,
    weekStartDate: week.start_date,
    weekEndDate: week.end_date,
    seasonKey: week.season_key,
    isOfficialRest: week.is_official_rest === true,
  });

  console.log("\n═══ 집계 결과 ═══");
  console.log(`  ${JSON.stringify(metrics)}`);

  // ── 사용자 단위 audit row 재구성 (computeCrewWeeklyMetrics 와 동일 순서/규칙) ──
  const testIds = await fetchTestUserMarkerIds();
  const restUserIds = new Set(
    inputs.restPeriods
      .filter((r) => r.start_date <= week.end_date && r.end_date >= week.start_date)
      .map((r) => r.user_id),
  );

  type AuditRow = {
    userId: string;
    isTestMarker: boolean;
    activityStartedAt: string | null;
    effectiveStart: string | null;
    seasonRest: boolean;
    personalRest: boolean;
    resultRowExists: boolean;
    uwsStatus: string | null;
    challenge: boolean;
    success: boolean;
    failure: boolean;
    reason: string;
  };

  const rows: AuditRow[] = [];
  for (const p of inputs.roster) {
    const effectiveStart = inputs.memberStartByUser.get(p.user_id) ?? p.activity_started_at ?? null;
    const base = {
      userId: p.user_id,
      isTestMarker: testIds.has(p.user_id),
      activityStartedAt: p.activity_started_at,
      effectiveStart,
      seasonRest: false,
      personalRest: false,
      resultRowExists: inputs.statusByUserWeek.has(`${p.user_id}|${week.start_date}`),
      uwsStatus: inputs.statusByUserWeek.get(`${p.user_id}|${week.start_date}`) ?? null,
      challenge: false,
      success: false,
      failure: false,
    };
    if (!effectiveStart || effectiveStart.slice(0, 10) > week.end_date) {
      rows.push({ ...base, reason: "제외: 미시작(effectiveStart > 주차종료)" });
      continue;
    }
    if (inputs.seasonRestByUserSeason.has(`${p.user_id}|${week.season_key}`)) {
      rows.push({ ...base, seasonRest: true, reason: "시즌 휴식(user_season_statuses.status=rest)" });
      continue;
    }
    if (restUserIds.has(p.user_id)) {
      rows.push({ ...base, personalRest: true, reason: "개인 휴식(crew_personal_rest_periods overlap)" });
      continue;
    }
    const st = base.uwsStatus;
    if (st === "success") {
      rows.push({ ...base, challenge: true, success: true, reason: "성공(uws.status=success)" });
    } else {
      rows.push({
        ...base,
        challenge: true,
        failure: true,
        reason: base.resultRowExists
          ? `실패(uws.status=${st})`
          : "실패(uws 행 없음) ← ⚠ 미입력/집계전과 구분 불가",
      });
    }
  }

  const included = rows.filter((r) => !r.reason.startsWith("제외"));
  console.log("\n═══ 사용자 단위 audit (요약) ═══");
  console.log(`  로스터 전체            : ${inputs.roster.length}`);
  console.log(`  제외(미시작)           : ${rows.length - included.length}`);
  console.log(`  포함(소속 크루)        : ${included.length}  == memberCount ${metrics.memberCount} ? ${included.length === metrics.memberCount}`);
  const challengeN = metrics.growthChallengeCount ?? 0;
  console.log(`  시즌 휴식              : ${included.filter((r) => r.seasonRest).length}`);
  console.log(`  개인 휴식              : ${included.filter((r) => r.personalRest).length}`);
  console.log(`  성장 도전              : ${included.filter((r) => r.challenge).length}`);
  console.log(`  성장 성공              : ${included.filter((r) => r.success).length}`);
  console.log(`  성장 실패              : ${included.filter((r) => r.failure).length}`);

  // ⚠ 핵심 위험 지표 — "uws 행 없음"으로 실패 처리된 인원.
  const failNoRow = included.filter((r) => r.failure && !r.resultRowExists);
  const failWithRow = included.filter((r) => r.failure && r.resultRowExists);
  console.log("\n═══ ⚠ '결과 행 없음 = 실패' 노출도 ═══");
  console.log(`  실패 중 uws 행 있음    : ${failWithRow.length}  (실제 판정된 실패)`);
  console.log(`  실패 중 uws 행 없음    : ${failNoRow.length}  ← 미입력/집계전/대상자아님과 구분 불가`);
  if (challengeN > 0) {
    const pct = Math.round((failNoRow.length / challengeN) * 100);
    console.log(`  → 도전 인원의 ${pct}% 가 "행 없음"만으로 실패 처리됨`);
  }

  // ── 확정 aggregate override 대조(요구 4) ──
  //   override 는 성공/실패 split 만 조정하며 **특정 사용자에 귀속되지 않는다**.
  //   사용자별 재집계 합계와 표시값이 다를 수 있고, 그때 표시는 aggregate SoT 를 따른다(덮어쓰지 않음).
  const ov = inputs.successOverrideByWeekStart.get(week.start_date);
  console.log("\n═══ 확정 aggregate override 대조 ═══");
  if (ov == null) {
    console.log("  override 없음 — 표시값 = 사용자별 재집계값");
  } else {
    const perUserSuccess = included.filter((r) => r.success).length;
    const perUserFail = included.filter((r) => r.failure).length;
    console.log(`  weekly_league_success_overrides.growth_success = ${ov} (확정 aggregate SoT)`);
    console.log(`  사용자별 재집계 성공/실패                      = ${perUserSuccess}/${perUserFail} (감사용)`);
    console.log(`  화면 표시 성공/실패                            = ${metrics.growthSuccessCount}/${metrics.growthFailureCount}`);
    const diff = (metrics.growthSuccessCount ?? 0) - perUserSuccess;
    if (diff === 0) {
      console.log("  → 차이 없음");
    } else {
      console.log(`  → 차이 ${diff > 0 ? "+" : ""}${diff}명. 원인: 행정 공표 실측치(PMS) 반영 override 이며 개별 사용자에 귀속되지 않는다.`);
      console.log(`     표시는 aggregate SoT 를 우선한다 — 사용자별 재집계값으로 덮어쓰지 않는다.`);
      if (scope === "test") {
        console.log(`     ‼ 단, override 는 (org, week_start_date) 만 키로 갖고 scope 를 구분하지 않는다.`);
        console.log(`       현재 scope=test 인데 운영 코호트 실측치(${ov})가 테스트 코호트(${perUserSuccess + perUserFail}명)에 clamp 되어`);
        console.log(`       성공률이 왜곡될 수 있다(min(${ov}, nonRest) 규칙). → 별도 보고 대상.`);
      }
    }
  }

  console.log("\n═══ 사용자별 audit row (전체) ═══");
  for (const r of rows) {
    console.log(
      JSON.stringify({
        userId: r.userId,
        isTestMarker: r.isTestMarker,
        effectiveStart: r.effectiveStart,
        seasonRest: r.seasonRest,
        personalRest: r.personalRest,
        resultRowExists: r.resultRowExists,
        uwsStatus: r.uwsStatus,
        challenge: r.challenge,
        success: r.success,
        failure: r.failure,
        reason: r.reason,
      }),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
