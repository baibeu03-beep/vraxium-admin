// 검수 완료(주차 결과 확정) 시 user_week_statuses(uws) 생성/갱신 — 2026-summer+ 운영 주차 전용.
//
// 설계: claudedocs/uws-operating-week-creation-design.md
//
// 배경: 런타임에 uws 를 만드는 코드가 없어(이관 스크립트 전용) 2026-summer 참여자는 uws 가 없고,
//   검수 완료로 공표하면 resolver 가 "공표됨+uws없음"을 no_data 로 드롭 → 카드가 사라진다.
//   본 모듈은 검수 완료를 "주차 결과 확정 및 uws persist" 이벤트로 정식화한다.
//
// 불변식:
//   - 프로세스 포인트 적립 로직(process_point_awards/user_weekly_points)은 절대 변경하지 않는다.
//     verdict 엔진을 통해 user_weekly_points.points 를 읽기만 한다(쓰기 대상=user_week_statuses).
//   - 레거시(2026-summer W1 이전) 주차는 uws 생성 대상이 아니다(호출부가 게이트).
//   - 공식 휴식 주차 / 현재·미래 주차는 uws 를 만들지 않는다(resolver 가 판정).
//   - 기존 personal_rest/official_rest uws 는 verdict 로 덮지 않는다(휴식 우선).
//   - pending(평가 미입력) verdict 가 하나라도 있으면 검수 완료를 차단한다(임의 확정 금지).
//   - not_applicable(경험 슬롯 미개설) 은 임의 fail 하지 않고 uws 를 만들지 않는다(skip).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import {
  fetchExperienceRequiredSlotStatusByWeek,
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
} from "@/lib/lineAvailability";
import { deriveEndStatus } from "@/lib/growthCore";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import type { StateScope } from "@/lib/operationalState";

const RUN_LOG_TABLE = "cluster4_week_finalize_runs";

export type FinalizeWeekRow = {
  id: string;
  start_date: string | null;
  end_date: string | null;
  season_key: string | null;
  iso_year: number | null;
  iso_week: number | null;
  is_official_rest: boolean | null;
};

// ── 안전장치: 적립 미완료 시 차단 ──────────────────────────────────────────
export type AccrualGateResult = {
  ok: boolean;
  reason: string | null; // 관리자 안내 메시지(차단 시)
  pendingChecks: number;
  pendingIrregular: number;
  awardCount: number;
};

// 그 주차의 프로세스 체크 적립이 끝났는지 검사한다.
//   check 게이트는 user_weekly_points.points(행 없으면 0)를 읽으므로, 적립 전에 검수 완료하면
//   전원 earned=0 → 전원 fail 확정 사고가 난다. 이를 막는다.
//   차단 조건: (1) 미완료(pending) 정규 체크 존재  (2) 미완료 변동 review_request 존재
//             (3) 적립 기록 0 인데 그 주차에 체크 상태가 존재(적립 미실행 의심).
export async function assertWeekAccrualComplete(
  week: FinalizeWeekRow,
): Promise<AccrualGateResult> {
  const weekId = week.id;
  const [pendReg, pendIrr, statusCount, awardCount] = await Promise.all([
    supabaseAdmin
      .from("process_check_statuses")
      .select("id", { count: "exact", head: true })
      .eq("week_id", weekId)
      .eq("status", "pending"),
    supabaseAdmin
      .from("process_irregular_acts")
      .select("id", { count: "exact", head: true })
      .eq("week_id", weekId)
      .eq("kind", "review_request")
      .eq("status", "pending"),
    supabaseAdmin
      .from("process_check_statuses")
      .select("id", { count: "exact", head: true })
      .eq("week_id", weekId),
    week.iso_year != null && week.iso_week != null
      ? supabaseAdmin
          .from("process_point_awards")
          .select("id", { count: "exact", head: true })
          .eq("year", week.iso_year)
          .eq("week_number", week.iso_week)
      : Promise.resolve({ count: 0 } as { count: number | null }),
  ]);

  const pendingChecks = pendReg.count ?? 0;
  const pendingIrregular = pendIrr.count ?? 0;
  const totalStatuses = statusCount.count ?? 0;
  const awards = (awardCount as { count: number | null }).count ?? 0;

  if (pendingChecks > 0 || pendingIrregular > 0) {
    return {
      ok: false,
      reason:
        "프로세스 체크 적립이 완료된 뒤 검수 완료를 진행해주세요. " +
        `(미완료 체크 ${pendingChecks + pendingIrregular}건)`,
      pendingChecks,
      pendingIrregular,
      awardCount: awards,
    };
  }
  if (awards === 0 && totalStatuses > 0) {
    return {
      ok: false,
      reason:
        "프로세스 체크 적립이 완료된 뒤 검수 완료를 진행해주세요. " +
        "(이 주차 포인트 적립 기록이 없습니다 — 적립을 먼저 실행해주세요.)",
      pendingChecks,
      pendingIrregular,
      awardCount: awards,
    };
  }
  return { ok: true, reason: null, pendingChecks, pendingIrregular, awardCount: awards };
}

