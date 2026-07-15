// 프로세스 체크 완료 → 포인트 적립 (멱등 원장 기반).
// ─────────────────────────────────────────────────────────────────────
// 적립 SoT = process_point_awards(원장). user_weekly_points 는 원장 (user, year, week) 합으로
// 재계산한다(증분 금지 → 멱등). 적립 후 cluster4_weekly_card_snapshots 무효화로 고객앱 반영.
//   정규  : ref_id=process_check_statuses.id, 포인트=process_acts(point_check/advantage/penalty)
//   변동: ref_id=process_irregular_acts.id,  포인트=point_a/b/c
//   매핑   : point_check→points / point_advantage→advantages / point_penalty→penalty
//   ⚠ 정책(2026-07-04): 패널티 Po.C 동시 지급 차단 — 자동 매칭(카페/검수) 이행자는 C 금지,
//     보상(A/B)과 C 동시 금지(A+C·B+C 불가). 순수 수동 패널티(미발생)만 유지. SoT=resolveEffectivePenalty.
//   ⚠ 정책(2026-07-13): 정규 체크 완료 시 Point C 는 "비대상자"에게 지급한다 —
//     unselectedUsers = 체크 대상자 로스터(resolveCheckScopeRoster) − 이행자(matched). 이행자→A/B,
//     비대상자→C. 한 사용자에게 A/B 와 C 가 동시 지급되지 않는다(집합 차 + resolveEffectivePenalty).
//     로스터는 각 체크의 스코프(org·hub·team·part·mode)를 그대로 재현(화면 대상자 == C 모집단).
//     원장은 (source,ref_id) 단위로 desired 집합에 맞춰 정합(reconcile)한다 — 재실행 시 대상자/비대상자
//     이동을 정확히 회수·재지급. 소급 backfill 없음(신규 완료·명시 재실행부터). 변동(irregular) 무변.
//   주차   : weeks.iso_year/iso_week (user_weekly_points 키)
//   대상자 : process_check_review_recipients(source,ref_id,match_type='matched',user_id)
//
// era 경계(운영 정책 불변):
//   operating : weeks.start_date >= 2026-summer W1 만 적립
//   test      : 위 + 2026-spring W13 예외(검증용) — 테스트 사용자만(scope 가드)
//   그 외 주차(레거시/PMS) → 적립 스킵(원장 미생성) → 과거 데이터 무접촉.
//
// ⚠ 전제: db/migrations/2026-06-15_process_point_awards.sql 적용. 미적용 시 PGRST205 → 스킵(로그).
// ⚠ user_weekly_points.points 재계산은 era 경계 주차에서만 — operating summer 는 base=0(무손실),
//   test W13 은 기존값을 원장합으로 덮어씀(검증용 — 호출 검증 스크립트가 원복).
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import { resolveLineScope } from "@/lib/lineScope";
import {
  assertUserIdsInScope,
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { processPointAwardsHasCancelColumns } from "@/lib/processPointAwardsCancelState";
import { isCluster4TestExceptionWeek } from "@/lib/cluster4TestWeekPolicy";
import { syncGradeStats } from "@/lib/cluster3ClubRankData";
import type { RejudgeResult } from "@/lib/crewWeekGrowthRejudge";
import type { OrganizationSlug } from "@/lib/organizations";
import { isOrganizationSlug } from "@/lib/organizations";
import { resolveCheckScopeRoster } from "@/lib/processCheckScopeRoster";
import { isTeamBasedProcessHub } from "@/lib/adminProcessCheckTypes";
import type { ProcessHub } from "@/lib/adminProcessesTypes";

export type AccrualSource = "regular" | "irregular" | "line";

// 적립 기능 kill-switch(운영 비활성 — 코드 무수정 롤백). 기본 활성.
const ACCRUAL_ENABLED = process.env.PROCESS_ACCRUAL_ENABLED !== "0";

// 소프트 취소 컬럼 적용 여부 프로브는 순환 import 회피를 위해 전용 얇은 모듈에 둔다(재-export).
export { processPointAwardsHasCancelColumns };

type WeekRow = {
  id: string;
  start_date: string;
  season_key: string | null;
  week_number: number | null;
  iso_year: number | null;
  iso_week: number | null;
};

type AwardInput = {
  source: AccrualSource;
  refId: string;
  week: WeekRow;
  org: OrganizationSlug | null;
  mode: ScopeMode;
  pointCheck: number;
  pointAdvantage: number;
  pointPenalty: number;
  // 자동 매칭 여부 — 카페 링크/검수 완료(worker) 자동 집계면 true(=이행자), 수동 부여면 false.
  //   이행자(자동 매칭)는 정책상 패널티 Po.C 를 절대 받지 않는다(applyAward 에서 강제).
  autoMatched: boolean;
  // ── Point C 비대상자 지급용 체크 스코프(정규만) ──────────────────────────────
  //   비대상자(unselectedUsers) = 체크 대상자 로스터 − 이행자(matched). 로스터는 저장돼 있지 않아
  //   이 스코프로 재계산한다(resolveCheckScopeRoster). 변동(irregular)은 스코프 로스터 개념이 없어
  //   null 로 전달 → 비대상자 지급 없음(기존 동작 유지).
  hub: ProcessHub | null;
  teamId: string | null;
  partName: string | null;
};

// 패널티(Po.C) 지급 정책(2026-07-04) — 순수 함수(단일 SoT, 테스트 용이).
//   1) 자동 매칭(카페/검수 완료)된 이행자 → 패널티 절대 미지급(C=0). "카페 자동매칭=이행자" 요구.
//   2) 수동 부여라도 보상(A>0 또는 B>0)과 패널티(C)를 한 사람에게 함께 지급 금지 → C=0.
//   3) 그 외(수동 부여 + 순수 패널티: A=0,B=0,C>0) → 관리자 명시 '미발생' 패널티이므로 유지.
export function resolveEffectivePenalty(input: {
  autoMatched: boolean;
  pointCheck: number;
  pointAdvantage: number;
  pointPenalty: number;
}): number {
  const requested = input.pointPenalty ?? 0;
  if (requested <= 0) return requested;
  if (input.autoMatched) return 0; // (1) 이행자
  const hasReward = (input.pointCheck ?? 0) > 0 || (input.pointAdvantage ?? 0) > 0;
  if (hasReward) return 0; // (2) A+C·B+C 동시 금지
  return requested; // (3) 순수 패널티(수동 미발생) 유지
}

export type AccrualResult =
  | { ok: true; accruedUserIds: string[]; skipped?: false }
  | { ok: true; skipped: true; reason: string; accruedUserIds: [] };

// era 경계(순수) — operating 정책 단일 기준(slot effective_from 이후 주차만 적립).
//   ⚠ 2026-07-01: 테스트 전용 W13 예외는 폐지됨(isCluster4TestExceptionWeek 는 항상 false).
//     주차 판정은 operating 그대로이며 QA 모집단 스위치와 무관하다.
export function isAccrualAllowedWeek(mode: ScopeMode, week: {
  start_date: string;
  season_key: string | null;
  week_number: number | null;
}): boolean {
  if (week.start_date >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) return true;
  // 폐지된 예외 경로(항상 false) — 시그니처 호환용 잔존. 신규 예외를 여기에 추가하지 말 것.
  if (isCluster4TestExceptionWeek(mode, week.season_key, week.week_number)) return true;
  return false;
}

// 매칭 대상자(user_id) 로드 — recipients(matched).
async function loadMatchedUserIds(source: AccrualSource, refId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("process_check_review_recipients")
    .select("user_id")
    .eq("source", source)
    .eq("ref_id", refId)
    .eq("match_type", "matched");
  if (error) throw error;
  return Array.from(
    new Set(((data ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter((id): id is string => Boolean(id))),
  );
}

// 영향 (user, year, week) 의 user_weekly_points 를 원장 합으로 재계산(증분 금지).
//   ⚠ 포인트 합산의 단일 공통 레이어 — 소프트 취소(cancelled_at IS NOT NULL) 행은 여기서 제외한다.
//   user_weekly_points 가 모든 표면(카드/Detail Log/회원 상세/snapshot)의 포인트 SoT 이므로,
//   이 한 곳에서 제외하면 전 표면·전 모드(operating/test/actAs/demo)가 동일하게 취소분을 뺀다.
async function recomputeWeeklyPoints(pairs: Array<{ userId: string; year: number; week: number; weekStartDate: string }>): Promise<void> {
  const hasCancel = await processPointAwardsHasCancelColumns();
  for (const p of pairs) {
    let query = supabaseAdmin
      .from("process_point_awards")
      .select("point_check,point_advantage,point_penalty")
      .eq("user_id", p.userId)
      .eq("year", p.year)
      .eq("week_number", p.week);
    if (hasCancel) query = query.is("cancelled_at", null); // 취소 행 제외(공통 레이어)
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as { point_check: number; point_advantage: number; point_penalty: number }[];
    const points = rows.reduce((s, r) => s + (r.point_check || 0), 0);
    const advantages = rows.reduce((s, r) => s + (r.point_advantage || 0), 0);
    const penalty = rows.reduce((s, r) => s + (r.point_penalty || 0), 0);
    const { error: upErr } = await supabaseAdmin.from("user_weekly_points").upsert(
      {
        user_id: p.userId,
        year: p.year,
        week_number: p.week,
        week_start_date: p.weekStartDate,
        points,
        advantages,
        penalty,
        checks_migrated: true, // 적립 provenance(프로세스 체크 발) — 게이트 enforce 일관성
      },
      { onConflict: "user_id,year,week_number" },
    );
    if (upErr) throw upErr;
  }
}

// 한 체크(ref_id)의 desired 원장 집합 — 이행자(A/B, C=0)와 비대상자(0/0/C)로 분리해 계산.
//   ⚠ 순수 계산(원장 쓰기 없음) — 실제 적립(applyAward)과 dry-run(previewRegularAccrual)이 공유한다.
type DesiredAward = {
  userId: string;
  pointCheck: number;
  pointAdvantage: number;
  pointPenalty: number;
  bucket: "performer" | "unselected";
};

export type AccrualPlan = {
  performers: string[]; // 이행자(matched) — A/B 지급(C=0).
  unselected: string[]; // 비대상자 = 로스터 − 이행자 — C 지급.
  rosterCount: number; // 체크 대상자 로스터 크기(정규·C 설정 시에만 계산, 아니면 0).
  effectivePenaltyPerformer: number; // 이행자에게 적용된 C(정책상 보통 0).
  effectivePenaltyUnselected: number; // 비대상자에게 적용된 C.
  desired: DesiredAward[];
};

// desired 집합 계산 — 이행자 + (정규·C 설정 시) 비대상자. 로스터는 체크 스코프 재현(resolveCheckScopeRoster).
async function computeDesiredAwards(input: AwardInput): Promise<AccrualPlan> {
  // 카페 링크 원천 집계(process_check_review_recipients.matched) — 이 값 자체는 변경하지 않는다
  //   ("카페 링크 원천 집계 방식 불변"). 소속 필터는 아래 "체크 대상 산정" 단계에서만 적용한다.
  const rawPerformers = await loadMatchedUserIds(input.source, input.refId);

  // ── 체크 대상자 로스터 = "선택한 팀/파트에 실제로 소속된 체크 대상 크루"(SoT=resolveCheckScopeRoster) ──
  //   팀 구분 허브(experience): roster = listPartCrews(part) / listTeamCrews(팀 총괄). 카페 매칭 이행자를
  //     이 로스터로 교집합해 "카페 링크 집계 ∩ 실제 팀/파트 소속자"만 이행자(A/B)로 남긴다 — 타 팀/타 파트/
  //     미소속 매칭자는 이 체크의 대상이 아니므로 제외한다(각자 소속 팀/파트 체크에서 처리).
  //   비팀 허브(info/competency/club)·변동(irregular): 교집합 no-op(카페 매칭이 이미 org+mode 모집단으로
  //     좁혀졌고 로스터도 동일 모집단이라 원본과 동일) → 기존 동작 완전 불변.
  //   ⚠ 로스터는 이행자 교집합과 비대상자(C) 차집합에서 함께 쓰므로, 필요할 때 1회만 산출한다.
  const isRegular = input.source === "regular";
  const teamScoped = isRegular && !!input.hub && isTeamBasedProcessHub(input.hub);
  const needsCRoster = isRegular && (input.pointPenalty ?? 0) > 0 && !!input.hub;
  const roster =
    teamScoped || needsCRoster
      ? await resolveCheckScopeRoster({
          hub: input.hub as ProcessHub,
          organization: input.org,
          mode: input.mode,
          teamId: input.teamId,
          partName: input.partName,
        })
      : null;
  const rosterSet = roster ? new Set(roster) : null;

  // 이행자(performers) = 카페 매칭 ∩ 체크 대상자 로스터(팀 구분 허브만 실질 교집합; 비팀/변동은 매칭 그대로).
  const performers = teamScoped && rosterSet ? rawPerformers.filter((id) => rosterSet.has(id)) : rawPerformers;
  const perfSet = new Set(performers);

  // 이행자: 보상 A/B + 패널티 정책(resolveEffectivePenalty — 이행자/보상 동시 C 금지 → 통상 0).
  const effectivePenaltyPerformer = resolveEffectivePenalty({
    autoMatched: input.autoMatched,
    pointCheck: input.pointCheck,
    pointAdvantage: input.pointAdvantage,
    pointPenalty: input.pointPenalty,
  });

  // 비대상자(unselectedUsers): 정규 체크 + C(point_penalty)>0 일 때만 산출한다.
  //   로스터 = 체크 대상자(화면 노출과 동일) · 비대상자 = 로스터 − 이행자.
  let unselected: string[] = [];
  let rosterCount = 0;
  if (needsCRoster && roster) {
    rosterCount = roster.length;
    unselected = roster.filter((id) => !perfSet.has(id));
  }
  // 비대상자 C — 보상 없음(0/0/C)이므로 resolveEffectivePenalty 는 원값 유지(단일 SoT 재사용).
  const effectivePenaltyUnselected = resolveEffectivePenalty({
    autoMatched: false,
    pointCheck: 0,
    pointAdvantage: 0,
    pointPenalty: input.pointPenalty,
  });

  const desired: DesiredAward[] = [
    ...performers.map((uid): DesiredAward => ({
      userId: uid,
      pointCheck: input.pointCheck,
      pointAdvantage: input.pointAdvantage,
      pointPenalty: effectivePenaltyPerformer,
      bucket: "performer",
    })),
    ...unselected.map((uid): DesiredAward => ({
      userId: uid,
      pointCheck: 0,
      pointAdvantage: 0,
      pointPenalty: effectivePenaltyUnselected,
      bucket: "unselected",
    })),
  ];

  return { performers, unselected, rosterCount, effectivePenaltyPerformer, effectivePenaltyUnselected, desired };
}

// 공통 적립 코어 — 원장 정합(reconcile) + user_weekly_points 재계산 + snapshot 무효화.
//   desired = 이행자(A/B) ∪ 비대상자(C). (source,ref_id)의 원장을 desired 에 맞춰 정합한다:
//   desired 에 없는 기존 행은 삭제(회수), desired 행은 upsert. → 재실행 시 대상자/비대상자 이동을
//   정확히 반영(회수·재지급). 한 사용자는 이행자 집합과 비대상자 집합 중 하나에만 속한다(집합 차).
async function applyAward(input: AwardInput): Promise<AccrualResult> {
  if (!ACCRUAL_ENABLED) return { ok: true, skipped: true, reason: "accrual_disabled", accruedUserIds: [] };
  const { source, refId, week, org, mode } = input;

  // era 경계 — 미허용 주차는 적립 스킵(원장 미생성).
  if (!isAccrualAllowedWeek(mode, week)) {
    return { ok: true, skipped: true, reason: `era_blocked(${mode},${week.season_key} W${week.week_number})`, accruedUserIds: [] };
  }
  if (week.iso_year == null || week.iso_week == null) {
    return { ok: true, skipped: true, reason: "week_iso_missing", accruedUserIds: [] };
  }

  const plan = await computeDesiredAwards(input);

  if ((input.pointPenalty ?? 0) > 0) {
    console.warn("[accrual] Po.C(penalty) 분배 — 이행자→A/B(C=0)·비대상자→C", {
      source,
      refId,
      autoMatched: input.autoMatched,
      requestedPenalty: input.pointPenalty,
      performers: plan.performers.length,
      unselected: plan.unselected.length,
      rosterCount: plan.rosterCount,
      effectivePenaltyPerformer: plan.effectivePenaltyPerformer,
      effectivePenaltyUnselected: plan.effectivePenaltyUnselected,
    });
  }

  return reconcileAwards({ source, refId, week, org, mode, desired: plan.desired });
}

// 공통 원장 정합 코어 — desired 집합을 받아 (source,ref_id) 원장을 정합한다.
//   desired 에 없는 기존 행은 삭제(회수), desired 행은 멱등 upsert(UNIQUE source,ref_id,user_id) →
//   user_weekly_points 재합산 + 등급 + snapshot 무효화. regular/irregular(applyAward) 와
//   line(reconcileLineOpenAward) 이 공유한다 — 동일 멱등/회수/재합산 보장.
async function reconcileAwards(params: {
  source: AccrualSource;
  refId: string;
  week: WeekRow;
  org: OrganizationSlug | null;
  mode: ScopeMode;
  desired: DesiredAward[];
}): Promise<AccrualResult> {
  const { source, refId, week, org, mode, desired } = params;
  if (!ACCRUAL_ENABLED) return { ok: true, skipped: true, reason: "accrual_disabled", accruedUserIds: [] };
  // 회수(delete) 시 소프트 취소된 행은 보존한다 — 삭제하면 취소 기록이 사라져 재실행 시 부활할 수 있다.
  const hasCancel = await processPointAwardsHasCancelColumns();
  // era 경계(방어적 2차 가드 — line 경로 진입점) · iso 없으면 스킵.
  if (!isAccrualAllowedWeek(mode, week)) {
    return { ok: true, skipped: true, reason: `era_blocked(${mode},${week.season_key} W${week.week_number})`, accruedUserIds: [] };
  }
  if (week.iso_year == null || week.iso_week == null) {
    return { ok: true, skipped: true, reason: "week_iso_missing", accruedUserIds: [] };
  }

  const desiredIds = desired.map((d) => d.userId);

  // 기존 원장 대상자(정합 전) — 이번에 desired 에서 빠진 사용자를 회수 대상으로 포함하기 위해 로드.
  const { data: existingRows, error: existErr } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id")
    .eq("source", source)
    .eq("ref_id", refId);
  if (existErr) throw existErr;
  const existingIds = Array.from(
    new Set(((existingRows ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter((id): id is string => Boolean(id))),
  );

  if (desiredIds.length === 0) {
    // 지급 대상 없음 — 기존 원장이 있으면 정합상 전량 회수(재실행으로 대상 0 이 된 경우).
    if (existingIds.length === 0) return { ok: true, accruedUserIds: [] };
    {
      let del = supabaseAdmin.from("process_point_awards").delete().eq("source", source).eq("ref_id", refId);
      if (hasCancel) del = del.is("cancelled_at", null); // 취소 행 보존
      const { error: delAllErr } = await del;
      if (delAllErr) throw delAllErr;
    }
    await settleAffectedUsers(existingIds, week);
    return { ok: true, accruedUserIds: [] };
  }

  // 스코프 재검증(fail-closed) — test=test_user_markers만 / operating=실사용자만. 위반 시 throw(422).
  const scope = await resolveUserScope(mode, org);
  assertUserIdsInScope(scope, desiredIds);

  const year = week.iso_year;
  const wk = week.iso_week;

  const nowIso = new Date().toISOString();
  // 원장 멱등 upsert(UNIQUE source,ref_id,user_id).
  const ledgerRows = desired.map((d) => ({
    source,
    ref_id: refId,
    user_id: d.userId,
    year,
    week_number: wk,
    point_check: d.pointCheck,
    point_advantage: d.pointAdvantage,
    point_penalty: d.pointPenalty,
    organization_slug: org,
    scope_mode: mode,
    updated_at: nowIso,
  }));
  const { error: ledgerErr } = await supabaseAdmin
    .from("process_point_awards")
    .upsert(ledgerRows, { onConflict: "source,ref_id,user_id" });
  if (ledgerErr) throw ledgerErr;

  // 정합 — desired 에서 빠진 기존 원장 행 삭제(대상자 이동/이탈 회수).
  const desiredSet = new Set(desiredIds);
  const staleIds = existingIds.filter((id) => !desiredSet.has(id));
  if (staleIds.length) {
    let del = supabaseAdmin
      .from("process_point_awards")
      .delete()
      .eq("source", source)
      .eq("ref_id", refId)
      .in("user_id", staleIds);
    if (hasCancel) del = del.is("cancelled_at", null); // 취소 행 보존(부활 방지)
    const { error: delErr } = await del;
    if (delErr) throw delErr;
  }

  // user_weekly_points 재계산 + 등급 + snapshot 무효화 — desired ∪ stale(회수) 전원.
  const affected = Array.from(new Set([...desiredIds, ...staleIds]));
  await settleAffectedUsers(affected, week);
  return { ok: true, accruedUserIds: desiredIds };
}

// (user, year, week) 재계산 + 등급 갱신 + snapshot 무효화 — 적립/회수 공통 마무리.
async function settleAffectedUsers(userIds: string[], week: WeekRow): Promise<void> {
  if (userIds.length === 0) return;
  const year = week.iso_year as number;
  const wk = week.iso_week as number;
  await recomputeWeeklyPoints(userIds.map((uid) => ({ userId: uid, year, week: wk, weekStartDate: week.start_date })));
  await syncGradesBestEffort(userIds);
  await invalidateWeeklyCardsForUsers(userIds);
}

// dry-run 미리보기 — 정규 체크의 로스터/이행자/비대상자(C) 규모를 원장 쓰기 없이 계산한다.
//   실제 적립과 동일한 computeDesiredAwards 를 쓰므로 "미리보기 == 실제 결과" 가 보장된다.
export type RegularAccrualPreview =
  | { ok: true; skipped: true; reason: string }
  | {
      ok: true;
      skipped?: false;
      statusId: string;
      org: OrganizationSlug | null;
      mode: ScopeMode;
      hub: ProcessHub | null;
      teamId: string | null;
      partName: string | null;
      pointCheck: number;
      pointAdvantage: number;
      pointPenalty: number;
      rosterCount: number;
      performerCount: number;
      unselectedCount: number;
      effectivePenaltyPerformer: number;
      effectivePenaltyUnselected: number;
      eraAllowed: boolean;
    };

export async function previewRegularAccrual(statusId: string): Promise<RegularAccrualPreview> {
  const built = await buildRegularAwardInput(statusId);
  if ("skipped" in built) return { ok: true, skipped: true, reason: built.reason };
  const { input } = built;
  const plan = await computeDesiredAwards(input);
  return {
    ok: true,
    statusId,
    org: input.org,
    mode: input.mode,
    hub: input.hub,
    teamId: input.teamId,
    partName: input.partName,
    pointCheck: input.pointCheck,
    pointAdvantage: input.pointAdvantage,
    pointPenalty: input.pointPenalty,
    rosterCount: plan.rosterCount,
    performerCount: plan.performers.length,
    unselectedCount: plan.unselected.length,
    effectivePenaltyPerformer: plan.effectivePenaltyPerformer,
    effectivePenaltyUnselected: plan.effectivePenaltyUnselected,
    eraAllowed: isAccrualAllowedWeek(input.mode, input.week),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Point C 비대상자 소급 지급(1회성 backfill) — 과거 버그로 누락된 C 만 보완.
//   ⚠ 정책: 순수 additive — 기존 A/B 원장 무변경 · 삭제 없음 · 이미 지급(원장 존재)분 dedup 스킵.
//   판정 로직은 전방(forward) 적립과 100% 동일(computeDesiredAwards) — operating/test 공통.
//   era 미허용/파C 미설정 체크는 스킵(전방과 동일 — 그런 체크는 A/B 도 적립 안 됨).
// ─────────────────────────────────────────────────────────────────────
export type RegularUnselectedCBackfill =
  | { ok: true; skipped: true; reason: string }
  | {
      ok: true;
      skipped?: false;
      statusId: string;
      org: OrganizationSlug | null;
      mode: ScopeMode;
      hub: ProcessHub | null;
      partName: string | null;
      week: WeekRow;
      pointPenalty: number;
      effectivePenaltyUnselected: number;
      rosterCount: number;
      performerCount: number;
      unselectedCount: number;
      // 비대상자 중 원장에 C 가 이미 있어 건너뛴 수(중복 방지).
      alreadyLedgeredCount: number;
      // 실제로 신규 지급될(원장에 없는) 비대상자 userId — dry-run/apply 공통.
      missingCUserIds: string[];
    };

// 소급 지급 계획(read-only) — dry-run 과 apply 가 공유(미리보기==실행).
export async function computeRegularUnselectedCBackfill(statusId: string): Promise<RegularUnselectedCBackfill> {
  const built = await buildRegularAwardInput(statusId);
  if ("skipped" in built) return { ok: true, skipped: true, reason: built.reason };
  const { input } = built;
  if (!isAccrualAllowedWeek(input.mode, input.week)) {
    return { ok: true, skipped: true, reason: `era_blocked(${input.mode},${input.week.season_key} W${input.week.week_number})` };
  }
  if ((input.pointPenalty ?? 0) <= 0) return { ok: true, skipped: true, reason: "no_penalty_configured" };
  if (input.week.iso_year == null || input.week.iso_week == null) return { ok: true, skipped: true, reason: "week_iso_missing" };

  const plan = await computeDesiredAwards(input);
  if (plan.effectivePenaltyUnselected <= 0) return { ok: true, skipped: true, reason: "penalty_zero_after_policy" };

  // 기존 원장 대상자(이 ref) — 이미 지급된(A/B 이행자 + 혹시 있을 C) 사용자. dedup 기준.
  const { data: existing, error } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id")
    .eq("source", "regular")
    .eq("ref_id", statusId);
  if (error) throw error;
  const existingSet = new Set(((existing ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter((id): id is string => Boolean(id)));

  const missingCUserIds = plan.unselected.filter((u) => !existingSet.has(u));
  const alreadyLedgeredCount = plan.unselected.length - missingCUserIds.length;

  return {
    ok: true,
    statusId,
    org: input.org,
    mode: input.mode,
    hub: input.hub,
    partName: input.partName,
    week: input.week,
    pointPenalty: input.pointPenalty,
    effectivePenaltyUnselected: plan.effectivePenaltyUnselected,
    rosterCount: plan.rosterCount,
    performerCount: plan.performers.length,
    unselectedCount: plan.unselected.length,
    alreadyLedgeredCount,
    missingCUserIds,
  };
}

export type BackfillApplyResult = {
  ok: true;
  statusId: string;
  weekId: string;
  inserted: number;               // 신규 생성된 C 원장 수
  skippedDuplicate: number;       // 중복(원장 존재)으로 건너뛴 수
  affectedUserIds: string[];      // uwp 재계산·snapshot 무효화 대상
  insertedRows: Array<{ user_id: string; year: number; week_number: number; point_penalty: number }>; // 롤백 백업용
};

// 롤백/외부 재계산용 — 지정 사용자들의 (해당 주차) uwp 를 원장 합으로 재계산 + 등급 + snapshot 무효화.
export async function recomputeWeeklyPointsForUsers(userIds: string[], weekId: string): Promise<void> {
  if (!userIds.length) return;
  const week = await loadWeek(weekId);
  if (!week) return;
  await settleAffectedUsers(Array.from(new Set(userIds)), week);
}

// 소급 지급 실행(additive) — 누락 C 만 insert(ignoreDuplicates) + uwp 재계산 + snapshot 무효화.
//   기존 A/B 원장 무변경 · 삭제 없음. 전방 적립과 동일 판정(computeRegularUnselectedCBackfill).
export async function applyRegularUnselectedCBackfill(statusId: string): Promise<BackfillApplyResult | { ok: true; skipped: true; reason: string }> {
  if (!ACCRUAL_ENABLED) return { ok: true, skipped: true, reason: "accrual_disabled" };
  const plan = await computeRegularUnselectedCBackfill(statusId);
  if (plan.skipped) return plan;
  if (plan.missingCUserIds.length === 0) {
    return { ok: true, statusId, weekId: plan.week.id, inserted: 0, skippedDuplicate: plan.alreadyLedgeredCount, affectedUserIds: [], insertedRows: [] };
  }

  // 스코프 재검증(fail-closed) — 비대상자 전원이 (mode,org) 스코프여야. 위반 시 throw(422).
  const scope = await resolveUserScope(plan.mode, plan.org);
  assertUserIdsInScope(scope, plan.missingCUserIds);

  const year = plan.week.iso_year as number;
  const wk = plan.week.iso_week as number;
  const nowIso = new Date().toISOString();
  const rows = plan.missingCUserIds.map((uid) => ({
    source: "regular" as const,
    ref_id: statusId,
    user_id: uid,
    year,
    week_number: wk,
    point_check: 0,
    point_advantage: 0,
    point_penalty: plan.effectivePenaltyUnselected,
    organization_slug: plan.org,
    scope_mode: plan.mode,
    updated_at: nowIso,
  }));
  // additive + dedup — 이미 있는 (source,ref_id,user_id)는 건드리지 않음(A/B·기존 C 보존).
  const { error } = await supabaseAdmin
    .from("process_point_awards")
    .upsert(rows, { onConflict: "source,ref_id,user_id", ignoreDuplicates: true });
  if (error) throw error;

  await settleAffectedUsers(plan.missingCUserIds, plan.week);
  return {
    ok: true,
    statusId,
    weekId: plan.week.id,
    inserted: plan.missingCUserIds.length,
    skippedDuplicate: plan.alreadyLedgeredCount,
    affectedUserIds: plan.missingCUserIds,
    insertedRows: rows.map((r) => ({ user_id: r.user_id, year: r.year, week_number: r.week_number, point_penalty: r.point_penalty })),
  };
}

// 등급(user_grade_stats) 당사자 즉시 갱신 — 포인트 변경 사용자 본인만(getClubRank 단일 스캔).
//   ⚠ 타 사용자 전체 재계산(syncAllGradeStats)은 하지 않는다 — 전역 정합은 별도 배치/후속 1-pass Phase.
//   best-effort: 등급 갱신 실패는 warning 처리하고 포인트 적립은 유지(등급은 파생 캐시 — SoT 아님).
//   snapshot invalidate 와 독립(등급은 user_grade_stats→front /api/profile 직독, weekly-card 무관).
async function syncGradesBestEffort(userIds: string[]): Promise<void> {
  for (const uid of userIds) {
    try {
      await syncGradeStats(uid);
    } catch (e) {
      console.warn("[accrual] 등급(user_grade_stats) 당사자 갱신 실패(격리·적립 유지)", {
        userId: uid,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

async function loadWeek(weekId: string): Promise<WeekRow | null> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,season_key,week_number,iso_year,iso_week")
    .eq("id", weekId)
    .maybeSingle();
  return (data as WeekRow | null) ?? null;
}

type RegularStatusRow = {
  week_id: string;
  act_id: string;
  scope_mode: string | null;
  organization_slug: string | null;
  hub?: string | null;
  team_id?: string | null;
  part_name?: string | null;
  completion_type?: string | null;
  manual_point_check?: number | null;
  manual_point_advantage?: number | null;
  manual_point_penalty?: number | null;
};

// 정규 체크 → AwardInput 조립(정합 로드 SoT — 실제 적립·dry-run 미리보기가 공유).
//   - 검수/worker 완료(completion_type=NULL) → 마스터(process_acts) 점수 · autoMatched=true(이행자).
//   - 수동 입력(completion_type='manual_grant') → 상태 행 manual_point_*(자유 입력) override · C=0(선별).
//   - hub/team_id/part_name = 비대상자(unselected) 로스터 스코프. 컬럼 미적용이면 폴백(스코프 null →
//     비대상자 지급 없음 = 안전 degrade, 실수로 패널티 남발 방지).
async function buildRegularAwardInput(
  statusId: string,
): Promise<{ input: AwardInput; week: WeekRow } | { skipped: true; reason: string }> {
  const full = await supabaseAdmin
    .from("process_check_statuses")
    .select(
      "id,week_id,act_id,scope_mode,organization_slug,hub,team_id,part_name,completion_type,manual_point_check,manual_point_advantage,manual_point_penalty",
    )
    .eq("id", statusId)
    .maybeSingle();
  let st = full.data as RegularStatusRow | null;
  if (full.error) {
    const code = (full.error as { code?: string }).code;
    if (code === "42703" || code === "PGRST204" || code === "PGRST205") {
      // 폴백 — hub/team_id 는 v3(널리 적용)까지만, part_name/completion 은 생략(안전 degrade).
      const base = await supabaseAdmin
        .from("process_check_statuses")
        .select("id,week_id,act_id,scope_mode,organization_slug,hub,team_id")
        .eq("id", statusId)
        .maybeSingle();
      if (base.error) {
        const bcode = (base.error as { code?: string }).code;
        if (bcode === "42703" || bcode === "PGRST204" || bcode === "PGRST205") {
          const minimal = await supabaseAdmin
            .from("process_check_statuses")
            .select("id,week_id,act_id,scope_mode,organization_slug")
            .eq("id", statusId)
            .maybeSingle();
          st = minimal.data as RegularStatusRow | null;
        }
      } else {
        st = base.data as RegularStatusRow | null;
      }
    }
  }
  if (!st) return { skipped: true, reason: "status_not_found" };
  const row = st;

  let pointCheck: number;
  let pointAdvantage: number;
  let pointPenalty: number;
  if (row.completion_type === "manual_grant") {
    pointCheck = row.manual_point_check ?? 0;
    pointAdvantage = row.manual_point_advantage ?? 0;
    pointPenalty = row.manual_point_penalty ?? 0;
  } else {
    const { data: act } = await supabaseAdmin
      .from("process_acts")
      .select("point_check,point_advantage,point_penalty")
      .eq("id", row.act_id)
      .maybeSingle();
    if (!act) return { skipped: true, reason: "act_not_found" };
    const a = act as { point_check: number; point_advantage: number; point_penalty: number };
    pointCheck = a.point_check ?? 0;
    pointAdvantage = a.point_advantage ?? 0;
    pointPenalty = a.point_penalty ?? 0;
  }

  const week = await loadWeek(row.week_id);
  if (!week) return { skipped: true, reason: "week_not_found" };

  return {
    week,
    input: {
      source: "regular",
      refId: statusId,
      week,
      org: isOrganizationSlug(row.organization_slug) ? row.organization_slug : null,
      mode: row.scope_mode === "test" ? "test" : "operating",
      pointCheck,
      pointAdvantage,
      pointPenalty,
      // 검수/worker 완료(completion_type=NULL) = 카페 자동 매칭 이행자. 수동 부여만 false.
      autoMatched: row.completion_type !== "manual_grant",
      hub: (row.hub as ProcessHub | null) ?? null,
      teamId: row.team_id ?? null,
      partName: row.part_name ?? null,
    },
  };
}

// 정규 프로세스 체크 완료 적립 (ref_id = process_check_statuses.id).
export async function accrueForCompletedRegular(statusId: string): Promise<AccrualResult> {
  const built = await buildRegularAwardInput(statusId);
  if ("skipped" in built) return { ok: true, skipped: true, reason: built.reason, accruedUserIds: [] };
  return applyAward(built.input);
}

// 변동 액트 완료 적립 (ref_id = process_irregular_acts.id).
export async function accrueForCompletedIrregular(actId: string): Promise<AccrualResult> {
  const { data: act } = await supabaseAdmin
    .from("process_irregular_acts")
    .select("id,week_id,kind,point_a,point_b,point_c,scope_mode,organization_slug")
    .eq("id", actId)
    .maybeSingle();
  if (!act) return { ok: true, skipped: true, reason: "irregular_not_found", accruedUserIds: [] };
  const row = act as {
    week_id: string; kind: string | null; point_a: number; point_b: number; point_c: number;
    scope_mode: string | null; organization_slug: string | null;
  };
  const week = await loadWeek(row.week_id);
  if (!week) return { ok: true, skipped: true, reason: "week_not_found", accruedUserIds: [] };
  return applyAward({
    source: "irregular",
    refId: actId,
    week,
    org: isOrganizationSlug(row.organization_slug) ? row.organization_slug : null,
    mode: row.scope_mode === "test" ? "test" : "operating",
    pointCheck: row.point_a ?? 0,
    pointAdvantage: row.point_b ?? 0,
    pointPenalty: row.point_c ?? 0,
    // 검수 링크(review_request) = 카페 자동 매칭 이행자 → C 금지. 수동 부여(manual_grant)만 false.
    autoMatched: row.kind !== "manual_grant",
    // 변동(irregular)은 org/hub/team/part 스코프 로스터 개념이 없다 → 비대상자 C 지급 없음(기존 동작 유지).
    //   변동의 C 는 resolveEffectivePenalty(순수 수동 미발생 패널티만 유지)로 종전과 동일하게 처리된다.
    hub: null,
    teamId: null,
    partName: null,
  });
}

export async function accrueForCompletedAct(source: AccrualSource, refId: string): Promise<AccrualResult> {
  return source === "regular" ? accrueForCompletedRegular(refId) : accrueForCompletedIrregular(refId);
}

// 적립 회수 (취소/삭제) — 원장 행 제거 후 영향 (user, year, week) 재계산 + snapshot 무효화.
//   summer(base=0) → points 0 으로 수렴. (W13 test 의 PMS base 복원은 호출 검증 스크립트 책임.)
export async function revokeForAct(source: AccrualSource, refId: string): Promise<{ revokedUserIds: string[] }> {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id,year,week_number")
    .eq("source", source)
    .eq("ref_id", refId);
  const rows = (data ?? []) as { user_id: string; year: number; week_number: number }[];
  if (rows.length === 0) return { revokedUserIds: [] };

  const { error: delErr } = await supabaseAdmin
    .from("process_point_awards")
    .delete()
    .eq("source", source)
    .eq("ref_id", refId);
  if (delErr) throw delErr;

  // week_start_date 보강(재계산 upsert 에 필요).
  const weekKeys = Array.from(new Set(rows.map((r) => `${r.year}-${r.week_number}`)));
  const startByKey = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.year}-${r.week_number}`;
    if (startByKey.has(key)) continue;
    const { data: w } = await supabaseAdmin
      .from("weeks")
      .select("start_date")
      .eq("iso_year", r.year)
      .eq("iso_week", r.week_number)
      .maybeSingle();
    if (w) startByKey.set(key, (w as { start_date: string }).start_date);
  }
  void weekKeys;

  await recomputeWeeklyPoints(
    rows.map((r) => ({
      userId: r.user_id,
      year: r.year,
      week: r.week_number,
      weekStartDate: startByKey.get(`${r.year}-${r.week_number}`) ?? new Date().toISOString().slice(0, 10),
    })),
  );
  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  // 회수 시에도 당사자 등급 재갱신(포인트 감소 반영) — 적립과 대칭. best-effort.
  await syncGradesBestEffort(userIds);
  await invalidateWeeklyCardsForUsers(userIds);
  return { revokedUserIds: userIds };
}

// ────────────────────────────────────────────────────────────────────────────
// 개별 원장 행(id) 단위 소프트 취소 — 관리자 "액트 취소".
//   · (source,ref_id) 코호트 전체 취소(revokeForAct)와 달리, 지정한 크루(userId)의 특정 원장 행만
//     cancelled_at 로 무효화한다(행 삭제 아님 — 감사 추적 보존).
//   · 취소 후 recomputeWeeklyPointsForUsers(공통 합산: 취소 행 제외) → 최종 Point B 복원·Point C 감소가
//     자동 반영. 이어 snapshot 재생성으로 4개 표면(카드/Detail Log/회원 상세/snapshot) 수렴.
//   · 멱등: 이미 취소된 행은 건너뛴다(cancelled_at IS NULL 조건). 전량 이미 취소면 재집계 없이 0 반환.
//   · 검증: 대상 id 는 반드시 그 크루(userId) 소유여야 하며, 소유 아닌 id 가 섞이면 전체 거부(422).
export async function softCancelActAwards(params: {
  awardIds: string[];
  userId: string; // 실제 user_profiles.user_id (= process_point_awards.user_id)
  weekId: string; // 재집계 대상 주차(weeks.id)
  cancelledBy: string; // 취소 수행 관리자 user id
  reason: string | null;
}): Promise<{ cancelledCount: number; affectedUserId: string; growth: RejudgeResult | null }> {
  const { awardIds, userId, weekId, cancelledBy, reason } = params;

  const hasCancel = await processPointAwardsHasCancelColumns();
  if (!hasCancel) {
    const e = new Error(
      "액트 취소 컬럼이 아직 적용되지 않았습니다(마이그레이션 2026-07-15_process_point_awards_soft_cancel 필요).",
    ) as Error & { status?: number; code?: string };
    e.status = 503;
    e.code = "SOFT_CANCEL_NOT_MIGRATED";
    throw e;
  }

  const ids = Array.from(new Set(awardIds)).filter((v) => typeof v === "string" && v);
  if (ids.length === 0) return { cancelledCount: 0, affectedUserId: userId, growth: null };

  // 대상 행 로드 + 소유 검증(fail-closed) — 존재/소유/취소 상태 확인.
  const { data: rows, error: readErr } = await supabaseAdmin
    .from("process_point_awards")
    .select("id,user_id,cancelled_at")
    .in("id", ids);
  if (readErr) throw readErr;
  const found = (rows ?? []) as { id: string; user_id: string; cancelled_at: string | null }[];
  if (found.length !== ids.length) {
    const e = new Error("존재하지 않는 액트가 포함되어 있습니다.") as Error & { status?: number };
    e.status = 404;
    throw e;
  }
  if (found.some((r) => r.user_id !== userId)) {
    const e = new Error("다른 크루의 액트가 포함되어 요청을 거부합니다.") as Error & { status?: number };
    e.status = 422;
    throw e;
  }

  const toCancel = found.filter((r) => !r.cancelled_at).map((r) => r.id);
  if (toCancel.length === 0) {
    // 전량 이미 취소됨 — 멱등 성공(중복 차감 없음). 합계 불변이므로 재집계·재판정 불필요.
    return { cancelledCount: 0, affectedUserId: userId, growth: null };
  }

  const nowIso = new Date().toISOString();
  const { error: upErr } = await supabaseAdmin
    .from("process_point_awards")
    .update({
      cancelled_at: nowIso,
      cancelled_by: cancelledBy,
      cancel_reason: reason,
      updated_at: nowIso,
    })
    .in("id", toCancel)
    .eq("user_id", userId)
    .is("cancelled_at", null); // 멱등 — 경합 시 이미 취소된 행은 건너뜀
  if (upErr) throw upErr;

  // 재집계(공통 합산: 취소 행 제외 → 최종 B 복원·C 감소) + 등급 + snapshot 무효화.
  await recomputeWeeklyPointsForUsers([userId], weekId);
  // 파생 재계산: 성장 결과(uws) 재판정 → 카드 snapshot 재생성 → 성장 통계 → 품계(주차 참여자).
  //   uwp 는 위에서 이미 재집계됨(rejudge earned 최신 보장). 순환 import 회피용 동적 import.
  const { recomputeDerivedAfterActMutation } = await import("@/lib/crewWeekGrowthRejudge");
  const growth = await recomputeDerivedAfterActMutation({ userId, weekId });

  return { cancelledCount: toCancel.length, affectedUserId: userId, growth };
}

// ────────────────────────────────────────────────────────────────────────────
// 라인 개설 포인트 지급 (source='line') — 2026-07-13
//   트리거 = 라인 개설(cluster4_line_targets 생성). 대상자 = (line_id, week_id, target_mode='user').
//   지급값 = cluster4_line_point_configs(org, hub, config_key) 의 per-field nullability:
//     point_a≠null → point_check=point_a · point_b≠null → point_advantage=point_b · 둘 다 null → 미지급.
//   멱등키 = (source='line', ref_id=line_id, user_id). 라인 1건은 단일 주차(실측 검증) → ref_id=line_id 로 충분.
//   회수/재지급 = reconcileLineOpenAward 재실행(대상자 정합) 또는 revokeLineOpenAward(취소/삭제).
//   info/experience/competency/career 4허브 공통 경로. N 계산·주차 verdict·강화 override 는 무접촉.
// ────────────────────────────────────────────────────────────────────────────

type LineRowForPayout = {
  id: string;
  part_type: string;
  line_code: string | null;
  activity_type_id: string | null;
  experience_line_master_id: string | null;
  competency_line_master_id: string | null;
  career_project_id: string | null;
  is_qa_test: boolean | null;
};

const LINE_PAYOUT_SELECT =
  "id,part_type,line_code,activity_type_id,experience_line_master_id,competency_line_master_id,career_project_id,is_qa_test";

// experience 마스터 카테고리 → 포인트 config_key(견문=research 등). resolveRecognitionInputs SoT 미러.
const EXP_CATEGORY_TO_CONFIG_KEY: Record<string, string> = {
  derivation: "derive",
  analysis: "analysis",
  evaluation: "research",
  extension: "expansion",
  management: "management",
};
const CONFIG_KEY_TO_EXP_CATEGORY: Record<string, string> = Object.fromEntries(
  Object.entries(EXP_CATEGORY_TO_CONFIG_KEY).map(([k, v]) => [v, k]),
);

// cluster4_lines 1행 → 포인트 config_key(허브별). info=activity_type_id · career=line_code ·
//   competency=master.line_code · experience=master.experience_category→enum. 없으면 null.
async function resolveLineConfigKey(row: LineRowForPayout): Promise<string | null> {
  const hub = row.part_type;
  if (hub === "info") return row.activity_type_id?.trim() || null;
  if (hub === "career") return row.line_code?.trim() || null;
  if (hub === "competency") {
    if (!row.competency_line_master_id) return null;
    const { data } = await supabaseAdmin
      .from("cluster4_competency_line_masters")
      .select("line_code")
      .eq("id", row.competency_line_master_id)
      .maybeSingle();
    return (data as { line_code: string | null } | null)?.line_code?.trim() || null;
  }
  if (hub === "experience") {
    if (!row.experience_line_master_id) return null;
    const { data } = await supabaseAdmin
      .from("cluster4_experience_line_masters")
      .select("experience_category")
      .eq("id", row.experience_line_master_id)
      .maybeSingle();
    const cat = (data as { experience_category: string | null } | null)?.experience_category ?? null;
    return cat ? EXP_CATEGORY_TO_CONFIG_KEY[cat] ?? null : null;
  }
  return null;
}

// (org, hub, config_key) 포인트 설정 조회 — per-field null 보존(null=미지급, 0 포함 숫자=지급).
//   org 우선 → common 폴백(loadLinePointLookupAllOrgs 와 동일 규칙). 미적용/미존재 = {null,null}.
async function loadLinePointForConfig(
  configOrg: string | null,
  hub: string,
  configKey: string,
): Promise<{ pointA: number | null; pointB: number | null }> {
  const orgsToQuery = configOrg && configOrg !== "common" ? [configOrg, "common"] : ["common"];
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_point_configs")
    .select("organization_slug, point_a, point_b")
    .eq("hub", hub)
    .eq("config_key", configKey)
    .in("organization_slug", orgsToQuery);
  if (error) {
    console.warn("[lineOpenAward] point config lookup failed → 미지급 처리", { hub, configKey, message: error.message });
    return { pointA: null, pointB: null };
  }
  const rows = (data ?? []) as Array<{ organization_slug: string; point_a: number | null; point_b: number | null }>;
  const orgRow = configOrg && configOrg !== "common" ? rows.find((r) => r.organization_slug === configOrg) : undefined;
  const commonRow = rows.find((r) => r.organization_slug === "common");
  const row = orgRow ?? commonRow ?? null;
  return row ? { pointA: row.point_a, pointB: row.point_b } : { pointA: null, pointB: null };
}

// 라인 개설 포인트 지급 정합(멱등) — 라인의 현재 대상자/설정값에 맞춰 원장을 정합한다.
//   대상자 없음 · config 없음 · 지급 설정 없음(둘 다 null) → 기존 line award 회수(revoke).
export async function reconcileLineOpenAward(lineId: string): Promise<AccrualResult> {
  if (!ACCRUAL_ENABLED) return { ok: true, skipped: true, reason: "accrual_disabled", accruedUserIds: [] };

  const { data: lineData } = await supabaseAdmin
    .from("cluster4_lines")
    .select(LINE_PAYOUT_SELECT)
    .eq("id", lineId)
    .maybeSingle();
  if (!lineData) return { ok: true, skipped: true, reason: "line_not_found", accruedUserIds: [] };
  const row = lineData as LineRowForPayout;

  // 대상자 + 주차(라인은 단일 주차 — 실측 검증).
  const { data: tgtData } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id, week_id")
    .eq("line_id", lineId)
    .eq("target_mode", "user");
  const targets = (tgtData ?? []) as Array<{ target_user_id: string | null; week_id: string | null }>;
  const userIds = Array.from(new Set(targets.map((t) => t.target_user_id).filter((x): x is string => Boolean(x))));
  const weekIds = Array.from(new Set(targets.map((t) => t.week_id).filter((x): x is string => Boolean(x))));

  const configKey = await resolveLineConfigKey(row);

  // 대상자/주차/설정 미비 → 지급 없음. 기존 line award 가 있으면 회수(정합).
  if (userIds.length === 0 || weekIds.length === 0 || !configKey) {
    await revokeLineOpenAward(lineId);
    return { ok: true, accruedUserIds: [] };
  }
  if (weekIds.length > 1) {
    console.warn("[lineOpenAward] line spans multiple weeks — skip payout", { lineId, weekIds });
    return { ok: true, skipped: true, reason: "multi_week_line", accruedUserIds: [] };
  }

  const week = await loadWeek(weekIds[0]);
  if (!week) {
    await revokeLineOpenAward(lineId);
    return { ok: true, accruedUserIds: [] };
  }

  const lineOrg = (await resolveLineScope(row)).org; // slug | "common" | null
  const { pointA, pointB } = await loadLinePointForConfig(lineOrg, row.part_type, configKey);
  const aEnabled = pointA !== null;
  const bEnabled = pointB !== null;
  if (!aEnabled && !bEnabled) {
    // 지급 설정 없음(A·B 모두 null) → 미지급. 기존 있으면 회수.
    await revokeLineOpenAward(lineId);
    return { ok: true, accruedUserIds: [] };
  }

  // common/미상 라인은 org 제약 없이 mode 스코프만 검증(award org=null). 특정 org 라인은 그 org.
  const scopeOrg: OrganizationSlug | null = lineOrg && lineOrg !== "common" && isOrganizationSlug(lineOrg) ? lineOrg : null;
  const mode: ScopeMode = row.is_qa_test ? "test" : "operating";
  const desired: DesiredAward[] = userIds.map((uid) => ({
    userId: uid,
    pointCheck: aEnabled ? (pointA as number) : 0,
    pointAdvantage: bEnabled ? (pointB as number) : 0,
    pointPenalty: 0,
    bucket: "performer",
  }));

  return reconcileAwards({ source: "line", refId: lineId, week, org: scopeOrg, mode, desired });
}

// 라인 개설 포인트 회수 — 라인 취소/삭제 시 해당 line award 전량 제거 + 재합산.
export async function revokeLineOpenAward(lineId: string): Promise<{ revokedUserIds: string[] }> {
  return revokeForAct("line", lineId);
}

// ────────────────────────────────────────────────────────────────────────────
// 라인 개설 대상자 등록 시 Point A·B 즉시 지급 (source='line') — 2026-07-15 정책.
//   트리거 = "사용자가 해당 라인의 개설 대상자로 최초 등록되는 순간"(cluster4_line_targets 생성).
//   강화 성공/평가/마감과 완전 무관하게, 대상자로 등록되면 즉시 Point A·B 를 지급한다.
//   지급값 = /admin/lines/register 설정 SoT(cluster4_line_point_configs, org·hub·config_key).
//
//   ⚠ reconcileLineOpenAward(정합·회수형)와 달리 이 함수는 **순수 additive·pay-once** 다:
//     · 원장 UNIQUE (source='line', ref_id=line_id, user_id) → (라인,유저)당 평생 1행.
//     · 이미 지급된 유저는 절대 재지급/덮어쓰기 안 함(upsert ignoreDuplicates + 신규만 선별).
//     · 대상자 제외·라인 삭제·config 변경으로도 **회수하지 않는다**(이 함수는 삭제/revoke 무수행).
//     · 재호출·새로고침·재시도·snapshot 재생성·재개설·재등록 → 신규 유저 0 이면 no-op(멱등).
//   모드 중립: mode=is_qa_test?test:operating, org=resolveLineScope — 호출자(일반/test/actAs/demo)
//     와 무관하게 동일 DTO·동일 지급 경로. snapshot 은 write 시점 무효화만(조회 경로 지급 없음).
// ────────────────────────────────────────────────────────────────────────────
export async function payLineOpenTargetsOnce(lineId: string): Promise<AccrualResult> {
  if (!ACCRUAL_ENABLED) return { ok: true, skipped: true, reason: "accrual_disabled", accruedUserIds: [] };

  const { data: lineData } = await supabaseAdmin
    .from("cluster4_lines")
    .select(LINE_PAYOUT_SELECT)
    .eq("id", lineId)
    .maybeSingle();
  if (!lineData) return { ok: true, skipped: true, reason: "line_not_found", accruedUserIds: [] };
  const row = lineData as LineRowForPayout;

  // 개설 대상자(user 타깃) + 주차(라인=단일 주차).
  const { data: tgtData } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id, week_id")
    .eq("line_id", lineId)
    .eq("target_mode", "user");
  const targets = (tgtData ?? []) as Array<{ target_user_id: string | null; week_id: string | null }>;
  const userIds = Array.from(new Set(targets.map((t) => t.target_user_id).filter((x): x is string => Boolean(x))));
  const weekIds = Array.from(new Set(targets.map((t) => t.week_id).filter((x): x is string => Boolean(x))));

  const configKey = await resolveLineConfigKey(row);
  // 대상자/주차/설정 식별자 미비 → 지급 없음(회수 없음 — pay-once additive).
  if (userIds.length === 0 || weekIds.length === 0 || !configKey) {
    return { ok: true, accruedUserIds: [] };
  }
  if (weekIds.length > 1) {
    console.warn("[payLineOpenTargetsOnce] line spans multiple weeks — skip payout", { lineId, weekIds });
    return { ok: true, skipped: true, reason: "multi_week_line", accruedUserIds: [] };
  }

  const week = await loadWeek(weekIds[0]);
  if (!week) return { ok: true, accruedUserIds: [] };

  const mode: ScopeMode = row.is_qa_test ? "test" : "operating";
  // era 경계 — 미허용 주차(레거시)는 원장 미생성(과거 데이터 무접촉).
  if (!isAccrualAllowedWeek(mode, week)) {
    return { ok: true, skipped: true, reason: `era_blocked(${mode},${week.season_key} W${week.week_number})`, accruedUserIds: [] };
  }
  if (week.iso_year == null || week.iso_week == null) {
    return { ok: true, skipped: true, reason: "week_iso_missing", accruedUserIds: [] };
  }

  const lineOrg = (await resolveLineScope(row)).org; // slug | "common" | null
  const { pointA, pointB } = await loadLinePointForConfig(lineOrg, row.part_type, configKey);
  const payCheck = pointA ?? 0;
  const payAdvantage = pointB ?? 0;
  // 지급 없음 → 원장 미생성(회수 없음). A·B 모두 미설정(null) 또는 실질 0(불필요한 0/0 원장 방지).
  if (payCheck <= 0 && payAdvantage <= 0) return { ok: true, accruedUserIds: [] };

  // pay-once: 이 라인에 이미 지급된 유저는 제외하고 "신규 대상자"에게만 지급한다.
  const { data: existingRows, error: existErr } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id")
    .eq("source", "line")
    .eq("ref_id", lineId);
  if (existErr) throw existErr;
  const alreadyPaid = new Set(
    ((existingRows ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter((id): id is string => Boolean(id)),
  );
  const newUsers = userIds.filter((u) => !alreadyPaid.has(u));
  if (newUsers.length === 0) return { ok: true, accruedUserIds: [] }; // 멱등 no-op(전원 이미 지급).

  // 스코프 재검증(fail-closed) — 신규 대상자 전원이 (mode,org) 모집단이어야. 위반 시 throw(422).
  const scopeOrg: OrganizationSlug | null = lineOrg && lineOrg !== "common" && isOrganizationSlug(lineOrg) ? lineOrg : null;
  const scope = await resolveUserScope(mode, scopeOrg);
  assertUserIdsInScope(scope, newUsers);

  const nowIso = new Date().toISOString();
  const ledgerRows = newUsers.map((uid) => ({
    source: "line" as const,
    ref_id: lineId,
    user_id: uid,
    year: week.iso_year as number,
    week_number: week.iso_week as number,
    point_check: payCheck,
    point_advantage: payAdvantage,
    point_penalty: 0,
    organization_slug: scopeOrg,
    scope_mode: mode,
    updated_at: nowIso,
  }));
  // additive + dedup — 기존 (source,ref_id,user_id) 행은 절대 건드리지 않음(경합·중복 요청 안전).
  const { error: ledgerErr } = await supabaseAdmin
    .from("process_point_awards")
    .upsert(ledgerRows, { onConflict: "source,ref_id,user_id", ignoreDuplicates: true });
  if (ledgerErr) throw ledgerErr;

  // 신규 지급 유저만 재합산 + 등급 + snapshot 무효화(write 시점 — 조회 경로 무관).
  await settleAffectedUsers(newUsers, week);
  return { ok: true, accruedUserIds: newUsers };
}

// 포인트 설정 변경 시 — 해당 (hub, config_key) 에 연결된 현재 개설(active) 라인들의 지급값 재정합.
//   각 라인은 자기 org/설정을 독립 해석해 지급하므로 org 무관하게 매칭 라인 전체를 재실행한다(best-effort).
export async function reconcileLinePayoutsForConfig(
  hub: string,
  configKey: string,
): Promise<{ lineIds: string[] }> {
  if (!ACCRUAL_ENABLED) return { lineIds: [] };
  const idsOf = (d: unknown) => ((d ?? []) as Array<{ id: string }>).map((r) => r.id);
  let lineIds: string[] = [];

  if (hub === "info") {
    const { data } = await supabaseAdmin
      .from("cluster4_lines").select("id").eq("part_type", "info").eq("activity_type_id", configKey).eq("is_active", true);
    lineIds = idsOf(data);
  } else if (hub === "career") {
    const { data } = await supabaseAdmin
      .from("cluster4_lines").select("id").eq("part_type", "career").eq("line_code", configKey).eq("is_active", true);
    lineIds = idsOf(data);
  } else if (hub === "competency") {
    const { data: masters } = await supabaseAdmin
      .from("cluster4_competency_line_masters").select("id").eq("line_code", configKey);
    const mids = idsOf(masters);
    if (mids.length) {
      const { data } = await supabaseAdmin
        .from("cluster4_lines").select("id").eq("part_type", "competency").in("competency_line_master_id", mids).eq("is_active", true);
      lineIds = idsOf(data);
    }
  } else if (hub === "experience") {
    const cat = CONFIG_KEY_TO_EXP_CATEGORY[configKey];
    if (cat) {
      const { data: masters } = await supabaseAdmin
        .from("cluster4_experience_line_masters").select("id").eq("experience_category", cat);
      const mids = idsOf(masters);
      if (mids.length) {
        const { data } = await supabaseAdmin
          .from("cluster4_lines").select("id").eq("part_type", "experience").in("experience_line_master_id", mids).eq("is_active", true);
        lineIds = idsOf(data);
      }
    }
  }

  for (const id of lineIds) {
    try {
      await reconcileLineOpenAward(id);
    } catch (err) {
      console.warn("[lineOpenAward] reconcile-on-config-edit failed", { lineId: id, hub, configKey, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { lineIds };
}
