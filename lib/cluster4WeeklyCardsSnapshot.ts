import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import { deriveRosterCardStats } from "@/lib/rosterCardStats";
import { computeScheduleReliabilityFromRows } from "@/lib/scheduleReliabilityCore";
import { tickTimeout } from "@/lib/supabaseQueryMeter";
import { runWithCohortRequestCache } from "@/lib/cohortRequestCache";

const ROSTER_STATS_TABLE = "cluster4_roster_card_stats";

// roster slim: 일정 신뢰도(%) — getScheduleReliabilityRateBatch 와 동일 코어/SoT(user_week_statuses
// + activity_started_at). nowMs = snapshot computed_at(읽기 시점이 아닌 snapshot 시점 기준 — slim 의
// 다른 시간기반 지표 elapsed_weeks 와 동일 시점). 산정 불가 = null. 실패는 조용히 null(슬림 미기록).
async function deriveScheduleRate(
  profileUserId: string,
  nowMs: number,
): Promise<number | null> {
  const [weekRes, profileRes] = await Promise.all([
    supabaseAdmin
      .from("user_week_statuses")
      .select("week_start_date,status")
      .eq("user_id", profileUserId),
    supabaseAdmin
      .from("user_profiles")
      .select("activity_started_at")
      .eq("user_id", profileUserId)
      .maybeSingle(),
  ]);
  if (weekRes.error || profileRes.error) return null;
  const result = computeScheduleReliabilityFromRows(
    (profileRes.data?.activity_started_at as string | null) ?? null,
    (weekRes.data ?? []) as Array<{ week_start_date: string | null; status: string }>,
    nowMs,
  );
  return result ? result.rate : null;
}

// roster slim: 전체기간 누적 Po.A/B/C = SUM(points/advantages/penalty)
// (adminMembersData.sumPointsForUsers 동일 기준). 단일 사용자라 페이지네이션 불필요(주차 수 << 1000).
// 실패 시 0/0/0(슬림은 best-effort — 읽기에서 drift 가드로 보정).
async function derivePointSums(
  profileUserId: string,
): Promise<{ poA: number; poB: number; poC: number }> {
  const { data, error } = await supabaseAdmin
    .from("user_weekly_points")
    .select("points,advantages,penalty")
    .eq("user_id", profileUserId);
  if (error || !data) return { poA: 0, poB: 0, poC: 0 };
  let poA = 0;
  let poB = 0;
  let poC = 0;
  for (const r of data as Array<{ points: number | null; advantages: number | null; penalty: number | null }>) {
    poA += r.points ?? 0;
    poB += r.advantages ?? 0;
    poC += r.penalty ?? 0;
  }
  return { poA, poB, poC };
}