// ── 코호트: 그 주차 시즌 참여자(전 org) — roster 기반(uws 기반 아님) ──────────
type CohortMember = { userId: string; org: OrganizationSlug | null; seasonRest: boolean };

// season_key 참여자(user_season_statuses) ∩ (test/QA 정책) − 성장 중단.
//   ⚠ org 스코프 = 전체(옵션 A) — 전역 공표라 전체 org 참여자 uws 를 만들어야 no_data 드롭이
//   oranke/phalanx 에서도 재발하지 않는다. 각 유저의 org 는 verdict 기준값(org_week_thresholds) 해석용.
export async function loadFinalizeCohort(
  seasonKey: string,
  scope: StateScope,
): Promise<CohortMember[]> {
  const [{ data: ussData, error: ussErr }, testIds] = await Promise.all([
    supabaseAdmin
      .from("user_season_statuses")
      .select("user_id,status")
      .eq("season_key", seasonKey),
    fetchTestUserMarkerIds(),
  ]);
  if (ussErr) throw new Error(`시즌 참여자 조회 실패: ${ussErr.message}`);

  const keepTestOnly = QA_HIDE_REAL_USERS || scope === "qa";
  // user 당 1행(중복 방어). 시즌 전체 휴식(status='rest')은 seasonRest 로 표시.
  const byUser = new Map<string, { seasonRest: boolean }>();
  for (const r of (ussData ?? []) as { user_id: string; status: string }[]) {
    const isTest = testIds.has(r.user_id);
    if (keepTestOnly ? !isTest : isTest) continue;
    const prev = byUser.get(r.user_id);
    const seasonRest = r.status === "rest";
    if (!prev) byUser.set(r.user_id, { seasonRest });
    else if (seasonRest) prev.seasonRest = true;
  }
  const userIds = Array.from(byUser.keys());
  if (userIds.length === 0) return [];

  // org + 성장 중단 필터 (user_profiles). 성장 중단(suspended/paused)은 코호트 제외
  //   (카드가 read-time truncate 되므로 uws 를 만들 이유가 없다 — 설계 §2.2).
  const orgByUser = new Map<string, OrganizationSlug | null>();
  const stopped = new Set<string>();
  const CHUNK = 300;
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug,growth_status")
      .in("user_id", chunk);
    if (error) throw new Error(`프로필 조회 실패: ${error.message}`);
    for (const p of (data ?? []) as Array<{
      user_id: string;
      organization_slug: string | null;
      growth_status: string | null;
    }>) {
      orgByUser.set(p.user_id, isOrganizationSlug(p.organization_slug) ? p.organization_slug : null);
      if (deriveEndStatus(p.growth_status) === "stopped") stopped.add(p.user_id);
    }
  }

  const out: CohortMember[] = [];
  for (const [userId, meta] of byUser) {
    if (stopped.has(userId)) continue;
    out.push({ userId, org: orgByUser.get(userId) ?? null, seasonRest: meta.seasonRest });
  }
  return out;
}

// ── 개인 휴식(주차) 감지: crew_personal_rest_periods overlap ─────────────────
async function loadRestUserIds(
  cohortUserIds: string[],
  weekStart: string,
  weekEnd: string,
): Promise<Set<string>> {
  const rest = new Set<string>();
  if (cohortUserIds.length === 0) return rest;
  const CHUNK = 300;
  for (let i = 0; i < cohortUserIds.length; i += CHUNK) {
    const chunk = cohortUserIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("crew_personal_rest_periods")
      .select("user_id,start_date,end_date")
      .in("user_id", chunk)
      .lte("start_date", weekEnd)
      .gte("end_date", weekStart);
    if (error) {
      console.warn("[uws-finalize] rest period 조회 실패(무시)", error.message);
      continue;
    }
    for (const r of (data ?? []) as { user_id: string }[]) rest.add(r.user_id);
  }
  return rest;
}

