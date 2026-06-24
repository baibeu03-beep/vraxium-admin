import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import { deriveRosterCardStats } from "@/lib/rosterCardStats";
import { computeScheduleReliabilityFromRows } from "@/lib/scheduleReliabilityCore";
import { tickTimeout } from "@/lib/supabaseQueryMeter";

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
export const WEEKLY_CARDS_DTO_VERSION = 27;

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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, uniqueIds.length) }, () => worker()),
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

// 여러 사용자 snapshot 을 한 번의 UPDATE 로 stale 처리한다(career 라인 개설 = 대상자 N명).
// 빈/중복 id 는 정리하고, 행이 없는 사용자는 자연스럽게 no-op. best-effort(throw 안 함).
export async function markWeeklyCardsSnapshotStaleMany(
  profileUserIds: string[],
): Promise<void> {
  const uniqueIds = Array.from(
    new Set(profileUserIds.filter((id): id is string => Boolean(id))),
  );
  if (uniqueIds.length === 0) return;
  const { error } = await supabaseAdmin
    .from(TABLE)
    .update({ is_stale: true })
    .in("user_id", uniqueIds);
  if (error) {
    console.warn("[weekly-cards][snapshot] mark stale (many) failed", {
      count: uniqueIds.length,
      message: error.message,
    });
    return;
  }
  console.log("[weekly-cards][snapshot] mark stale (many) ok", `count=${uniqueIds.length}`);
}