// /admin/members 크루 목록 slim 캐시 동기 — snapshot 카드에서 파생된 스칼라를 같은 computed_at 으로
// 함께 저장한다(고객 SoT 동기). best-effort: 실패해도 snapshot 쓰기/본 요청을 깨뜨리지 않는다
// (읽기 측 getGrowthRosterBatchFast 가 computed_at 불일치/누락 시 fat 경로로 폴백하므로 정합 유지).
// 표가 아직 없으면(마이그레이션 미적용) 조용히 무시한다.
async function writeRosterCardStats(
  profileUserId: string,
  cards: Cluster4WeeklyCardDto[],
  computedAtIso: string,
): Promise<void> {
  const stats = deriveRosterCardStats(cards, computedAtIso.slice(0, 10));
  if (!stats) return; // 카드 비정상 → slim 미기록(읽기에서 fat 폴백)

  // 일정 신뢰도 + Po.A/B/C 는 카드(jsonb)가 아닌 별도 SoT(user_week_statuses·user_weekly_points)에서
  // 같은 snapshot 시점에 파생한다. 실패해도 본 upsert 를 막지 않는다(해당 컬럼만 null/0).
  const [scheduleRate, points] = await Promise.all([
    deriveScheduleRate(profileUserId, new Date(computedAtIso).getTime()),
    derivePointSums(profileUserId),
  ]);

  // 기존(성장/활동) 컬럼 — 이 확장 마이그레이션이 미적용이어도 항상 쓸 수 있어야 한다.
  const basePayload = {
    user_id: profileUserId,
    dto_version: WEEKLY_CARDS_DTO_VERSION,
    snapshot_computed_at: computedAtIso,
    success_weeks: stats.successWeeks,
    growable_weeks: stats.growableWeeks,
    elapsed_weeks: stats.elapsedWeeks,
    activity_available: stats.activityAvailable,
    activity_completed: stats.activityCompleted,
    updated_at: new Date().toISOString(),
  };
  // 확장(일정/포인트) 컬럼 포함 — 마이그레이션 적용 후 동작.
  const extendedPayload = {
    ...basePayload,
    schedule_rate: scheduleRate,
    po_a: points.poA,
    po_b: points.poB,
    po_c: points.poC,
  };

  const { error } = await supabaseAdmin
    .from(ROSTER_STATS_TABLE)
    .upsert(extendedPayload, { onConflict: "user_id" });
  if (!error) return;

  // 신규 컬럼 미존재(마이그레이션 미적용) 등으로 확장 upsert 가 실패하면, 기존 컬럼만이라도
  // 기록해 성장 slim(getGrowthRosterBatchFast)이 회귀 없이 동작하게 한다. 일정/포인트는 읽기에서
  // live 폴백되므로 정합은 유지된다.
  const { error: baseError } = await supabaseAdmin
    .from(ROSTER_STATS_TABLE)
    .upsert(basePayload, { onConflict: "user_id" });
  if (baseError) {
    console.warn("[weekly-cards][roster-stats] upsert skipped", {
      profileUserId,
      message: baseError.message,
    });
  } else {
    console.warn("[weekly-cards][roster-stats] extended columns missing → base-only written", {
      profileUserId,
      message: error.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// 주차 카드 사전 계산 결과(snapshot) 데이터 레이어.
//
// 읽기(readWeeklyCardsSnapshot): 화면 조회 API 전용 — 단일 SELECT, 무거운 계산 0.
// 쓰기(recomputeAndStoreWeeklyCardsSnapshot): 관리자 저장/sync/cron/lazy-fallback 시점에만.
//   계산 자체는 기존 getCluster4WeeklyCardsForProfileUser(실시간 계산 함수)를 그대로 재사용한다
//   (함수 삭제 금지 — snapshot 생성용으로 보존).
//
// dto_version: DTO 스키마가 바뀌면 이 상수를 올린다. 저장된 snapshot.dto_version 이 현재 값과
//   다르면 읽기에서 miss 로 취급 → 재계산. (구버전 직렬화 데이터를 그대로 내려주지 않기 위함.)
// ─────────────────────────────────────────────────────────────────────

// v2 (2026-06-01): career line DTO 에 sponsor-card 메타 6필드(companyName/companyLogoUrl/
//   supervisorName/supervisorDepartment/supervisorPosition/supervisorPhotoUrl) 추가.
//   기존 v1 snapshot 은 해당 필드가 없으므로 읽기에서 miss 처리 → 재계산되어 신필드가 채워진다.
// v3 (2026-06-02): "라인 개설" 기준을 cluster4_lines 행 존재(=any target)로 통일하면서 계산
//   결과(값)가 바뀐다 — competency 미개설 주차가 fail→not_applicable, 개설+미배정 synthetic fail
//   이 강화율 분모 A 에 반영, experience rating<=3 → fail. DTO 모양은 동일하나 값이 달라지므로
//   기존 v2 snapshot 을 stale(version_mismatch) 처리해 cron/lazy 가 신정책으로 재계산하게 한다.
//   (DB 백필 아님 — 파생 캐시 재생성. target 데이터는 건드리지 않는다.)
// v4 (2026-06-02): 라인 DTO 에 lineName 필드 추가(= 마스터 line_name, mainTitle 과 분리 축).
//   기존 v3 snapshot 의 cards 에는 lineName 키가 없으므로 stale(version_mismatch) 처리해
//   cron/lazy 가 재계산하면서 각 line 에 lineName 이 채워지게 한다. (DB 백필 아님 — 캐시 재생성.)
// v5 (2026-06-02): 카드에 위클리 평판/연계동료 상세 4필드 추가 — reputationSummary(fm=받은 평판
//   rating 합, fameScore/누적포인트와 별개), colleagueSummary, weeklyReputations[](인적사항 포함,
//   방어적 최대 4건), weeklyColleagues[](인적사항 포함). 기존 v4 snapshot 에는 이 키들이 없으므로
//   stale(version_mismatch) 처리 → cron/lazy 가 재계산하며 채운다. (DB 백필 아님 — 캐시 재생성.)
// v6 (2026-06-02): career 미배정 개설 라인 노출 정책 확정 — 개설됐지만 본인 미배정인 career 라인을
//   not_applicable(void)이 아니라 "강화 실패 + 내용(lineName/mainTitle/output/sponsor 메타/projectCode)"
//   으로 노출(openedFailLineDetail 의 career 분기). competency 만 보이드 유지. DTO 모양은 동일하나
//   career 미배정 라인의 값(status void→fail, 내용 채움)이 달라지므로 기존 v5 snapshot 을
//   stale(version_mismatch) 처리해 cron/lazy 가 신정책으로 재계산하게 한다. (DB 백필 아님 — 캐시 재생성.)
// v7 (2026-06-02): career 미선발/미배정 정책 재개정 — 개설 career 라인을 fail 이 아니라
//   not_applicable("해당 없음")로 되돌리되 개설 라인 content(mainTitle/outputLinks/outputImages/
//   projectCode/companyName 등)는 계속 노출한다(openedCareerLineDetail). status: v6 fail → v7 void,
//   enhancementStatus: v6 fail → v7 not_applicable. info/experience(fail+내용)·competency(보이드)는
//   불변. DTO 모양은 동일하나 career 미배정 라인의 값이 달라지므로 기존 v6 snapshot 을
//   stale(version_mismatch) 처리해 cron/lazy 가 신정책으로 재계산하게 한다. (DB 백필 아님 — 캐시 재생성.)
// v8 (2026-06-02): 4허브 라인 노출에 조직(org) 필터 추가 — 라인 org SoT=허브 마스터 organization_slug
//   (experience/competency/career). encre/oranke/phalanx=전용, common·info=공통 노출.
//   org 판정 불가 라인은 기본 숨김(fail-closed) — 단 Step 1(본인 실제 배정 라인)만 예외로 노출 허용,
//   Step 2(개설·미배정 openedByWeek)는 숨김. 사용자 org(user_profiles.organization_slug)와 불일치
//   라인은 본인 배정(Step 1)·미배정(Step 2) 모두 노출 제외(특히 Step 2 의 타 조직 라인 누수 차단 —
//   예: PHALANX 사용자에게 EC 라인). DTO 모양은 동일하나 카드의 lines 구성(타 조직/판정불가 라인 제거)이
//   달라지므로 기존 v7 snapshot 을 stale 처리해 cron/lazy 가 신정책으로 재계산하게 한다.
//   (DB 백필 아님 — 파생 캐시 재생성.)
// v9 (2026-06-02): org 판정 우선순위 변경 — line_code 토큰(BS>EC>OK>PX)이 마스터 organization_slug
//   보다 우선. 특히 line_code 에 'BS' 가 들어간 라인(EXBS-EL*, CPBS-*, WCBS-NL0000 등)은 master org 가
//   특정 조직이어도 무조건 common(전체 노출). v8(마스터 org 우선)에서는 이런 라인이 특정 조직에만
//   보였으므로 노출 집합이 달라진다(예: WCBS career 라인이 oranke 전용 → 전체 공통). DTO 모양은 동일하나
//   값(카드 lines 노출 구성)이 달라지므로 기존 v8 snapshot 을 stale 처리해 재계산하게 한다.
// v10 (2026-06-03): 카드 DTO 에 seasonKey(weeks.season_key) + isTransition 추가 — cluster-4-1
//   진입 화면 area-6-circles(주차 활용도/일정 신뢰도/시즌 성장률)를 weekly-cards 스냅샷 단일
//   출처로 현재 시즌 단위 집계하기 위함(lib/cluster4SeasonCircles.computeAreaSixCircles).
//   기존 v9 snapshot 의 cards 에는 seasonKey/isTransition 키가 없어 집계가 비게 되므로 stale
//   (version_mismatch) 처리 → cron/lazy 가 재계산하며 채운다. (DB 백필 아님 — 캐시 재생성.)
// v11 (2026-06-04): 라인 개설/강화상태 정책 재정비 —
//   ① 실무 경험 슬롯 정책: 필수 슬롯(1·2·3·5)은 라인 행이 없어도 항상 오픈/마감 간주 →
//      칸 없으면 fail placeholder(해당 없음 불가), 확장 슬롯(4)은 미개설 주차 not_applicable
//      placeholder. 휴식/전환 주차는 placeholder 전부 not_applicable.
//   ② competency 미배정 fail 의 표시축을 보이드로 변경(status fail→void, enhancementStatus=fail 유지).
//   ③ career 항상 6칸: 부족분을 보이드 placeholder 로 패딩(분모 cap 도 5→6).
//   ④ 강화율 A/B 를 카드 라인 칸의 enhancementStatus 에서 직접 파생(breakdownFromLines) —
//      A = not_applicable 제외 칸 수, B = success 칸 수. 칸 상태↔헤더/허브 수치 정합 보장.
//   ⑤ 적용 시점 분리(같은 날 후속 확정): 필수 슬롯 fail placeholder 는 "판정 완료(success/fail)
//      주차 + (테스트 사용자 전 주차 / 실사용자 CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM=2026-06-08
//      이후 주차)"에만 적용. 진행(running)/집계 중(tallying) 주차는 fail 선반영 금지 → 해당 없음,
//      실사용자 과거 주차도 해당 없음(누적 인정·시즌 성장률 보존). 주차 verdict/sync 도 동일 게이트.
//   DTO 모양은 동일하나 lines 구성(placeholder 추가)·강화율 값이 달라지므로 기존 v10 snapshot 을
//   stale(version_mismatch) 처리해 cron/lazy 가 신정책으로 재계산하게 한다. (DB 백필 아님 — 캐시 재생성.)
// v12 (2026-06-04): 관리(5) 슬롯 단계 게이트 — membership_level 일반/미확정(잠금) 사용자는
//   관리 슬롯을 분모 A·fail 칸에서 제외(해당 없음)한다. 고객앱이 관리 슬롯을 잠가 카드를 노출하지
//   않으므로, v11 까지는 "화면 카드 1개 · 헤더 총 2개"(예: T최수빈 봄 12주차 — 타 유저 배정
//   EXBS-EL0001 관리 라인이 synthetic fail 로 분모에 포함) 불일치가 났다. 잠금 사용자의
//   개설-미배정 관리 라인 synthetic fail 생략 + 관리 슬롯 placeholder 는 신정책 주차에도
//   not_opened(not_applicable). 심화/운영진은 v11 동작 유지. weekly-growth 분모 A 도 동일 게이트.
//   값(분모/칸 상태)이 달라지므로 기존 v11 snapshot 을 stale 처리해 재계산하게 한다.
// v13 (2026-06-04): 슬롯 미상(experience master 미연결) 라인 fail-closed — 고객앱 5슬롯 UI 에
//   렌더 불가한 라인(예: EX02A 레거시)이 본인 배정/개설-미배정 양쪽에서 분모 A 에만 들어가
//   "총 N개 > 표시 칸"이 되는 것을 차단. 카드 칸·weekly-growth 개설 distinct 모두 제외(+warn).
//   근본 해결은 라인 master 연결(데이터 정비) — 연결되면 자동 복귀. 값이 달라지므로 v12 → stale.
// v14 (2026-06-04): 실무 역량 단일 정규화 — 역량은 1인·1주차 항상 정확히 1칸(분모 A=1).
//   라인 N개 → success > pending > fail 우선 대표 1개로 fold, 라인 0개(미개설) → "강화 대기"
//   placeholder(competency_optional_pending — 선택 과제라 해당 없음 금지). 휴식/전환 주차만
//   기존 na placeholder(분모 제외). weekly-growth lineBreakdown.ability 도 동일 산식(A=1·B cap 1).
//   값(역량 분모/칸 수/상태)이 달라지므로 기존 v13 snapshot 을 stale 처리해 재계산하게 한다.
// v15 (2026-06-04): 포인트 표시 정책 통일 — points.shield = net(advantages−penalty),
//   points.lightning = −penalty (음수 표기). raw advantage 는 내부 집계 전용으로 고객 DTO 미노출.
//   별(points.star)은 불변. 값이 달라지므로 기존 v14 snapshot 을 stale 처리해 재계산하게 한다.
// v16 (2026-06-04): 누적 주차 SoT 통일 — accumulatedApprovedWeeks(및 displayWeekProgressLabel)
//   에서 전환 주차 success 를 제외. 이력서 카드(computeSeasonRecords)·cluster3(foldGrowthMetrics)
//   와 동일 규칙으로 통일(종전 cluster4 만 전환 success +1 → 8 vs 7 불일치). 값이 달라지므로
//   기존 v15 snapshot 을 stale 처리해 재계산하게 한다.
// v17 (2026-06-05): 레거시 통합 라인 정책 — 허브/라인 체계 적용 시점을 2026 여름 W1(2026-06-29)
//   로 통일(테스터 전 주차 예외 폐기). 레거시(그 이전 = 2026 봄 W16 이하 전체) 주차는:
//   ① 실무 경험 허브에 [통합] 주차 활동 내역 라인 1개만 렌더(마스터 매칭, slot 1, common).
//   ② 실무 정보/역량/경력 = 라인 없음(na placeholder) — slot placeholder/career 패딩/competency
//      fold 미적용. ③ 주차 verdict = 통합 라인 단일 기준(평점 4점 이상/미평가 = 성공, ≤3 = 실패,
//      개설+미배정 = 실패, 미개설 = not_applicable → uws 보존). ④ weekly-growth 집계도 동일
//      override. lines 구성·강화율·verdict 가 달라지므로 기존 v16 snapshot 을 stale 처리해
//      재계산하게 한다. (DB 백필 아님 — 캐시 재생성. 데이터는 별도 마이그레이션 스크립트.)
// v18 (2026-06-05): 레거시 통합 라인 정책 정정 — 강화 성공과 주차 성공 분리.
//   강화 성공 = 평점 4점 이상(기존 유지). 주차 성공 = 평점 4점 이상 AND 그 주차
//   point.check(user_weekly_points.points) >= 기준값(weeks.check_threshold ?? 30).
//   check 기준 미달 + enforced 면 verdict=fail(주차 실패)이지만 통합 라인 enhancementStatus
//   (강화)는 success 유지. experienceGrowth.checkGate(required/earned/passed/enforced)
//   append-only 추가. enforced = user_weekly_points.checks_migrated (행 단위 이관 provenance,
//   2026-06-05 개정 — 크기 휴리스틱 폐기). 미이관 행/행 부재는 비강제(기존 결과 보존),
//   이관 파이프라인이 행을 true 로 기록하면 그 (사용자, 주차)만 자동 강제.
//   advantage/penalty 는 게이트 미사용. uws 는 불변(레거시 sync 보호 유지) — read-time 판정.
//   userWeekStatus/verdict 가 달라지므로 기존 v17 snapshot 을 stale 처리해 재계산하게 한다.
// v19 (2026-06-08): 공식 휴식 주차 판정 정정 (growthCore.resolveWeekResultStatus).
//   종전에는 weekIsOfficialRest 를 현재 주차 분기에서만 적용해, 과거 공식 휴식 주차 중
//   user_week_statuses 행이 official_rest 로 기록되지 않은 주차(예: uws 미생성·미공표)가
//   tallying(집계 중)/fail 로 잘못 빠졌다(예: 2026 봄 14주차). 이제 공식 휴식 주차는 현재/과거
//   무관하게 official_rest 로 판정한다(개인 휴식보다 우선). 또한 growthResolve.buildResolvedWeeks
//   에서 weekIsOfficialRest 가 전환 주차를 포함하지 않도록 명시 제외(isSeasonRuleRestForWeekStart
//   가 describeWeekByStartMs.isOfficialRest=official_rest∨transition 를 재사용하던 누수 차단).
//   카운트(approved/failed/rest·시즌 성장률)는 불변(tallying·official_rest·transition 모두 집계
//   제외) — userWeekStatus/statusLabel(화면 표시)만 달라지므로 기존 v18 snapshot 을 stale 처리해
//   재계산하게 한다.
// v20 (2026-06-10): 연계동료/평판 인적사항(Cluster4PersonProfileDto)의 학교/학과 source 정정 —
//   user_profiles.school_name/department_name 단독에서 user_educations(대표 학력) 우선 →
//   user_profiles 폴백으로 변경(buildPersonProfileMap). PMS 이관 사용자는 department_name 이 NULL
//   이고 실제 학과는 user_educations.major_name_1 에만 있어, weeklyColleagues[].colleagueProfile.
//   department(연계동료 모달 "학과")가 "-"로 비던 버그. weeklyReputations/weeklyColleagues 가
//   snapshot.cards 에 직렬화되므로, 기존 v19 snapshot 의 colleagueProfile.department 는 여전히 NULL.
//   v19→v20 stale(version_mismatch) 처리로 cron/lazy 가 재계산하며 educations 값으로 채운다.
//   (DB 백필 아님 — 파생 캐시 재생성. user_educations 자체는 건드리지 않는다.)
// v21 (2026-06-15): 신정책(2026-summer W1+) 주차에도 check 게이트 적용 — 주차 성공 = 필수 슬롯
//   pass AND user_weekly_points.points >= 기준값(org_week_thresholds → weeks.check_threshold → 30).
//   레거시(< 2026-summer W1)는 무변경(enforced=checks_migrated 유지). 신정책은 enforced=true 고정
//   (그 주 프로세스 체크 포인트 미달 = 주차 인정 실패). DTO 모양 동일(experienceGrowth.checkGate
//   는 기존 필드 — 종전 신정책 주차에서 null 이던 값이 채워짐)이나 신정책 주차의 verdict/주차상태
//   (success↔fail)·checkGate 값이 달라지므로 기존 v20 snapshot 을 stale(version_mismatch) 처리해
//   재계산하게 한다. (DB 백필 아님 — 파생 캐시 재생성. 레거시 주차 값은 불변.)
// v22 (2026-06-20): 고객 표시용 displayLineCode 신설(registration/master 공식 코드 우선,
//   information·미연결은 null·고객 화면 숨김). 내부 lineCode 는 매칭용으로 유지. 기존 v21
//   snapshot 은 displayLineCode 필드가 없으므로 stale(version_mismatch) 처리해 재계산하게 한다.
// v23 (2026-06-20): 현재 시즌이 시즌 휴식(seasonal_rest)인 회원의 활동주차를 휴식(개인) 카드로
//   채우는 정책 추가(빈 화면 해소). 카드 출력이 바뀌므로 버전 bump → 전원 lazy 재계산으로 수렴.
// v24 (2026-06-20): information 라인 displayLineCode 를 line_registrations(hub='info') 운영자 코드
//   (IFBS-NN000X, /admin/lines/info SoT)로 채움(종전 null → 내부코드 노출 방지). 내부 lineCode 는
//   매칭용 유지. 카드 출력(displayLineCode)이 바뀌므로 bump → 기존 snapshot stale → lazy 재계산 수렴.
// v25 (2026-06-23): 카드 역할 배지(roleLabel)를 "현재 등급"에서 "그 카드 당시 단계"로 전환.
//   SoT = user_position_histories(주차단위 PMS 이력). PMS 이력 없는 시즌만 현재 membership/role
//   fallback(무회귀). 과거 카드가 더 이상 현재 단계로 덮이지 않는다.
// v26 (2026-06-23): roleLabel 산정을 시즌 대표(resolveSeasonPosition)에서 "주차 단위 정확값"으로
//   세분화. 한 시즌 안에서도 주차별 단계가 다르면 카드마다 다르게 표시된다(예: W1~4 일반 / W5~ 심화).
//   우선순위: ① 그 주차 행(week_start_date 1:1) → ② 같은 시즌 gap 주차는 시즌 대표(이력서와 동일
//   SoT·산정) → ③ PMS 없는 시즌은 현재값. v25(시즌 일괄) 대비 같은 시즌 내 주차 값이 달라지므로
//   기존 snapshot 을 stale(version_mismatch) 처리해 재계산한다.
// v27 (2026-06-24): 실무 정보(info) 라인 개설 신호를 라인행 존재 기준으로 확장 — 대상 크루 0명
//   (cluster4_line_targets 0건)이어도 org-visible active info 라인은 고객 카드에 "개설(미배정=강화
//   실패, 내용 노출)"로 포함한다(per-activity 모델). 종전에는 openedByWeek/lineOrgById 가
//   targetRows(타깃 join)에서만 만들어져 타깃 0건 info 라인(예: 위즈덤/캘린더 0명 개설)이 누락됐다.
//   fetchActiveInfoLinesByWeek 로 라인행을 직접 보강(cluster4_line_targets 무변경 — sentinel 미사용).
//   카드 lines 구성·강화율(breakdownFromLines A)이 달라지므로 기존 v26 snapshot 을
//   stale(version_mismatch) 처리해 재계산하게 한다. (DB 백필 아님 — 파생 캐시 재생성.)
// v28 (2026-06-26): 카드 DTO 에 experienceRate{count,total,rate}(실무 경험 허브 강화율)를 추가한다.
//   breakdownFromLines 의 experience 칸 단일 출처 — 레거시(2026 여름 W1 이전) 주차는 [통합] 주차
//   활동 내역(통합 임시 라인)이 experience 라인으로 집계에 실려 total 에 그대로 포함된다("봄 시즌까지
//   통합 임시 라인을 오픈 라인으로 인정" 정책). 프론트 Detail Log/카드 본문이 이 값을 단일 출처로 소비.
//   기존 v27 snapshot 에는 experienceRate 필드가 없으므로 stale(version_mismatch) 처리해 재계산한다.
// v29 (2026-06-26): detailLogMessageMeta append-only. Detail Log message branching
// uses snapshot-baked previous/current status and capped success streak.
// v30 (2026-06-26): 카드 DTO 에 actLogs[](Detail Log "수행 내역")를 append-only 추가.
//   1차 범위 = 수행/적립된 액트만(미수행/미적립 예정·미스 row 제외 — 후속 Phase). SoT=
//   process_point_awards(사용자·주차 적립 원장) → regular=process_acts(+line_groups)·
//   irregular=process_irregular_acts JOIN. 포인트=원장 적립값(수동 override 포함). 변동>부분
//   대상자 필터는 원장 생성(processPointAccrual: recipients matched / manual_grant target)에서
//   이미 적용 — 카드는 user_id 원장만 본다(demoUserId 테스트도 그 사용자 원장 그대로). 주차 배분=
//   원장(iso_year,iso_week)→weeks→start_date 로 card.startDate 에 매칭(합성 weekId 안전). 기존
//   v29 snapshot 에는 actLogs 키가 없으므로
//   stale(version_mismatch) 처리 → cron/lazy 재계산하며 채운다(DB 백필 아님 — 파생 캐시 재생성).
//   ⚠ 무효화 경로: process_point_awards 적립/회수(processPointAccrual.applyAward/revokeForAct)가
//   이미 invalidateWeeklyCardsForUsers 를 호출 — v30 부터 그 재계산이 actLogs 까지 갱신한다.
// 2026-06-28 (버전 bump 없음 — 의도적): computeWeeklyCards 가 현재 시즌 카드 골격을
//   user_week_statuses 가 아닌 user_season_statuses(시즌 명부) 참여 row 기준으로도 생성하도록
//   확장했다(활동 uws 0 인 신규 참여자에게 현재 시즌 카드 노출). DTO shape 은 불변(카드 집합만
//   확장)이라 dto_version 은 그대로 둔다. 적용 시점이 2026 여름 W1(2026-06-29 월) = 주차 경계와
//   겹치므로, 기존 snapshot 은 그날 첫 조회에서 boundary-stale(computed_at < 현재 주차 시작)로
//   "블로킹 lazy 재계산"되어 즉시 신코드(여름 카드)로 수렴한다. version bump 을 하면 그 경로가
//   version_mismatch(비블로킹 bg)로 선점되어 첫 조회가 구 snapshot(여름 카드 없음)을 보여주고
//   둘째 조회에서야 갱신되므로, 시즌 시작일에 한해 오히려 손해다 → bump 하지 않는다. 신규 유저는
//   miss→lazy 로 즉시 생성된다. (참고: 직전 버전 히스토리는 v30.)
// v31 (2026-07-01): breakdownFromLines 실무 정보(info) 집계를 활동유형(activityTypeKey)당 1칸으로
//   dedupe. 고객 정보 허브는 유형당 카드 1칸만 렌더(findCluster4Line first-match)하므로, 같은 활동유형에
//   라인이 2개 이상(예: 정규 + 테스트 calendar) 있으면 "총 N개"(=info denominator)·주차 성장률 분모가
//   화면 칸 수보다 부풀었다(예: info 4 인데 화면 3칸, 성장률 1/5 대신 1/4 이어야 함). info denominator/
//   numerator 와 growthDenominator(=4허브 합) 가 함께 바뀌므로 기존 v30 snapshot 을
//   stale(version_mismatch) 처리해 cron/lazy 가 재계산하게 한다. (DB 백필 아님 — 파생 캐시 재생성.)
// v32 (2026-07-06): 레거시 주차(2026 여름 W1 이전) 실무경험/실무역량 표시 정책 변경(Phase 3) — granular
//   경험 라인이 있는 레거시 주차는 [통합] 대신 granular 표시 + 5슬롯(여름 규칙 미러링), 역량은 라인 보유
//   주차에 fold(1칸). granular 없는 레거시 주차는 불변([통합] 단일). 실사용자는 레거시 granular 부재라
//   무변경이지만, 그런 라인 보유(테스트/향후 운영) 유저 카드 값이 바뀌므로 v31 snapshot 을 stale 처리해
//   재계산. (강화율 SoT 통일로 카드=성장 동일 소스라 성장화면도 함께 수렴.)
// v33 (2026-07-06): 실무 경험 강화상태 팀 스코프 fail-closed. (A) 미배정 synthetic fail 은 "본인 소속팀에
//   개설된" 라인만 대상 — 팀 미지정 라인(team_id=null, 예: QA 검증 잔재 EX-QAOP-*)·타팀 라인·본인 팀
//   미해석 유저는 제외(해당 없음). 과거 fail-open(어느 한쪽 team null 이면 통과)이 팀 없는 라인을 전
//   사용자 강화 실패로 흘리던 버그. (B) 필수 슬롯(1·2·3·5) 빈칸 placeholder 의 required_fail 은 내 팀이
//   그 슬롯을 개설한 확정 주차에만 — 팀 미개설 슬롯은 해당 없음(케이스 3·4). experience fail↔해당없음 이
//   달라지므로 v32 snapshot 을 stale(version_mismatch) 처리해 재계산. (파생 캐시 재생성 — DB 백필 아님.)
// v34 (2026-07-06): 실무 경험 '미평가' 라인을 강화 실패 대신 강화 대기(pending)로 표시. 대상자로 선정됐으나
//   평점이 아직 입력되지 않은(cluster4_experience_line_evaluations.rating = 0 = 1~10 척도의 미평가 placeholder,
//   evaluated_by=null) 라인이 마감 후 rating<=3 규칙에 걸려 '강화 실패'로 오표시되던 버그. rating 0 은 미평가로
//   보아 pending(experience_unevaluated_after_deadline), 실제 평점 1~3 → fail, 4 이상 → success 로 확정.
//   (소급 개설/과거 주차도 평가 입력 전에는 강화 대기 유지.) 강화율 A/B 불변(pending·fail 모두 A 포함, B 제외).
//   experience fail↔pending 표시가 달라지므로 v33 snapshot 을 stale 처리해 재계산. (파생 캐시 재생성 — DB 백필 아님.)
// v35 (2026-07-07): 레거시 주차 granular 실무 경험 라인이 rating>=4(강화 성공)인데 '강화 실패'로 표시되던 버그.
//   원인: legacySubmissionBasedEnhancement override 가 experience 를 제외하지 않아, granular 경험 라인
//   (experienceAsSummer=true, 여름 rating 정책 대상)의 rating 기반 enhancementStatus(success)를 제출 기반
//   base.status(미기입=fail)로 덮었다. 그 결과 enhancementStatus="fail" 인데 experienceRating=7·
//   enhancementReason="target_exists_after_deadline"(computeCluster4Enhancement 의 success 사유)라는 불가능한
//   조합이 스냅샷에 저장(T안건우 봄 W10 EXOK-EN0002~0004). experience 를 override 에서 제외 → 경험은 평점이 SoT
//   (rating<=3 fail / >=4 success / 미평가 pending). experience fail↔success 표시가 달라지므로 v34 snapshot 을
//   stale(version_mismatch) 처리해 재계산. (파생 캐시 재생성 — DB 백필 아님.)
// v36 (2026-07-13): 실무 역량(competency) 표시 정책 — 분모(1)는 "이 주차에 실제 개설된 역량 라인의
//   대상자"에게만 생성한다. (A) 비휴식·비레거시 주차에 무조건 붙던 합성 placeholder(미확정=대기/확정=실패,
//   분모 A=1)를 폐지 → 라인 0개(개설 0건 또는 비대상자)는 not_applicable(0/0). (B) Step 2 의 개설+본인
//   미배정 역량 synthetic fail(openedCompetencyFailLineDetail, 분모 A 포함)도 폐지 → 비대상자 0/0. 결과:
//   개설 0건=모두 0/0, 첫 개설 시 대상자만 0/1(→완료 1/1)·비대상자 0/0. 개설/완료판정/포인트 로직 불변,
//   표시(분모 생성) 기준만 변경. 역량 A/B 가 달라지므로 v35 snapshot 을 stale(version_mismatch) 처리해
//   재계산. (파생 캐시 재생성 — DB 백필 아님. info/experience/career 무영향.)
// v37 (2026-07-13 v2): 실무 역량 표시 정책 재정정 — 분모 게이트를 "본인 대상 여부"가 아니라 "주차 단위
//   개설 존재 여부"(hasCompetencyOpeningForWeek)로 변경. v36 은 비대상자를 0/0 으로 내렸으나, 올바른
//   정책은 "그 주차에 org-visible 역량 라인이 하나라도 개설되면 분모 1을 전 크루 공통 활성화"다:
//     · 개설 0건        → 전원 not_applicable(0/0)
//     · 개설 있음+비대상 → placeholder(미확정=대기/확정=실패) = 0/1  ← v36 에서 잘못 0/0 이던 것
//     · 개설 있음+대상   → 본인 라인 fold = 0/1(미완료) 또는 1/1(완료)
//   대상 여부는 분자(성공) 기준일 뿐 분모 생성 기준이 아니다. competency A/B 가 달라지므로 v36 snapshot 을
//   stale(version_mismatch) 처리해 재계산. (파생 캐시 재생성 — DB 백필 아님. info/experience/career·포인트 무영향.)
// v38 (2026-07-13): 포인트 C 부호 정규화 — points 에 pointC(penalty magnitude, ≥0 양수) 필드 추가.
//   방패(shield)=최종 Point B(advantages−pointC)로 의미 불변. lightning(=−pointC)은 하위호환용
//   deprecated 로 병기(고객 앱 소비처 pointC 이전 후 별도 정리로 제거 예정). 새 필드가 생겨
//   기존 v37 snapshot 을 stale(version_mismatch) 처리해 재계산(pointC 채움)한다. 값(방패/별)은 불변.
// v39 (2026-07-14): 승인된 개인 휴식(vacation_requests.status='approved')을 주차 판정에 연결.
//   그동안 /admin/rest-management 승인은 vacation_requests 만 갱신하고 cluster4 판정 입력엔
//   아무것도 쓰지 않아, 승인된 휴식 주차가 카드/성장/스냅샷 어디에도 반영되지 않았다(통신 끊김).
//   공통 SoT loader(lib/approvedRestWeeks.getApprovedRestWeekStarts)를 buildResolvedWeeks 에
//   주입해, 승인된 휴식 주차의 활동주차를 기존 personal_rest 파이프라인(휴식(개인) 배지·void·
//   게이지0·강화 해당없음)으로 강제한다(공식휴식/전환 제외·기존 user_week_statuses personal_rest
//   와 union). 승인된 주차의 resultStatus(→userWeekStatus/statusLabel) 및 강화/성장률 분모가
//   달라지므로 기존 v38 snapshot 전량을 stale(version_mismatch) 처리해 재계산한다. 이후 개별
//   승인/승인취소/반려 시엔 해당 유저 snapshot 만 타깃 무효화(invalidateWeeklyCardsForUsers).
//   (파생 캐시 재생성 — DB 백필 아님. 미승인 유저·비휴식 주차 값 불변.)
// v41(2026-07-17): 실무 경험 강화율 산식 변경 — breakdownFromLines 가 "본인 배정 오픈 라인"만
//   집계(개설됐으나 본인 미배정=타인 라인은 분모/실패 제외). 사용자별로 카테고리에 서로 다른 라인이
//   개설되면 기존 v40 은 타인 라인까지 분모에 세어 강화율이 희석됐다(예: 도출 4라인 중 1배정인데 n/4).
//   experience 분모/분자가 달라지므로 v40 snapshot 전량을 stale(version_mismatch)로 재계산한다.
//   (파생 캐시 재생성 — uws 판정/원장 불변. 단일라인 카테고리·미개설 유저 값 불변.)
// v42(2026-07-17): 실무 경험 강화율을 "유형 슬롯" 기준으로 재정의(공통 resolver experienceSlotFold).
//   v41 은 비배정 오픈 유형을 분모에서 "제외"했으나, 요구 정책은 오픈+비대상=강화 실패(분모 포함).
//   분모 = 오픈된 경험 유형 수(오픈+대상=성공/오픈+비대상=실패/미오픈=제외), 분자 = 본인 배정·성공 유형 수.
//   같은 유형 다중 라인은 1칸으로 접어 희석 제거. 예: 도출/견문/관리 성공 + 분석 오픈·비대상 실패 +
//   확장 미오픈 → 3/4 = 75%(관리자 라인 강화 내역·크루 카드 배지·허브 강화율 모두 동일). experience
//   분모/분자가 달라지므로 v41 snapshot 전량을 stale(version_mismatch)로 재계산한다(백필 필요).
//   (파생 캐시 재생성 — uws 판정/포인트/원장 불변.)
// v43(2026-07-17): actLogs 에서 라인 강화 지급 원장(source='line') 제외 — 액트 체크 기록만 남긴다.
//   loadActLogsByStartDate 가 user_id 로만 필터해 2026-07-13 도입된 source='line' 원장까지 읽었고,
//   그 행은 irregular 로 오인돼 ref_id(=line_id) JOIN 실패 → actName/kind="" · occurredAt=null 인
//   빈 행이 되어 Detail Log 액트 탭에 "-" 로 노출됐다(실측: 한 사용자 24행 중 8행). 이 행들은
//   "라인 강화 내역" 탭(getCrewWeekLineSummary)이 다루는 데이터다.
//   ⚠ **bump 필수** — 기존 v42 snapshot 의 cards[].actLogs 에 그 빈 행이 이미 baking 되어 있어,
//   코드만 고치면 재계산 전까지 계속 보인다(shape 이 아니라 내용이 바뀌는 경우라 boundary-stale 로는
//   부족하다). v42 전량 stale(version_mismatch) → cron/lazy 재계산으로 수렴.
//   (파생 캐시 재생성 — 원장/포인트 합계/uws 판정 불변. 액트 탭 목록에서 빈 행만 사라진다.
//    포인트 카드 합계는 user_weekly_points SoT 라 actLogs 필터와 무관 — 값 변화 없음.)
export const WEEKLY_CARDS_DTO_VERSION = 43;

const TABLE = "cluster4_weekly_card_snapshots";

// 읽기 결과를 구분형으로 반환한다 — 호출부가 "절대 무거운 계산 없이" 분기할 수 있게.
//   hit   : 정상(현재 버전 + fresh). 그대로 노출.
//   stale : 행은 있으나 (is_stale=true) 또는 (dto_version 불일치). cards 배열은 사용 가능하므로
//           graceful 하게 노출하고, cron 이 재생성하게 둔다(버전 불일치도 구 카드를 빈 화면보다 우선).
//   miss  : 행 없음(신규 유저) 또는 cards 손상. 노출할 게 없음.
//   error : SELECT 실패(일시 오류/권한/테이블). 노출할 게 없음 — 무거운 계산으로 빠지지 않는다.
export type WeeklyCardsSnapshotOutcome =
  | { status: "hit"; cards: Cluster4WeeklyCardDto[]; computedAt: string }
  | {
      status: "stale";
      cards: Cluster4WeeklyCardDto[];
      computedAt: string;
      reason: "is_stale" | "version_mismatch";
    }
  | { status: "miss" }
  | { status: "error"; message: string };

// 저장된 snapshot 1행을 읽는다(단일 SELECT). 정상 시 쿼리 1개. 무거운 계산은 절대 하지 않는다.
export async function readWeeklyCardsSnapshot(
  profileUserId: string,
): Promise<WeeklyCardsSnapshotOutcome> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("cards,dto_version,is_stale,computed_at")
    .eq("user_id", profileUserId)
    .maybeSingle();

  if (error) {
    // ⚠ 조회 실패를 miss 로 강등하지 않는다 — miss 로 보면 (lazy 허용 시) 무거운 계산으로 빠진다.
    tickTimeout(); // 포화 계측 — 단일 snapshot 조회 실패(timeout/connection)
    console.warn("[weekly-cards][snapshot] read error", {
      profileUserId,
      message: error.message,
    });
    return { status: "error", message: error.message };
  }
  if (!data) return { status: "miss" };

  const row = data as {
    cards: unknown;
    dto_version: number;
    is_stale: boolean;
    computed_at: string;
  };

  // cards 가 배열이 아니면(손상) 노출 불가 → miss.
  if (!Array.isArray(row.cards)) return { status: "miss" };
  const cards = row.cards as Cluster4WeeklyCardDto[];

  // 버전 불일치: 구 카드(배열)는 사용 가능하므로 stale 로 노출(빈 화면 방지) + cron 이 재생성.
  if (row.dto_version !== WEEKLY_CARDS_DTO_VERSION) {
    return { status: "stale", cards, computedAt: row.computed_at, reason: "version_mismatch" };
  }
  if (row.is_stale) {
    return { status: "stale", cards, computedAt: row.computed_at, reason: "is_stale" };
  }
  return { status: "hit", cards, computedAt: row.computed_at };
}

// 다건 배치 읽기 — 사용자별 1쿼리(.eq().maybeSingle()) 대신 .in() 단일 SELECT 로 N→1 축소.
//   readWeeklyCardsSnapshot 과 동일한 판정 로직(version_mismatch/is_stale/손상→miss)을 적용한다.
//   결과 Map 에 없는 user_id = 행 없음 → 호출부가 miss 로 간주한다(여기서는 키를 넣지 않음).
//   IN() URL 길이 방어를 위해 청크로 끊는다. 무거운 계산은 절대 하지 않는다(조회 전용).
export async function readWeeklyCardsSnapshotBatch(
  profileUserIds: string[],
): Promise<Map<string, WeeklyCardsSnapshotOutcome>> {
  const out = new Map<string, WeeklyCardsSnapshotOutcome>();
  const ids = Array.from(new Set(profileUserIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return out;

  // fat cards jsonb(사용자당 수십 KB)를 함께 SELECT 하므로 청크가 크면 Postgres statement timeout
  // 에 걸린다(전체 로스터 200×수십KB = 수 MB/쿼리). 50 으로 낮춰 timeout 위험을 줄인다. 실패 청크는
  // 아래에서 status:"error" 로 표기되어 호출부가 fail-soft 처리한다(무거운 실시간 폴백으로 빠지지 않음).
  const ID_CHUNK = 50;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("user_id,cards,dto_version,is_stale,computed_at")
      .in("user_id", chunk);
    if (error) {
      // 조회 실패한 청크는 전원 error 로 표기(miss 로 강등하지 않음 — 조회 전용 정책 유지).
      tickTimeout(); // 포화 계측 — 배치 청크 조회 실패(statement timeout 등)
      console.warn("[weekly-cards][snapshot] batch read error", {
        count: chunk.length,
        message: error.message,
      });
      for (const id of chunk) out.set(id, { status: "error", message: error.message });
      continue;
    }
    for (const row of (data ?? []) as Array<{
      user_id: string;
      cards: unknown;
      dto_version: number;
      is_stale: boolean;
      computed_at: string;
    }>) {
      if (!Array.isArray(row.cards)) {
        out.set(row.user_id, { status: "miss" });
        continue;
      }
      const cards = row.cards as Cluster4WeeklyCardDto[];
      if (row.dto_version !== WEEKLY_CARDS_DTO_VERSION) {
        out.set(row.user_id, {
          status: "stale",
          cards,
          computedAt: row.computed_at,
          reason: "version_mismatch",
        });
      } else if (row.is_stale) {
        out.set(row.user_id, {
          status: "stale",
          cards,
          computedAt: row.computed_at,
          reason: "is_stale",
        });
      } else {
        out.set(row.user_id, { status: "hit", cards, computedAt: row.computed_at });
      }
    }
  }
  return out;
}

// 실시간 계산(기존 함수) → snapshot upsert. 계산 결과 배열을 그대로 반환한다.
// 관리자 저장/sync 훅, cron, 그리고 읽기 경로의 lazy-fallback(미존재 시 1회)에서 호출한다.
// 계산이 실패하면 throw — 호출부(라우트)가 기존 에러 형식으로 변환한다.
export async function recomputeAndStoreWeeklyCardsSnapshot(
  profileUserId: string,
): Promise<Cluster4WeeklyCardDto[]> {
  const cards = await getCluster4WeeklyCardsForProfileUser(profileUserId);

  const computedAt = new Date().toISOString();
  const { error } = await supabaseAdmin.from(TABLE).upsert(
    {
      user_id: profileUserId,
      cards,
      card_count: cards.length,
      dto_version: WEEKLY_CARDS_DTO_VERSION,
      is_stale: false,
      computed_at: computedAt,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    // 저장 실패해도 계산된 카드는 반환(이번 요청은 응답 가능). 다음 cron 이 재시도.
    console.warn("[weekly-cards][snapshot] upsert failed (returning computed cards)", {
      profileUserId,
      message: error.message,
    });
  } else {
    // roster slim 캐시 동기(같은 computed_at). best-effort — 실패해도 본 쓰기 영향 없음.
    await writeRosterCardStats(profileUserId, cards, computedAt);
  }

  return cards;
}

// ─────────────────────────────────────────────────────────────────────
// Cron/배치 재계산: is_stale=true 또는 computed_at 이 오래된(due) 기존 snapshot 을
// 오래된 순으로 maxUsers 만큼 재계산한다. 조회 API 는 절대 이 경로를 타지 않는다.
//
// 안전: 사용자별 재계산 실패는 격리(로그+계속)하며, 실패 시 upsert 가 일어나지 않아
//   기존 snapshot 이 그대로 유지된다(정책: Cron 실패 시 기존 값 보존).
// 신규 사용자(행 없음)는 여기서 다루지 않는다 — 백필/lazy 가 담당.
// ─────────────────────────────────────────────────────────────────────
export type SnapshotRecomputeResult = {
  scanned: number;
  recomputed: number;
  failed: number;
  failedUserIds: string[];
  durationMs: number;
};

export async function recomputeStaleOrDueSnapshots(opts: {
  maxUsers?: number;
  dueOlderThanMs?: number;
  concurrency?: number;
  now?: number;
} = {}): Promise<SnapshotRecomputeResult> {
  const now = opts.now ?? Date.now();
  const maxUsers = opts.maxUsers ?? 200;
  const dueOlderThanMs = opts.dueOlderThanMs ?? 60 * 60 * 1000; // 기본 1시간
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const t0 = Date.now();
  const dueThresholdIso = new Date(now - dueOlderThanMs).toISOString();

  // 재계산 후보: stale 이거나 / computed_at 이 오래된(due) 행 / dto_version 불일치(스키마 변경 후
  // 아직 신버전으로 재생성 안 된 행 — computed_at 이 최신이어도 반드시 잡아야 화면이 신버전으로 수렴).
  // 오래된 순(asc)으로 우선.
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("user_id,computed_at,is_stale")
    .or(
      `is_stale.eq.true,computed_at.lt.${dueThresholdIso},dto_version.neq.${WEEKLY_CARDS_DTO_VERSION}`,
    )
    .order("computed_at", { ascending: true })
    .limit(maxUsers);

  if (error) {
    console.warn("[weekly-cards][snapshot] recompute candidate scan failed", error.message);
    return { scanned: 0, recomputed: 0, failed: 0, failedUserIds: [], durationMs: Date.now() - t0 };
  }

  const userIds = ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  const failedUserIds: string[] = [];
  let recomputed = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < userIds.length) {
      const uid = userIds[cursor++];
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(uid);
        recomputed++;
      } catch (e) {
        // 실패 격리: 기존 snapshot 은 보존(upsert 미수행). 다음 run 에서 재시도.
        failedUserIds.push(uid);
        console.warn("[weekly-cards][snapshot] recompute failed (keeping old)", {
          userId: uid,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, userIds.length) }, () => worker()),
  );

  return {
    scanned: userIds.length,
    recomputed,
    failed: failedUserIds.length,
    failedUserIds,
    durationMs: Date.now() - t0,
  };
}

// 다건 변경(공표/라인 CRUD/프로젝트/마스터/휴식정책)용 정책 일원화 진입점.
//   - 대상 0명         → no-op
//   - 대상 ≤ THRESHOLD → 요청 내 즉시 병렬 recompute(제한 concurrency) → 응답 시점에 이미 fresh
//   - 대상 >  THRESHOLD → markStaleMany(즉시, reads 는 구값 노출·계산 0) + after()로 응답 후
//                         백그라운드 recompute(cron 없이 수초 내 반영). after 불가 컨텍스트면 stale-only.
// 조회 API 는 어느 경우에도 계산하지 않는다(snapshot-only 불변). 직렬 N명 recompute 금지(≤THRESHOLD 만 병렬).
export const SNAPSHOT_RECOMPUTE_THRESHOLD = 10;

export async function invalidateWeeklyCardsForUsers(
  userIds: string[],
): Promise<{ mode: "none" | "immediate" | "background" | "stale_only"; count: number }> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return { mode: "none", count: 0 };

  if (ids.length <= SNAPSHOT_RECOMPUTE_THRESHOLD) {
    await recomputeWeeklyCardsSnapshotsForUsers(ids);
    console.log("[weekly-cards][snapshot] invalidate immediate", `count=${ids.length}`);
    return { mode: "immediate", count: ids.length };
  }

  // 많음: 먼저 stale 로 막아 조회가 구값을 즉시 노출(계산 0). 그다음 백그라운드 재계산.
  await markWeeklyCardsSnapshotStaleMany(ids);
  try {
    // next/server 의 after(): 요청 컨텍스트에서만 동작. 응답 후 같은 인스턴스에서 실행 → cron 불필요.
    const { after } = await import("next/server");
    after(async () => {
      try {
        await recomputeWeeklyCardsSnapshotsForUsers(ids);
        console.log("[weekly-cards][snapshot] invalidate background done", `count=${ids.length}`);
      } catch (e) {
        console.warn("[weekly-cards][snapshot] background recompute failed (stale kept, cron recovers)", {
          count: ids.length,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
    return { mode: "background", count: ids.length };
  } catch (e) {
    // 요청 컨텍스트 밖(after 불가) → stale 만 유지, daily cron 이 복구.
    console.warn("[weekly-cards][snapshot] after() unavailable → stale-only (cron recovers)", {
      count: ids.length,
      message: e instanceof Error ? e.message : String(e),
    });
    return { mode: "stale_only", count: ids.length };
  }
}

// 특정 사용자들의 snapshot 을 즉시 재계산·저장한다(관리자 저장 직후 변경 즉시 반영용).
//   mark-stale 만 하면 lazy-on-read 또는 cron 에 의존하는데, snapshot-only(DISABLE_LAZY) 런타임이나
//   다음 조회가 늦어지는 경우 옛값이 계속 노출된다. 저장 시점에 바로 재계산해 그 race 를 제거한다.
// 실패는 사용자별로 격리(로그+계속) — 실패한 사용자는 markStale 상태로 남아 cron 이 보정한다.
// best-effort: 전체가 throw 하지 않는다(본 저장 요청 응답을 깨뜨리지 않음).
export async function recomputeWeeklyCardsSnapshotsForUsers(
  profileUserIds: string[],
  opts: { concurrency?: number } = {},
): Promise<{ requested: number; recomputed: number; failed: number; failedUserIds: string[] }> {
  const uniqueIds = Array.from(
    new Set(profileUserIds.filter((id): id is string => Boolean(id))),
  );
  if (uniqueIds.length === 0) {
    return { requested: 0, recomputed: 0, failed: 0, failedUserIds: [] };
  }
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const failedUserIds: string[] = [];
  let recomputed = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < uniqueIds.length) {
      const uid = uniqueIds[cursor++];
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(uid);
        recomputed++;
      } catch (e) {
        // 실패 격리: 해당 사용자는 markStale 상태로 남아 cron/lazy 가 보정.
        failedUserIds.push(uid);
        console.warn("[weekly-cards][snapshot] eager recompute failed (left stale)", {
          userId: uid,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  // 코호트 요청 캐시: 배치 전체를 한 스코프로 감싸 전역/코호트-불변 GET(official_rest_periods·
  //   activity_types·season_definitions·weeks·line_registrations·cluster4_lines·
  //   cluster4_line_targets 등)을 유저마다 다시 조회하지 않고 1회만 실행·공유한다(rows 동일 → JSON 불변).
  await runWithCohortRequestCache(
    () =>
      Promise.all(
        Array.from({ length: Math.min(concurrency, uniqueIds.length) }, () => worker()),
      ),
    (stats) => {
      if (uniqueIds.length > 1) {
        console.log(
          "[weekly-cards][snapshot] cohort request cache",
          `users=${uniqueIds.length} sharedHits=${stats.hits} realGets=${stats.misses}`,
        );
      }
    },
  );

  return {
    requested: uniqueIds.length,
    recomputed,
    failed: failedUserIds.length,
    failedUserIds,
  };
}

// 조회 시 snapshot miss + lazy 비활성(WEEKLY_CARDS_DISABLE_LAZY=1)일 때 사용.
// 무거운 계산 대신, cron 이 곧바로 집어가도록 "비어있는 stale placeholder 행"을 큐잉한다.
// computed_at 을 epoch(아주 과거)로 두어 due+stale 양쪽으로 잡힌다 → 다음 cron 1순위 재계산.
// 이 함수는 "miss(행 없음)" 경로에서만 호출되므로 ignoreDuplicates 로 기존 정상 snapshot 은 건드리지 않는다.
export async function enqueueStaleSnapshot(profileUserId: string): Promise<void> {
  const { error } = await supabaseAdmin.from(TABLE).upsert(
    {
      user_id: profileUserId,
      cards: [],
      card_count: 0,
      dto_version: WEEKLY_CARDS_DTO_VERSION,
      is_stale: true,
      computed_at: new Date(0).toISOString(),
    },
    { onConflict: "user_id", ignoreDuplicates: true },
  );
  if (error) {
    console.warn("[weekly-cards][snapshot] enqueue stale failed", {
      profileUserId,
      message: error.message,
    });
  }
}

// 관리자 훅 전용: 변경된 사용자의 snapshot 을 그 자리에서 즉시 재계산(변경 즉시 반영용).
// 조회 경로는 snapshot-only(계산 안 함)이므로, 즉시 반영이 필요한 단건 변경은 쓰기 시점에 여기서 갱신한다.
// best-effort: 재계산이 실패해도 본 쓰기 요청을 깨뜨리지 않는다 — 실패 시 stale 로 표시해 cron 이 재시도.
//   (실패 시에도 upsert 가 일어나지 않아 기존 snapshot 은 보존된다.)
export async function refreshWeeklyCardsSnapshotSafe(
  profileUserId: string,
): Promise<void> {
  try {
    await recomputeAndStoreWeeklyCardsSnapshot(profileUserId);
    // 관리자 저장 직후 즉시 재계산이 일어났음을 운영 로그로 확인 가능하게 한다(항목 3 검증용).
    console.log("[weekly-cards][snapshot] hook recompute ok", `user=${profileUserId}`);
  } catch (e) {
    console.warn(
      "[weekly-cards][snapshot] hook recompute failed → mark stale for cron retry",
      { profileUserId, message: e instanceof Error ? e.message : String(e) },
    );
    await markWeeklyCardsSnapshotStale(profileUserId);
  }
}

// 입력 변경 시 "재계산 필요" 표시만 남긴다(즉시 계산하지 않음). 관리자 저장/sync 훅에서 사용.
// 조회 경로는 stale 여도 구 카드를 그대로 노출하고 계산하지 않는다(snapshot-only). 재생성은 cron 이
// is_stale=true / dto_version 불일치 / due 행을 모아 수행한다(주기 갱신).
// 행이 없으면 no-op(UPDATE 라 신규 유저에는 영향 없음 — 다음 cron/백필 에서 생성).
// best-effort: 실패해도 throw 하지 않는다(본 쓰기 요청을 깨뜨리지 않음, 다음 cron 이 보정).
export async function markWeeklyCardsSnapshotStale(
  profileUserId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from(TABLE)
    .update({ is_stale: true })
    .eq("user_id", profileUserId);
  if (error) {
    console.warn("[weekly-cards][snapshot] mark stale failed", {
      profileUserId,
      message: error.message,
    });
    return;
  }
  console.log("[weekly-cards][snapshot] mark stale ok", `user=${profileUserId}`);
}

// 여러 사용자 snapshot 을 stale 처리한다(라인 개설 org audience = 대상자 N명, 최대 수백~천 단위).
// 빈/중복 id 는 정리하고, 행이 없는 사용자는 자연스럽게 no-op. best-effort(throw 안 함).
//
// ⚠ 반드시 청크 단위로 .in() 을 실행한다. 단일 .in("user_id", [수백 UUID]) 는 PostgREST 의 URL/요청
//   길이 한도를 넘겨 400 'Bad Request' 로 실패하고, 그 실패가 여기서 조용히 삼켜지면 is_stale 이
//   세팅되지 않는다 → snapshot-only 조회 런타임에서 lazy 재계산이 트리거되지 않아 "실무 경험/역량
//   라인이 고객앱에 반영 안 됨"(2026-07-01 근본원인, 실측 audience=729 → Bad Request)을 유발한다.
//   Info 개설은 targets(소수)만 무효화해 즉시 재계산 경로라 이 버그에 걸리지 않았다.
export async function markWeeklyCardsSnapshotStaleMany(
  profileUserIds: string[],
): Promise<void> {
  const uniqueIds = Array.from(
    new Set(profileUserIds.filter((id): id is string => Boolean(id))),
  );
  if (uniqueIds.length === 0) return;
  const CHUNK = 100; // UUID 100개 ≈ 3.7KB — PostgREST URL 한도 안전 구간.
  let failed = 0;
  for (let i = 0; i < uniqueIds.length; i += CHUNK) {
    const chunk = uniqueIds.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin
      .from(TABLE)
      .update({ is_stale: true })
      .in("user_id", chunk);
    if (error) {
      failed += chunk.length;
      console.warn("[weekly-cards][snapshot] mark stale (many) chunk failed", {
        chunk: chunk.length,
        message: error.message,
      });
    }
  }
  if (failed > 0) {
    console.warn(
      "[weekly-cards][snapshot] mark stale (many) partial",
      `failed=${failed}/${uniqueIds.length}`,
    );
  } else {
    console.log("[weekly-cards][snapshot] mark stale (many) ok", `count=${uniqueIds.length}`);
  }
}