// ── uws 확정값 계산 결과 ────────────────────────────────────────────────────
export type UwsStatusValue = "success" | "fail" | "personal_rest";
export type UserVerdict =
  | { userId: string; kind: "status"; status: UwsStatusValue }
  | { userId: string; kind: "pending" } // 평가 미입력 → 검수 완료 차단 사유
  | { userId: string; kind: "skip"; reason: string }; // not_applicable / no-verdict → uws 미생성

// 코호트 각 유저의 그 주차 verdict 를 계산한다(기존 엔진 재사용, 새 공식 없음).
async function computeUserVerdicts(
  cohort: CohortMember[],
  week: FinalizeWeekRow,
  restUserIds: Set<string>,
  now: number,
): Promise<UserVerdict[]> {
  const weekId = week.id;
  const alwaysOpen = new Set<string>([weekId]); // 공표된 신정책 주차 = 필수 슬롯 항상-개설
  const results: UserVerdict[] = new Array(cohort.length);
  let cursor = 0;
  const CONCURRENCY = 6;

  async function worker() {
    while (cursor < cohort.length) {
      const idx = cursor++;
      const m = cohort[idx];
      // 1) 휴식 우선: 시즌 전체 휴식 또는 그 주차 개인 휴식 → personal_rest.
      if (m.seasonRest || restUserIds.has(m.userId)) {
        results[idx] = { userId: m.userId, kind: "status", status: "personal_rest" };
        continue;
      }
      // 2) 경험 필수 슬롯 verdict(check 게이트 내장) — 기존 엔진 그대로.
      try {
        const vmap = await fetchExperienceRequiredSlotStatusByWeek(m.userId, [weekId], now, {
          alwaysOpenWeekIds: alwaysOpen,
          organizationSlug: m.org,
        });
        const v = vmap.get(weekId);
        if (!v || v.status === "not_applicable") {
          results[idx] = { userId: m.userId, kind: "skip", reason: "not_applicable" };
        } else if (v.status === "pending") {
          results[idx] = { userId: m.userId, kind: "pending" };
        } else if (v.status === "pass") {
          results[idx] = { userId: m.userId, kind: "status", status: "success" };
        } else {
          results[idx] = { userId: m.userId, kind: "status", status: "fail" };
        }
      } catch (e) {
        // verdict 계산 실패 = 확정 불가 → skip(안전). 로그만.
        console.warn("[uws-finalize] verdict 계산 실패(skip)", {
          userId: m.userId,
          message: e instanceof Error ? e.message : String(e),
        });
        results[idx] = { userId: m.userId, kind: "skip", reason: "verdict_error" };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cohort.length) }, () => worker()));
  return results;
}

// ── 최종 결과 ───────────────────────────────────────────────────────────────
export type FinalizeUwsResult = {
  skipped: boolean; // uws 생성 자체를 안 함(레거시/공식휴식/현재·미래/코호트0)
  skipReason?: string;
  createdIds: string[];
  updated: Array<{ id: string; prevStatus: string }>;
  cohortCount: number;
  successCount: number;
  failCount: number;
  restCount: number;
  skippedUsers: number; // not_applicable 등
  affectedUserIds: string[]; // 실제 생성/갱신된 uws 의 user_id (snapshot·growth 재계산 대상)
  runId: string | null;
};

export class UwsFinalizeBlockedError extends Error {
  status = 422;
  code: "accrual_incomplete" | "pending_evaluation";
  pendingUserIds: string[];
  constructor(
    message: string,
    code: "accrual_incomplete" | "pending_evaluation",
    pendingUserIds: string[] = [],
  ) {
    super(message);
    this.name = "UwsFinalizeBlockedError";
    this.code = code;
    this.pendingUserIds = pendingUserIds;
  }
}

