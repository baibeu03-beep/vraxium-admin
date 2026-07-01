// 프로세스 체크 완료 → 포인트 적립 (멱등 원장 기반).
// ─────────────────────────────────────────────────────────────────────
// 적립 SoT = process_point_awards(원장). user_weekly_points 는 원장 (user, year, week) 합으로
// 재계산한다(증분 금지 → 멱등). 적립 후 cluster4_weekly_card_snapshots 무효화로 고객앱 반영.
//   정규  : ref_id=process_check_statuses.id, 포인트=process_acts(point_check/advantage/penalty)
//   변동: ref_id=process_irregular_acts.id,  포인트=point_a/b/c
//   매핑   : point_check→points / point_advantage→advantages / point_penalty→penalty
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
import {
  assertUserIdsInScope,
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { isCluster4TestExceptionWeek } from "@/lib/cluster4TestWeekPolicy";
import { syncGradeStats } from "@/lib/cluster3ClubRankData";
import type { OrganizationSlug } from "@/lib/organizations";
import { isOrganizationSlug } from "@/lib/organizations";

export type AccrualSource = "regular" | "irregular";

// 적립 기능 kill-switch(운영 비활성 — 코드 무수정 롤백). 기본 활성.
const ACCRUAL_ENABLED = process.env.PROCESS_ACCRUAL_ENABLED !== "0";

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
};

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
async function recomputeWeeklyPoints(pairs: Array<{ userId: string; year: number; week: number; weekStartDate: string }>): Promise<void> {
  for (const p of pairs) {
    const { data, error } = await supabaseAdmin
      .from("process_point_awards")
      .select("point_check,point_advantage,point_penalty")
      .eq("user_id", p.userId)
      .eq("year", p.year)
      .eq("week_number", p.week);
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

// 공통 적립 코어 — 원장 upsert + user_weekly_points 재계산 + snapshot 무효화.
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

  const userIds = await loadMatchedUserIds(source, refId);
  if (userIds.length === 0) return { ok: true, accruedUserIds: [] };

  // 스코프 재검증(fail-closed) — test=test_user_markers만 / operating=실사용자만. 위반 시 throw(422).
  const scope = await resolveUserScope(mode, org);
  assertUserIdsInScope(scope, userIds);

  const year = week.iso_year;
  const wk = week.iso_week;
  // 원장 멱등 upsert(UNIQUE source,ref_id,user_id).
  const ledgerRows = userIds.map((uid) => ({
    source,
    ref_id: refId,
    user_id: uid,
    year,
    week_number: wk,
    point_check: input.pointCheck,
    point_advantage: input.pointAdvantage,
    point_penalty: input.pointPenalty,
    organization_slug: org,
    scope_mode: mode,
    updated_at: new Date().toISOString(),
  }));
  const { error: ledgerErr } = await supabaseAdmin
    .from("process_point_awards")
    .upsert(ledgerRows, { onConflict: "source,ref_id,user_id" });
  if (ledgerErr) throw ledgerErr;

  await recomputeWeeklyPoints(userIds.map((uid) => ({ userId: uid, year, week: wk, weekStartDate: week.start_date })));
  // 등급 당사자 즉시 갱신(user_weekly_points 반영 이후) — snapshot 무효화와 독립.
  await syncGradesBestEffort(userIds);
  await invalidateWeeklyCardsForUsers(userIds);
  return { ok: true, accruedUserIds: userIds };
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
  completion_type?: string | null;
  manual_point_check?: number | null;
  manual_point_advantage?: number | null;
  manual_point_penalty?: number | null;
};

// 정규 프로세스 체크 완료 적립 (ref_id = process_check_statuses.id).
//   - 검수/worker 완료(completion_type=NULL) → 마스터(process_acts) 점수.
//   - 수동 입력(completion_type='manual_grant') → 상태 행 manual_point_*(자유 입력) override 점수.
export async function accrueForCompletedRegular(statusId: string): Promise<AccrualResult> {
  // completion_type/manual_point_* 포함 select(미적용이면 컬럼 누락 → base 폴백 = 마스터 점수만).
  const full = await supabaseAdmin
    .from("process_check_statuses")
    .select(
      "id,week_id,act_id,scope_mode,organization_slug,completion_type,manual_point_check,manual_point_advantage,manual_point_penalty",
    )
    .eq("id", statusId)
    .maybeSingle();
  let st = full.data as RegularStatusRow | null;
  if (full.error) {
    const code = (full.error as { code?: string }).code;
    if (code === "42703" || code === "PGRST204" || code === "PGRST205") {
      const base = await supabaseAdmin
        .from("process_check_statuses")
        .select("id,week_id,act_id,scope_mode,organization_slug")
        .eq("id", statusId)
        .maybeSingle();
      st = base.data as RegularStatusRow | null;
    }
  }
  if (!st) return { ok: true, skipped: true, reason: "status_not_found", accruedUserIds: [] };
  const row = st;

  let pointCheck: number;
  let pointAdvantage: number;
  let pointPenalty: number;
  if (row.completion_type === "manual_grant") {
    // 수동 입력 — 자유 입력 override 점수(선별 규칙상 C=0).
    pointCheck = row.manual_point_check ?? 0;
    pointAdvantage = row.manual_point_advantage ?? 0;
    pointPenalty = row.manual_point_penalty ?? 0;
  } else {
    const { data: act } = await supabaseAdmin
      .from("process_acts")
      .select("point_check,point_advantage,point_penalty")
      .eq("id", row.act_id)
      .maybeSingle();
    if (!act) return { ok: true, skipped: true, reason: "act_not_found", accruedUserIds: [] };
    const a = act as { point_check: number; point_advantage: number; point_penalty: number };
    pointCheck = a.point_check ?? 0;
    pointAdvantage = a.point_advantage ?? 0;
    pointPenalty = a.point_penalty ?? 0;
  }

  const week = await loadWeek(row.week_id);
  if (!week) return { ok: true, skipped: true, reason: "week_not_found", accruedUserIds: [] };
  return applyAward({
    source: "regular",
    refId: statusId,
    week,
    org: isOrganizationSlug(row.organization_slug) ? row.organization_slug : null,
    mode: row.scope_mode === "test" ? "test" : "operating",
    pointCheck,
    pointAdvantage,
    pointPenalty,
  });
}

// 변동 액트 완료 적립 (ref_id = process_irregular_acts.id).
export async function accrueForCompletedIrregular(actId: string): Promise<AccrualResult> {
  const { data: act } = await supabaseAdmin
    .from("process_irregular_acts")
    .select("id,week_id,point_a,point_b,point_c,scope_mode,organization_slug")
    .eq("id", actId)
    .maybeSingle();
  if (!act) return { ok: true, skipped: true, reason: "irregular_not_found", accruedUserIds: [] };
  const row = act as {
    week_id: string; point_a: number; point_b: number; point_c: number;
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
