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
  fetchWeekRecognitionRequiredByOrg,
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
} from "@/lib/lineAvailability";
import { deriveEndStatus } from "@/lib/growthCore";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import type { StateScope } from "@/lib/operationalState";
import { isActOpenForWeek } from "@/lib/weekOpenGate";
// ⚠ 타입만 import(런타임 순환 방지 — adminTeamPartsInfoWeekDetailData 는 이 모듈을 런타임 import 한다).
import type { SavedConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";

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

// 주차별·org별 오픈 설정 캐시 로더 — cluster4_week_opening_configs(loadWeekOpeningConfig 와 동일 SoT).
//   ⚠ 순환 import 방지로 직접 조회(adminTeamPartsInfoWeekDetailData 를 런타임 import 하지 않는다).
async function loadOpeningConfigForOrg(
  weekId: string,
  organization: string,
): Promise<{ config: SavedConfig | null; openConfirmed: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("config,open_confirmed")
    .eq("week_id", weekId)
    .eq("organization_slug", organization)
    .maybeSingle();
  if (error) {
    // config 조회 불가 → openConfirmed=false(미가동 간주). weekOpenGate 와 동일 fail-closed.
    console.warn("[uws-finalize] opening config 조회 실패(미가동 간주)", { weekId, organization, message: error.message });
    return { config: null, openConfirmed: false };
  }
  const row = data as { config: SavedConfig | null; open_confirmed: boolean } | null;
  return { config: row?.config ?? null, openConfirmed: row?.open_confirmed === true };
}

// 그 주차의 정규 체크 상태를 /admin/processes/check 와 **동일한 유효 체크 대상 기준**으로 집계한다.
//   유효 = act.is_active && act.check_target==='check' && isActOpenForWeek(오픈확인+라인급/팀 선택)
//          && scope_mode===effMode(검수 코호트와 동일 모드).
//   반환: { pending: 유효+status='pending' 수, total: 유효 상태행 수(모든 status) }.
//   비활성·none·미가동·타모드 액트의 잔존 상태행은 pending/total 어디에도 포함하지 않는다(체크 페이지·코호트와 정합).
async function countValidOpenCheckStatuses(
  week: FinalizeWeekRow,
  effMode: "operating" | "test",
  organization?: OrganizationSlug,
): Promise<{ pending: number; total: number }> {
  const weekId = week.id;
  let rowsQuery = supabaseAdmin
    .from("process_check_statuses")
    .select("id,organization_slug,hub,line_group_id,act_id,team_id,status,scope_mode")
    .eq("week_id", weekId)
    .eq("scope_mode", effMode);
  if (organization) rowsQuery = rowsQuery.eq("organization_slug", organization);
  const { data: rows, error } = await rowsQuery;
  if (error) {
    // 조회 실패 시에도 동일 org/mode scope를 유지한 raw count로 폴백한다.
    console.warn("[uws-finalize] 체크 상태 조회 실패 — raw count 폴백", { weekId, message: error.message });
    let pendingQuery = supabaseAdmin.from("process_check_statuses").select("id", { count: "exact", head: true }).eq("week_id", weekId).eq("scope_mode", effMode).eq("status", "pending");
    let totalQuery = supabaseAdmin.from("process_check_statuses").select("id", { count: "exact", head: true }).eq("week_id", weekId).eq("scope_mode", effMode);
    if (organization) {
      pendingQuery = pendingQuery.eq("organization_slug", organization);
      totalQuery = totalQuery.eq("organization_slug", organization);
    }
    const [{ count: p }, { count: t }] = await Promise.all([pendingQuery, totalQuery]);
    return { pending: p ?? 0, total: t ?? 0 };
  }
  const statusRows = (rows ?? []) as Array<{
    id: string;
    organization_slug: string;
    hub: string;
    line_group_id: string | null;
    act_id: string;
    team_id: string | null;
    status: string;
  }>;
  if (statusRows.length === 0) return { pending: 0, total: 0 };

  // 액트 마스터(is_active·check_target·line_group_id) 배치 조회.
  const actIds = [...new Set(statusRows.map((r) => r.act_id))];
  const actById = new Map<string, { is_active: boolean; check_target: string; line_group_id: string | null }>();
  const ACT_CHUNK = 300;
  for (let i = 0; i < actIds.length; i += ACT_CHUNK) {
    const chunk = actIds.slice(i, i + ACT_CHUNK);
    const { data: acts } = await supabaseAdmin
      .from("process_acts")
      .select("id,is_active,check_target,line_group_id")
      .in("id", chunk);
    for (const a of (acts ?? []) as Array<{ id: string; is_active: boolean; check_target: string; line_group_id: string | null }>) {
      actById.set(a.id, { is_active: a.is_active, check_target: a.check_target, line_group_id: a.line_group_id });
    }
  }

  // org 별 오픈 설정 1회 로드(캐시).
  const orgs = [...new Set(statusRows.map((r) => r.organization_slug))];
  const cfgByOrg = new Map<string, { config: SavedConfig | null; openConfirmed: boolean }>();
  for (const org of orgs) cfgByOrg.set(org, await loadOpeningConfigForOrg(weekId, org));

  let pending = 0;
  let total = 0;
  for (const r of statusRows) {
    const act = actById.get(r.act_id);
    if (!act) continue; // 액트 마스터 부재(고아) → 유효 대상 아님.
    if (act.is_active !== true) continue; // 비활성 → 제외.
    if (act.check_target !== "check") continue; // 체크 대상 아님(none) → 제외.
    const cfg = cfgByOrg.get(r.organization_slug) ?? { config: null, openConfirmed: false };
    const open = isActOpenForWeek({
      hub: r.hub,
      openConfirmed: cfg.openConfirmed,
      config: cfg.config,
      lineGroupId: act.line_group_id, // 체크 보드와 동일하게 액트 마스터의 라인급 사용.
      teamId: r.team_id,
    });
    if (!open) continue; // 미가동(미오픈) → 제외.
    total++;
    if (r.status === "pending") pending++;
  }
  return { pending, total };
}

// 그 주차의 프로세스 체크 적립이 끝났는지 검사한다.
//   check 게이트는 user_weekly_points.points(행 없으면 0)를 읽으므로, 적립 전에 검수 완료하면
//   전원 earned=0 → 전원 fail 확정 사고가 난다. 이를 막는다.
//   차단 조건: (1) 미완료(pending) 정규 체크 존재  (2) 미완료 변동 review_request 존재
//             (3) 적립 기록 0 인데 그 주차에 유효 체크 대상이 존재(적립 미실행 의심).
//   ⚠ 정규 체크 pending/집계는 /admin/processes/check 와 **동일한 유효 체크 대상 SoT** 로 좁힌다:
//     act.is_active && check_target='check' && isActOpenForWeek(오픈확인+소속 라인급/팀 선택).
//     비활성·체크대상아님(none)·미가동(미오픈) 액트의 잔존 pending 행은 분모·미완료 수에서 제외한다
//     (체크 페이지가 targetActs 에서 제외하는 것과 정합 — 유령 pending 오차단 방지).
//   ⚠ 변동(review_request)은 액트 마스터/오픈 게이트 개념이 없으므로 pending 을 그대로 센다(단, 모드 스코프 적용).
//   ⚠ 모드 스코프: 검수 코호트(loadFinalizeCohort)와 **동일 기준**으로 effMode 를 정해 그 모드의 체크/변동/적립만
//     센다. 코호트는 `QA_HIDE_REAL_USERS || scope==='qa'` 이면 test 유저만 → effMode='test'. 그래야 test 코호트
//     검수가 operating 실유저의 pending 에 막히지(그 반대도) 않는다(scope_mode 컬럼으로 격리·읽기==쓰기 모드).
export async function assertWeekAccrualComplete(
  week: FinalizeWeekRow,
  scope: StateScope = "operating",
  organization?: OrganizationSlug,
): Promise<AccrualGateResult> {
  const weekId = week.id;
  const effMode: "operating" | "test" =
    QA_HIDE_REAL_USERS || scope === "qa" ? "test" : "operating";
  let irregularQuery = supabaseAdmin
    .from("process_irregular_acts")
    .select("id", { count: "exact", head: true })
    .eq("week_id", weekId)
    .eq("kind", "review_request")
    .eq("status", "pending")
    .eq("scope_mode", effMode);
  if (organization) irregularQuery = irregularQuery.eq("organization_slug", organization);
  let awardsQuery = week.iso_year != null && week.iso_week != null
    ? supabaseAdmin
        .from("process_point_awards")
        .select("id", { count: "exact", head: true })
        .eq("year", week.iso_year)
        .eq("week_number", week.iso_week)
        .eq("scope_mode", effMode)
    : null;
  if (organization && awardsQuery) awardsQuery = awardsQuery.eq("organization_slug", organization);
  const [validStatuses, pendIrr, awardCount] = await Promise.all([
    countValidOpenCheckStatuses(week, effMode, organization),
    irregularQuery,
    awardsQuery ?? Promise.resolve({ count: 0 } as { count: number | null }),
  ]);

  const pendingChecks = validStatuses.pending;
  const pendingIrregular = pendIrr.count ?? 0;
  const totalStatuses = validStatuses.total; // 유효 체크 대상 기준(비대상 잔존행 제외).
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

// ── 실무 경험 라인 주차 스코프(공통 SoT) ─────────────────────────────────────
// 그 주차의 실무 경험 라인 id + 타깃 id 를 조회한다.
//   ⚠ 실무 경험 라인(cluster4_lines part_type='experience')은 라인 개설 UI(팀 총괄 개설 완료,
//     adminExperienceTeamOverall)에서 **cluster4_lines.week_id 를 세팅하지 않는다(NULL)**.
//     주차 앵커는 cluster4_line_targets.week_id 에 있으므로(개설 시 타깃에 week_id 기록),
//     타깃→라인 역참조로 그 주차의 experience 라인을 찾는다. (cluster4_lines.week_id 직접 필터 금지 —
//     week_id 를 세팅하는 마이그레이션 생성분도 타깃 week_id 를 갖고 있어 이 경로가 상위집합.)
//   readiness("실무 경험 활동 등록/결과 확인")와 finalize mass-fail 가드가 **동일 함수**를 공유한다.
export async function loadExperienceLineWeekScope(
  weekId: string,
  organization?: OrganizationSlug,
): Promise<{ lineIds: string[]; targetIds: string[] }> {
  const { data: tg } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,line_id")
    .eq("week_id", weekId);
  const tgRows = (tg ?? []) as Array<{ id: string; line_id: string | null }>;
  if (tgRows.length === 0) return { lineIds: [], targetIds: [] };
  const candidateLineIds = [...new Set(tgRows.map((r) => r.line_id).filter((x): x is string => !!x))];
  const expLineIds = new Set<string>();
  const CHUNK = 200;
  for (let i = 0; i < candidateLineIds.length; i += CHUNK) {
    const chunk = candidateLineIds.slice(i, i + CHUNK);
    let lineQuery = supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .in("id", chunk)
      .eq("part_type", "experience");
    if (organization) lineQuery = lineQuery.eq("organization_slug", organization);
    const { data } = await lineQuery;
    for (const l of (data ?? []) as { id: string }[]) expLineIds.add(l.id);
  }
  const targetIds = tgRows.filter((r) => r.line_id != null && expLineIds.has(r.line_id)).map((r) => r.id);
  return { lineIds: [...expLineIds], targetIds };
}

// ── 코호트: 그 주차 시즌 참여자(전 org) — roster 기반(uws 기반 아님) ──────────
type CohortMember = { userId: string; org: OrganizationSlug | null; seasonRest: boolean };

// season_key 참여자(user_season_statuses) ∩ (test/QA 정책) − 성장 중단.
//   ⚠ org 스코프 = 전체(옵션 A) — 전역 공표라 전체 org 참여자 uws 를 만들어야 no_data 드롭이
//   oranke/phalanx 에서도 재발하지 않는다. 각 유저의 org 는 verdict 기준값(org_week_thresholds) 해석용.
export async function loadFinalizeCohort(
  seasonKey: string,
  scope: StateScope,
  organization?: OrganizationSlug,
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
    const org = orgByUser.get(userId) ?? null;
    if (organization && org !== organization) continue;
    out.push({ userId, org, seasonRest: meta.seasonRest });
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

export async function resolveWeekReviewRecognitionScope(
  weekId: string,
  seasonKey: string,
  scope: StateScope,
  organization: OrganizationSlug,
): Promise<{ cohort: CohortMember[]; organizations: OrganizationSlug[]; missingOrganizations: OrganizationSlug[] }> {
  const cohort = await loadFinalizeCohort(seasonKey, scope, organization);
  const organizations = [...new Set(cohort.map((m) => m.org).filter((o): o is OrganizationSlug => !!o))];
  const checks = await Promise.all(organizations.map(async (org) => ({
    org,
    n: (await fetchWeekRecognitionRequiredByOrg([weekId], org)).get(weekId) ?? null,
  })));
  return { cohort, organizations, missingOrganizations: checks.filter((x) => x.n == null).map((x) => x.org) };
}

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
  code: "accrual_incomplete" | "pending_evaluation" | "recognition_missing";
  pendingUserIds: string[];
  constructor(
    message: string,
    code: "accrual_incomplete" | "pending_evaluation" | "recognition_missing",
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
  opts: { allowIncompleteTestData?: boolean; organization?: OrganizationSlug } = {},
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

  const reviewScope = opts.organization
    ? await resolveWeekReviewRecognitionScope(week.id, week.season_key, scope, opts.organization)
    : null;
  const cohort = reviewScope?.cohort ?? await loadFinalizeCohort(week.season_key, scope);
  if (cohort.length === 0) return empty("empty_cohort");

  // [2026-07-12 정책] 주차 성공 기준값 SoT = 오픈확인 N(recognition_count_n[주차, 조직]).
  //   코호트에 참여하는 조직 중 N 미확정(미오픈확인)이 하나라도 있으면 검수를 차단한다.
  //   기본값(30)·기존 threshold 폴백 금지 — "오픈 확인을 먼저 완료해주세요".
  //   ⚠ 적립 완료 검사보다 먼저 — 기준값(N)이 없으면 판정 자체가 불가능한 필수 선행조건이다.
  //   force(allowIncompleteTestData) 로도 우회 불가(mass-fail 안전장치가 아님·op/test 동일 규칙).
  {
    const cohortOrgs = reviewScope?.organizations ?? [
      ...new Set(cohort.map((m) => m.org).filter((o): o is OrganizationSlug => !!o)),
    ];
    const nChecks = await Promise.all(
      cohortOrgs.map(async (org) => ({
        org,
        n: (await fetchWeekRecognitionRequiredByOrg([week.id], org)).get(week.id) ?? null,
      })),
    );
    const missingOrgs = reviewScope?.missingOrganizations ?? nChecks.filter((x) => x.n == null).map((x) => x.org);
    if (missingOrgs.length > 0) {
      throw new UwsFinalizeBlockedError(
        `오픈 확인을 먼저 완료해주세요. 주차 성공 기준(인정 개수 N)이 확정되어야 검수할 수 있습니다. ` +
          `(오픈 확인 미완료 클럽: ${missingOrgs.join(", ")})`,
        "recognition_missing",
      );
    }
  }

  // 안전장치: 이 주차의 프로세스 포인트 적립이 끝났는지. 미완료면 차단(전원 0점 fail 방지).
  //   실제 uws 생성 대상 주차(레거시·공식휴식·현재미래 게이트 통과)에서만 검사한다.
  //   bypass(test/QA + 명시 플래그) 시에는 건너뛴다(불완전 테스트 데이터 흐름 검증).
  if (!bypass) {
    const gate = await assertWeekAccrualComplete(week, scope, opts.organization);
    if (!gate.ok) {
      throw new UwsFinalizeBlockedError(gate.reason ?? "적립이 완료되지 않았습니다.", "accrual_incomplete");
    }
  }

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
    // ⚠ experience 라인 주차 앵커 = cluster4_line_targets.week_id(라인 week_id=NULL). 공통 SoT 사용.
    const { lineIds: expLineIds } = await loadExperienceLineWeekScope(week.id, opts.organization);
    const expLineCount = expLineIds.length;
    const nonRest = verdicts.filter((v) => !(v.kind === "status" && v.status === "personal_rest"));
    const allFail =
      nonRest.length > 0 &&
      nonRest.every((v) => v.kind === "status" && v.status === "fail");
    if (expLineCount === 0 && allFail) {
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