// 검수 완료의 uws 확정 단계 (§1 [1]~[3] + run-log).
//   호출 순서: 이 함수(uws 확정) → 공표 → snapshot 재계산 → recalc → 검수. 순서는 호출부 책임.
//   반환: 생성/갱신 provenance(롤백용). pending 있으면 throw(UwsFinalizeBlockedError).
export async function finalizeWeekUws(
  week: FinalizeWeekRow,
  scope: StateScope,
  actor: string | null,
  opts: { allowIncompleteTestData?: boolean } = {},
): Promise<FinalizeUwsResult> {
  // ⚠ 안전장치 bypass 는 test/QA 스코프에서만 허용한다. operating 실유저 경로에서는 플래그가
  //   있어도 무시(guard 유지) — 실유저 mass-fail 사고 절대 방지. 코호트도 scope 로 test-only 로 좁혀진다.
  const bypass =
    opts.allowIncompleteTestData === true && (scope === "qa" || QA_HIDE_REAL_USERS);
  if (opts.allowIncompleteTestData === true && !bypass) {
    console.warn(
      "[uws-finalize] allowIncompleteTestData 무시 — operating 실유저 스코프에서는 강제 진행 불가",
      { weekId: week.id, scope, qaHide: QA_HIDE_REAL_USERS },
    );
  }
  const empty = (skipReason: string): FinalizeUwsResult => ({
    skipped: true,
    skipReason,
    createdIds: [],
    updated: [],
    cohortCount: 0,
    successCount: 0,
    failCount: 0,
    restCount: 0,
    skippedUsers: 0,
    affectedUserIds: [],
    runId: null,
  });

  // 게이트: 레거시 / 공식휴식 / 현재·미래 / 필수 메타 부재 → uws 생성 안 함.
  if (!week.start_date || !week.season_key || week.iso_year == null || week.iso_week == null) {
    return empty("week_meta_missing");
  }
  if (week.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) return empty("legacy_week");
  if (week.is_official_rest === true) return empty("official_rest_week");
  const currentWeekStartMs = getCurrentWeekStartMs(getCurrentActivityDateIso());
  const weekStartMs = Date.parse(`${week.start_date}T00:00:00Z`);
  if (currentWeekStartMs != null && weekStartMs >= currentWeekStartMs) {
    return empty("current_or_future_week");
  }

  // 안전장치: 이 주차의 프로세스 포인트 적립이 끝났는지. 미완료면 차단(전원 0점 fail 방지).
  //   실제 uws 생성 대상 주차(레거시·공식휴식·현재미래 게이트 통과)에서만 검사한다.
  //   bypass(test/QA + 명시 플래그) 시에는 건너뛴다(불완전 테스트 데이터 흐름 검증).
  if (!bypass) {
    const gate = await assertWeekAccrualComplete(week);
    if (!gate.ok) {
      throw new UwsFinalizeBlockedError(gate.reason ?? "적립이 완료되지 않았습니다.", "accrual_incomplete");
    }
  }

  const cohort = await loadFinalizeCohort(week.season_key, scope);
  if (cohort.length === 0) return empty("empty_cohort");

  const weekEnd =
    week.end_date ?? new Date(weekStartMs + 6 * 86_400_000).toISOString().slice(0, 10);
  const restUserIds = await loadRestUserIds(
    cohort.map((m) => m.userId),
    week.start_date,
    weekEnd,
  );

  const verdicts = await computeUserVerdicts(cohort, week, restUserIds, Date.now());

  // ⚠ 라인 미개설 mass-fail 방지 (2026-07-08 실측 발견):
  //   신정책 주차는 필수 슬롯을 "항상-개설"로 보므로, 실무 경험 라인이 하나도 생성되지 않은 주차는
  //   전원 required_fail(빈 슬롯)로 계산된다. 이 상태로 확정하면 전원 '성장 실패'가 찍히는 사고가 난다.
  //   → 그 주차에 실무 경험 라인(cluster4_lines part_type='experience')이 0개이고, 계산 결과가
  //     "성공 0 · 휴식 제외 전원 fail" 이면 확정을 차단한다(라인 개설·결과 입력 후 재검수 유도).
  //   bypass(test/QA + 명시 플래그) 시에는 이 가드를 건너뛴다 — 불완전 테스트 데이터로 fail 저장 흐름 검증.
  if (!bypass) {
    const { count: expLineCount } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id", { count: "exact", head: true })
      .eq("week_id", week.id)
      .eq("part_type", "experience");
    const nonRest = verdicts.filter((v) => !(v.kind === "status" && v.status === "personal_rest"));
    const allFail =
      nonRest.length > 0 &&
      nonRest.every((v) => v.kind === "status" && v.status === "fail");
    if ((expLineCount ?? 0) === 0 && allFail) {
      throw new UwsFinalizeBlockedError(
        "이 주차에 실무 경험 라인이 개설되지 않아 대상자 전원이 '성장 실패'로 확정될 수 있습니다. " +
          "라인 개설·결과 입력을 완료한 뒤 검수 완료를 진행해주세요.",
        "accrual_incomplete",
      );
    }
  } else {
    console.warn("[uws-finalize] 안전장치 bypass(test/QA) — mass-fail 가드 건너뜀", { weekId: week.id, scope });
  }

  // pending 이 하나라도 있으면 전체 차단(임의 확정 금지) — 관리자가 평가 입력 후 재검수.
  //   bypass 시에는 차단하지 않고 pending 유저를 skip(uws 미생성)으로 흘려 흐름을 검증한다.
  const pendingUserIds = verdicts.filter((v) => v.kind === "pending").map((v) => v.userId);
  if (pendingUserIds.length > 0 && !bypass) {
    throw new UwsFinalizeBlockedError(
      `아직 평가가 입력되지 않은 대상자가 ${pendingUserIds.length}명 있어 검수 완료할 수 없습니다. ` +
        "실무 경험 평가를 완료한 뒤 다시 시도해주세요.",
      "pending_evaluation",
      pendingUserIds,
    );
  }

  // 확정 대상(status) 만 추림.
  const toWrite = verdicts.filter(
    (v): v is Extract<UserVerdict, { kind: "status" }> => v.kind === "status",
  );
  const skippedUsers = verdicts.filter((v) => v.kind === "skip").length;

  // 기존 uws 조회(생성 vs 갱신 판별 + 휴식 보호).
  const writeUserIds = toWrite.map((v) => v.userId);
  const existingByUser = new Map<string, { id: string; status: string }>();
  const CHUNK = 300;
  for (let i = 0; i < writeUserIds.length; i += CHUNK) {
    const chunk = writeUserIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("user_week_statuses")
      .select("id,user_id,status")
      .eq("week_start_date", week.start_date)
      .in("user_id", chunk);
    if (error) throw new Error(`기존 uws 조회 실패: ${error.message}`);
    for (const r of (data ?? []) as { id: string; user_id: string; status: string }[]) {
      if (!existingByUser.has(r.user_id)) existingByUser.set(r.user_id, { id: r.id, status: r.status });
    }
  }

  const createdIds: string[] = [];
  const updated: Array<{ id: string; prevStatus: string }> = [];
  const affectedUserIds: string[] = [];
  let successCount = 0;
  let failCount = 0;
  let restCount = 0;
  const nowIso = new Date().toISOString();

  for (const v of toWrite) {
    const existing = existingByUser.get(v.userId);
    if (existing) {
      // 기존 휴식(personal/official) uws 는 verdict 로 덮지 않는다(휴식 우선 보호).
      if (existing.status === "personal_rest" || existing.status === "official_rest") continue;
      if (existing.status === v.status) {
        // 멱등 no-op 이지만 카운트에는 반영(관찰용).
        if (v.status === "success") successCount++;
        else if (v.status === "fail") failCount++;
        else restCount++;
        continue;
      }
      const { error } = await supabaseAdmin
        .from("user_week_statuses")
        .update({ status: v.status, updated_at: nowIso })
        .eq("id", existing.id);
      if (error) {
        console.warn("[uws-finalize] uws update 실패(격리)", { userId: v.userId, message: error.message });
        continue;
      }
      updated.push({ id: existing.id, prevStatus: existing.status });
      affectedUserIds.push(v.userId);
    } else {
      const { data, error } = await supabaseAdmin
        .from("user_week_statuses")
        .insert({
          user_id: v.userId,
          year: week.iso_year,
          week_number: week.iso_week,
          week_start_date: week.start_date,
          season_key: week.season_key,
          status: v.status,
          is_official_rest_override: false,
        })
        .select("id")
        .single();
      if (error || !data) {
        console.warn("[uws-finalize] uws insert 실패(격리)", { userId: v.userId, message: error?.message });
        continue;
      }
      createdIds.push((data as { id: string }).id);
      affectedUserIds.push(v.userId);
    }
    if (v.status === "success") successCount++;
    else if (v.status === "fail") failCount++;
    else restCount++;
  }

  // run-log 기록(롤백 provenance). 테이블 미적용이면 경고만(생성은 유지·롤백 제한).
  let runId: string | null = null;
  if (createdIds.length > 0 || updated.length > 0) {
    const { data, error } = await supabaseAdmin
      .from(RUN_LOG_TABLE)
      .insert({
        week_id: week.id,
        scope,
        actor_id: actor,
        created_uws_ids: createdIds,
        updated_uws: updated.map((u) => ({ id: u.id, prev_status: u.prevStatus })),
        cohort_count: cohort.length,
        success_count: successCount,
        fail_count: failCount,
        rest_count: restCount,
        skipped_count: skippedUsers,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.warn(
        "[uws-finalize] run-log 기록 실패 — 롤백 provenance 미저장(마이그레이션 미적용?)",
        { weekId: week.id, message: error?.message },
      );
    } else {
      runId = (data as { id: string }).id;
    }
  }

  return {
    skipped: false,
    createdIds,
    updated,
    cohortCount: cohort.length,
    successCount,
    failCount,
    restCount,
    skippedUsers,
    affectedUserIds,
    runId,
  };
}

// ── 실행 취소: 최신 run-log 로 uws 생성/갱신을 되돌린다 ───────────────────────
export type RevertUwsResult = {
  reverted: boolean;
  deletedUws: number;
  restoredUws: number;
  affectedUserIds: string[];
  runId: string | null;
};

// 이 주차의 아직 되돌리지 않은 최신 run 을 찾아: 생성 uws DELETE + 갱신 uws prev_status 복원.
//   되돌린 뒤 run.reverted_at 세팅(재롤백 방지). run-log 없으면 no-op(경고).
export async function revertWeekUws(weekId: string): Promise<RevertUwsResult> {
  const { data: runData, error: runErr } = await supabaseAdmin
    .from(RUN_LOG_TABLE)
    .select("id,created_uws_ids,updated_uws")
    .eq("week_id", weekId)
    .is("reverted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runErr) {
    console.warn("[uws-finalize] run-log 조회 실패 → uws 롤백 생략", runErr.message);
    return { reverted: false, deletedUws: 0, restoredUws: 0, affectedUserIds: [], runId: null };
  }
  const run = runData as
    | { id: string; created_uws_ids: string[] | null; updated_uws: Array<{ id: string; prev_status: string }> | null }
    | null;
  if (!run) {
    return { reverted: false, deletedUws: 0, restoredUws: 0, affectedUserIds: [], runId: null };
  }

  const affected = new Set<string>();
  const createdIds = run.created_uws_ids ?? [];
  const updates = run.updated_uws ?? [];

  // 생성 uws 의 user 수집(스냅샷 재계산용) 후 삭제.
  let deletedUws = 0;
  if (createdIds.length > 0) {
    const { data: rows } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id")
      .in("id", createdIds);
    for (const r of (rows ?? []) as { user_id: string }[]) affected.add(r.user_id);
    const { data: del, error: delErr } = await supabaseAdmin
      .from("user_week_statuses")
      .delete()
      .in("id", createdIds)
      .select("id");
    if (delErr) console.warn("[uws-finalize] 생성 uws 삭제 실패", delErr.message);
    else deletedUws = (del ?? []).length;
  }

  // 갱신 uws 를 prev_status 로 복원.
  let restoredUws = 0;
  for (const u of updates) {
    const { data: rows } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id")
      .eq("id", u.id)
      .maybeSingle();
    const uid = (rows as { user_id: string } | null)?.user_id;
    if (uid) affected.add(uid);
    const { error } = await supabaseAdmin
      .from("user_week_statuses")
      .update({ status: u.prev_status, updated_at: new Date().toISOString() })
      .eq("id", u.id);
    if (error) console.warn("[uws-finalize] uws 복원 실패", { id: u.id, message: error.message });
    else restoredUws++;
  }

  await supabaseAdmin
    .from(RUN_LOG_TABLE)
    .update({ reverted_at: new Date().toISOString() })
    .eq("id", run.id);

  return {
    reverted: deletedUws > 0 || restoredUws > 0,
    deletedUws,
    restoredUws,
    affectedUserIds: Array.from(affected),
    runId: run.id,
  };
}
