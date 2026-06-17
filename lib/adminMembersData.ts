import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { resolveUserScope, type UserScope } from "@/lib/userScope";
import {
  isManualOverrideStatus,
  MANUAL_OVERRIDE_STATUSES,
} from "@/shared/growth.contracts";
import type { ScopeMode } from "@/lib/userScopeShared";
import type { OrganizationSlug } from "@/lib/organizations";
import { getGrowthRosterBatchFast } from "@/lib/cluster3GrowthData";
import { getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
import { getScheduleReliabilityRateBatch } from "@/lib/cluster1ResumeData";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import { listAdminCrewDtos } from "@/lib/adminCrewData";
import {
  isMemberAssignableRole,
  MEMBER_ASSIGNABLE_ROLES,
  MEMBER_PATCH_FIELDS,
  memberStatusLabel,
  ORG_NONE_SENTINEL,
  PART_UNIQUE_ROLES,
  TEAM_UNIQUE_ROLES,
  type AdminMemberDto,
  type ListMembersOptions,
  type ListMembersResult,
  type MemberAssignableRole,
  type MemberPatchField,
  type MemberSortColumn,
  type MemberSortDir,
} from "@/lib/adminMembersTypes";

// /admin/members 전용 데이터 레이어 (server-only).
// canonical source = public.user_profiles. legacy import 무관, user_id(UUID) 기준.
// 브라우저 안전한 상수/타입은 lib/adminMembersTypes.ts 에 분리되어 있다.

export {
  MEMBER_ASSIGNABLE_ROLES,
  MEMBER_PATCH_FIELDS,
  ORG_NONE_SENTINEL,
  type AdminMemberDto,
  type ListMembersOptions,
  type ListMembersResult,
  type MemberAssignableRole,
  type MemberPatchField,
  type MemberSortColumn,
  type MemberSortDir,
};

const MEMBER_SELECT = [
  "user_id",
  "display_name",
  "contact_email",
  "contact_phone",
  "auth_email",
  "organization_slug",
  "status",
  "growth_status",
  "suspended_week_id",
  "role",
  "current_team_name",
  "current_part_name",
  "created_at",
  "updated_at",
].join(",");

type MemberRow = {
  user_id: string;
  display_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  auth_email: string | null;
  organization_slug: string | null;
  status: string | null;
  growth_status: string | null;
  suspended_week_id: string | null;
  role: string | null;
  current_team_name: string | null;
  current_part_name: string | null;
  created_at: string | null;
  updated_at: string | null;
};

// 전체기간 포인트 집계 단위. null 은 0 으로 합산.
// netAdvantagePoints 는 파생값(advantage − penalty)으로, 고객 화면 표시 방패와 동일 기준.
type PointAggregate = {
  checkPoints: number; // SUM(points)
  advantagePoints: number; // SUM(advantages) — raw, 내부 전용
  penaltyPoints: number; // SUM(penalty)
  netAdvantagePoints: number; // advantagePoints − penaltyPoints (고객 표시 방패)
};

const ZERO_POINTS: PointAggregate = {
  checkPoints: 0,
  advantagePoints: 0,
  penaltyPoints: 0,
  netAdvantagePoints: 0,
};

function toDto(
  row: MemberRow,
  points: PointAggregate = ZERO_POINTS,
  membershipLevel: string | null = null,
): AdminMemberDto {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    authEmail: row.auth_email,
    organizationSlug: row.organization_slug,
    status: row.status,
    growthStatus: row.growth_status,
    suspendedWeekId: row.suspended_week_id,
    role: row.role,
    membershipLevel,
    // 상태 칩 표기. 등급 SoT=membership_level — role 단독으로 "파트장"을 만들지 않는다.
    statusLabel: memberStatusLabel(row.role, membershipLevel),
    currentTeamName: row.current_team_name,
    currentPartName: row.current_part_name,
    checkPoints: points.checkPoints,
    advantagePoints: points.advantagePoints,
    penaltyPoints: points.penaltyPoints,
    netAdvantagePoints: points.netAdvantagePoints,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 집계 정렬 컬럼 → PointAggregate 필드 매핑. 이 키로 정렬 요청이 오면 DB order
// 대신 전체 집계 후 메모리 정렬 경로로 처리한다.
const POINTS_SORT_FIELDS: Partial<
  Record<MemberSortColumn, keyof PointAggregate>
> = {
  check_points: "checkPoints",
  advantage_points: "advantagePoints",
  penalty_points: "penaltyPoints",
  net_advantage_points: "netAdvantagePoints",
};

// 주어진 user_id 들의 전체기간 포인트 집계 = SUM(points/advantages/penalty).
// 단일 SoT 직접합산(시즌/주차/point_type 무필터) — 이력서 카드와 동일 기준.
// PostgREST 기본 1000행 제한이 있어 .range() 로 페이지네이션하고, 거대한 IN()
// URL 을 피하려고 user_id 리스트도 청크로 나눠 조회한다. 누락분은 0(미참여) 처리.
export async function sumPointsForUsers(
  userIds: string[],
): Promise<Map<string, PointAggregate>> {
  const sums = new Map<string, PointAggregate>();
  if (userIds.length === 0) return sums;

  const ID_CHUNK = 100; // IN() URL 길이 방어
  const ROW_PAGE = 1000; // PostgREST max-rows 방어

  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const idChunk = userIds.slice(i, i + ID_CHUNK);
    let from = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data, error } = await supabaseAdmin
        .from("user_weekly_points")
        .select("user_id,points,advantages,penalty")
        .in("user_id", idChunk)
        .order("user_id", { ascending: true })
        .range(from, from + ROW_PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{
        user_id: string;
        points: number | null;
        advantages: number | null;
        penalty: number | null;
      }>;
      for (const r of rows) {
        const acc = sums.get(r.user_id) ?? {
          checkPoints: 0,
          advantagePoints: 0,
          penaltyPoints: 0,
          netAdvantagePoints: 0,
        };
        acc.checkPoints += r.points ?? 0;
        acc.advantagePoints += r.advantages ?? 0;
        acc.penaltyPoints += r.penalty ?? 0;
        acc.netAdvantagePoints = acc.advantagePoints - acc.penaltyPoints;
        sums.set(r.user_id, acc);
      }
      if (rows.length < ROW_PAGE) break;
      from += ROW_PAGE;
    }
  }
  return sums;
}

// 주어진 user_id 들의 현재 멤버십 등급(user_memberships.membership_level).
// is_current=true 행을 우선하고, 없으면 임의의 행을 폴백으로 쓴다(다중행은 드묾).
// 멤버십 row 가 없는 사용자는 Map 에 없음 → 등급 미부여(null) 처리.
async function fetchMembershipLevels(
  userIds: string[],
): Promise<Map<string, string | null>> {
  const levels = new Map<string, string | null>();
  if (userIds.length === 0) return levels;

  const ID_CHUNK = 100; // IN() URL 길이 방어 (sumPointsForUsers 와 동일)
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const idChunk = userIds.slice(i, i + ID_CHUNK);
    const { data, error } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,membership_level,is_current")
      .in("user_id", idChunk);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{
      user_id: string;
      membership_level: string | null;
      is_current: boolean | null;
    }>) {
      if (!levels.has(r.user_id) || r.is_current) {
        levels.set(r.user_id, r.membership_level);
      }
    }
  }
  return levels;
}

// 현재 필터 조건에 맞는 전체 user_id 를 (페이지네이션 없이) 모은다.
// 포인트 집계 정렬은 user_weekly_points 합산이라 DB order 로 풀 수 없어, 전체
// 대상 id 를 모아 메모리에서 정렬·슬라이스한다. select 가 user_id 1컬럼이라
// 가벼우며, 카운트/필터 의미는 기존 목록 쿼리와 동일하게 applyFilters 로 맞춘다.
async function fetchAllMatchingUserIds(
  options: ListMembersOptions,
  scope?: UserScope,
): Promise<string[]> {
  const ids: string[] = [];
  const ROW_PAGE = 1000;
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let builder = supabaseAdmin.from("user_profiles").select("user_id");
    builder = applyFilters(builder, options, {
      applyOrganization: true,
      applyAuthEmailPresence: true,
      applyContactEmailPresence: true,
    }, scope);
    const { data, error } = await builder
      .order("user_id", { ascending: true })
      .range(from, from + ROW_PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ user_id: string }>;
    for (const r of rows) ids.push(r.user_id);
    if (rows.length < ROW_PAGE) break;
    from += ROW_PAGE;
  }
  return ids;
}

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

// 검색어 + 상태/성장 필터 등 "선택적 조건"만 적용한다.
// organization, auth_email, contact_email 의 presence 필터는 caller 에서 조합한다.
type FilterFlags = {
  applyOrganization?: boolean;
  applyAuthEmailPresence?: boolean;
  applyContactEmailPresence?: boolean;
};

// 결과 0건 보장용 불가능 UUID(테스트 모드 화이트리스트가 비었을 때).
const IMPOSSIBLE_UUID = "00000000-0000-0000-0000-000000000000";

function applyFilters<T extends { eq: unknown; is: unknown; or: unknown }>(
  builder: T,
  options: ListMembersOptions,
  flags: FilterFlags,
  scope?: UserScope,
): T {
  let q = builder as unknown as {
    eq: (col: string, value: string) => typeof q;
    is: (col: string, value: null) => typeof q;
    not: (col: string, op: string, value: string | null) => typeof q;
    in: (col: string, values: string[]) => typeof q;
    or: (filters: string) => typeof q;
  };

  // super admin 은 멤버 목록/카운트 전부에서 제외 (목록 노출에서만 숨김, 인가와 무관).
  q = q.or(SUPER_ADMIN_EXCLUDE_OR);

  // 모집단 스코프(operating=테스트 제외 / test=테스트만). SoT=test_user_markers(userScope).
  // 모든 멤버 쿼리 빌더가 이 함수를 거치므로 목록·카운트·정렬 경로 전부 동일 스코프 보장.
  if (scope) {
    if (scope.mode === "test") {
      const ids = [...(scope.includeUserIds ?? [])];
      q = q.in("user_id", ids.length > 0 ? ids : [IMPOSSIBLE_UUID]);
    } else if (scope.excludeUserIds.length > 0) {
      q = q.not("user_id", "in", `(${scope.excludeUserIds.join(",")})`);
    }
  }

  if (flags.applyOrganization && options.organization) {
    if (options.organization === ORG_NONE_SENTINEL) {
      q = q.is("organization_slug", null);
    } else {
      q = q.eq("organization_slug", options.organization);
    }
  }

  if (options.status) {
    q = q.eq("status", options.status);
  }

  if (options.growthStatus) {
    q = q.eq("growth_status", options.growthStatus);
  }

  if (flags.applyAuthEmailPresence && options.authEmailPresence) {
    if (options.authEmailPresence === "missing") {
      q = q.is("auth_email", null);
    } else {
      q = q.not("auth_email", "is", null);
    }
  }

  if (flags.applyContactEmailPresence && options.contactEmailPresence) {
    if (options.contactEmailPresence === "missing") {
      q = q.is("contact_email", null);
    } else {
      q = q.not("contact_email", "is", null);
    }
  }

  const rawQuery = options.query?.trim() ?? "";
  const trimmed = rawQuery ? escapeForIlike(rawQuery) : "";
  const filters = [
    ...(trimmed
      ? [
          `display_name.ilike.%${trimmed}%`,
          `contact_email.ilike.%${trimmed}%`,
          `auth_email.ilike.%${trimmed}%`,
        ]
      : []),
    // user_id 는 UUID 컬럼이라 ilike 가 불가. 완전 일치만 허용.
    ...(isUuid(rawQuery) ? [`user_id.eq.${rawQuery}`] : []),
  ];

  if (filters.length > 0) {
    q = q.or(filters.join(","));
  }

  return q as unknown as T;
}

export async function listMembers(
  options: ListMembersOptions = {},
): Promise<ListMembersResult> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const sortBy: MemberSortColumn = options.sortBy ?? "created_at";
  const sortDir: MemberSortDir = options.sortDir ?? "desc";

  // 모집단 스코프(operating 기본=실사용자만·테스트 제외 / test=테스트만) — 한 번 해소해 전 빌더에 적용.
  const scope = await resolveUserScope(options.mode ?? "operating", null);

  let members: AdminMemberDto[];
  let total: number;

  const pointsSortField = POINTS_SORT_FIELDS[sortBy];

  if (pointsSortField) {
    // 포인트 집계 정렬: user_weekly_points 집계라 DB order 불가.
    // 전체 대상 id → 포인트 합 → 메모리 정렬 → 페이지 슬라이스 순으로 처리한다.
    const allIds = await fetchAllMatchingUserIds(options, scope);
    total = allIds.length;
    const sums = await sumPointsForUsers(allIds);
    const sorted = [...allIds].sort((a, b) => {
      const pa = sums.get(a)?.[pointsSortField] ?? 0;
      const pb = sums.get(b)?.[pointsSortField] ?? 0;
      if (pa !== pb) return sortDir === "asc" ? pa - pb : pb - pa;
      return a.localeCompare(b); // 동점은 user_id 로 안정 정렬
    });
    const pageIds = sorted.slice(offset, offset + limit);

    if (pageIds.length === 0) {
      members = [];
    } else {
      const [{ data, error }, levels] = await Promise.all([
        supabaseAdmin
          .from("user_profiles")
          .select(MEMBER_SELECT)
          .in("user_id", pageIds),
        fetchMembershipLevels(pageIds),
      ]);
      if (error) throw new Error(error.message);
      const byId = new Map<string, MemberRow>();
      for (const row of (data ?? []) as unknown as MemberRow[]) {
        byId.set(row.user_id, row);
      }
      // pageIds 정렬 순서를 보존하며 DTO 로 매핑.
      members = pageIds
        .map((id) => {
          const row = byId.get(id);
          return row
            ? toDto(row, sums.get(id) ?? ZERO_POINTS, levels.get(id) ?? null)
            : null;
        })
        .filter((m): m is AdminMemberDto => m !== null);
    }
  } else {
    let queryBuilder = supabaseAdmin
      .from("user_profiles")
      .select(MEMBER_SELECT, { count: "exact" });

    queryBuilder = applyFilters(queryBuilder, options, {
      applyOrganization: true,
      applyAuthEmailPresence: true,
      applyContactEmailPresence: true,
    }, scope);

    queryBuilder = queryBuilder
      .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false })
      .order("user_id", { ascending: true })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await queryBuilder;
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as MemberRow[];
    const pageUserIds = rows.map((r) => r.user_id);
    const [sums, levels] = await Promise.all([
      sumPointsForUsers(pageUserIds),
      fetchMembershipLevels(pageUserIds),
    ]);
    members = rows.map((r) =>
      toDto(r, sums.get(r.user_id) ?? ZERO_POINTS, levels.get(r.user_id) ?? null),
    );
    total = count ?? 0;
  }

  // 요약 카운트 — 각 카운트는 해당 컬럼 필터를 제외한 동일 검색 조건으로 집계한다.
  // 운영자가 "지금 조건에서 소속 없음 N명" 처럼 안내받기 위함.
  let withoutOrgBuilder = supabaseAdmin
    .from("user_profiles")
    .select("user_id", { count: "exact", head: true });
  withoutOrgBuilder = applyFilters(withoutOrgBuilder, options, {
    applyOrganization: false,
    applyAuthEmailPresence: true,
    applyContactEmailPresence: true,
  }, scope);
  withoutOrgBuilder = withoutOrgBuilder.is("organization_slug", null);

  let withoutAuthBuilder = supabaseAdmin
    .from("user_profiles")
    .select("user_id", { count: "exact", head: true });
  withoutAuthBuilder = applyFilters(withoutAuthBuilder, options, {
    applyOrganization: true,
    applyAuthEmailPresence: false,
    applyContactEmailPresence: true,
  }, scope);
  withoutAuthBuilder = withoutAuthBuilder.is("auth_email", null);

  const [withoutOrgResult, withoutAuthResult] = await Promise.all([
    withoutOrgBuilder,
    withoutAuthBuilder,
  ]);

  if (withoutOrgResult.error) throw new Error(withoutOrgResult.error.message);
  if (withoutAuthResult.error) throw new Error(withoutAuthResult.error.message);

  return {
    members,
    total,
    withoutOrganizationCount: withoutOrgResult.count ?? 0,
    withoutAuthEmailCount: withoutAuthResult.count ?? 0,
    limit,
    offset,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 크루 목록(roster) — /admin/members 의 "크루 목록" 탭 전용.
//
// listMembers 와 달리 페이지네이션 없이 (조직 + 모집단 스코프) 에 해당하는 전원을
// 한 번에 반환하고, 각 멤버에 계산 성장상태(displayGrowthStatus)를 그래프트한다.
//   - 검색·성장필터는 클라이언트에서 표시값/상태 그룹으로 적용한다("결과 값" = 렌더 row 수).
//   - displayGrowthStatus 는 raw growth_status 가 아니라 lib/growthCore 가 계산하는
//     표시 상태(onboarding/graduating/extra_growth/official_rest 포함)다. 온보딩/바사노스
//     같은 필터는 raw 컬럼으로 판정 불가하므로 cluster3 SoT(getGrowthStatusResolutionBatch)를
//     재사용한다(고객앱 /crews graft 와 동일 경로 → drift 없음).
// ─────────────────────────────────────────────────────────────────────────

// 크루 목록 표 A 한 행. 프로필(crew DTO) + 표시 성장상태 + 성장 주차 + 품계 + 포인트
// + 일정 신뢰도 + 활동 완료율을 한 행에 모은다. 검색/필터/정렬은 클라이언트에서 적용한다.
export type MemberRosterRow = {
  userId: string;
  displayName: string | null;
  organizationSlug: string | null;
  role: string | null;
  membershipLevel: string | null;
  // lib/growthCore.resolveGrowthStatusDetail 의 표시 키(GrowthStatusKey 10종) 또는 null.
  displayGrowthStatus: string | null;
  gender: string | null;
  birthDate: string | null;
  schoolName: string | null;
  departmentName: string | null;
  teamName: string | null;
  partName: string | null;
  // 품계 = user_grade_stats.grade(1=정승 최상위 … 10=정9품) + grade_label. 없으면 null.
  rankGradeNumber: number | null;
  rankGradeLabel: string | null;
  successWeeks: number | null; // 성장(성공) 주차 = period.a
  growableWeeks: number | null; // 성장 가능 주차 = period.e(a+b+c)
  // Po.A/B/C = 누적 총합 포인트(SUM). check(A)/advantage(B)/penalty(C) — 프로세스 적립 합산 SoT.
  poA: number;
  poB: number;
  poC: number;
  scheduleReliability: number | null; // 일정 신뢰도(%) — 고객 cluster.1 동일 산식. 산정 불가=null.
  activityCompletion: number | null; // 활동 완료율(%) — 고객 cluster.1 동일 산식. 데이터 없음=null.
};

// 로스터 전체 조회 중 일부 사용자의 성장 지표(snapshot)를 못 읽었을 때의 부분 실패 신호.
//   전체 API 를 깨지 않고(fail-soft) 화면에 "일부 snapshot 조회 실패" 안내를 띄우기 위함.
export type RosterPartialFailure = {
  growthUnavailable: number; // 성장상태/성공·가능주차/활동완료율이 비어 "-"로 렌더되는 사용자 수
  failedChunks: number; // 통째로 실패한 snapshot 배치(청크) 수
};

// ─── roster slim 캐시 우선: 일정 신뢰도 + Po.A/B/C ──────────────────────────
// listMembersRoster 의 두 무거운 live 배치(getScheduleReliabilityRateBatch 전원 · sumPointsForUsers
// 전원)를 대체한다. cluster4_roster_card_stats(slim) 의 schedule_rate/po_a/po_b/po_c 를 읽어
// 읽기 경로에서 user_week_statuses·user_weekly_points 전수 스캔을 회피한다.
//   - slim 신뢰 조건 = (dto_version 일치 AND snapshot_computed_at == 현재 snapshot.computed_at).
//     getGrowthRosterBatchFast 와 동일한 drift 가드(같은 snapshot 시점에 writer 가 파생·저장).
//   - 신뢰 불가(누락/버전불일치/computed_at 불일치/표·컬럼 부재) 사용자 = 그 사용자만 live 폴백.
//   → 마이그레이션 미적용/미백필이어도 결과는 live 와 동일(무중단·정합). 컬럼 부재 시 전체 live.
// 품계(클럽 랭크)는 이 Phase 범위 밖 — listMembersRoster 가 별도 live 유지.
const ROSTER_STATS_TABLE = "cluster4_roster_card_stats";

type RosterPointsSchedule = {
  scheduleReliability: number | null;
  poA: number;
  poB: number;
  poC: number;
};

type RosterSlimPointsRow = {
  user_id: string;
  dto_version: number;
  snapshot_computed_at: string;
  schedule_rate: number | null;
  po_a: number;
  po_b: number;
  po_c: number;
};

export async function getRosterPointsScheduleFast(
  userIds: string[],
): Promise<Map<string, RosterPointsSchedule>> {
  const out = new Map<string, RosterPointsSchedule>();
  if (userIds.length === 0) return out;
  const ID_CHUNK = 200;

  // 1) slim 읽기(경량). 표/컬럼 부재(마이그레이션 미적용) 등 실패 시 전체 live 폴백.
  const slimByUser = new Map<string, RosterSlimPointsRow>();
  let slimAvailable = true;
  try {
    for (let i = 0; i < userIds.length; i += ID_CHUNK) {
      const chunk = userIds.slice(i, i + ID_CHUNK);
      const { data, error } = await supabaseAdmin
        .from(ROSTER_STATS_TABLE)
        .select("user_id,dto_version,snapshot_computed_at,schedule_rate,po_a,po_b,po_c")
        .in("user_id", chunk);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as RosterSlimPointsRow[]) slimByUser.set(r.user_id, r);
    }
  } catch (e) {
    slimAvailable = false;
    console.warn("[roster-stats] slim(points/schedule) unavailable → live fallback", {
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // 2) drift 가드: slim.snapshot_computed_at == 현재 snapshot.computed_at 인 행만 신뢰.
  const snapComputedAt = new Map<string, string>();
  if (slimAvailable && slimByUser.size > 0) {
    const slimIds = [...slimByUser.keys()];
    for (let i = 0; i < slimIds.length; i += ID_CHUNK) {
      const chunk = slimIds.slice(i, i + ID_CHUNK);
      const { data, error } = await supabaseAdmin
        .from("cluster4_weekly_card_snapshots")
        .select("user_id,computed_at")
        .in("user_id", chunk);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as { user_id: string; computed_at: string }[]) {
        snapComputedAt.set(r.user_id, r.computed_at);
      }
    }
  }

  // 3) 신뢰 가능 = slim · 그 외 = live 폴백 대상.
  const needLiveIds: string[] = [];
  for (const uid of userIds) {
    const s = slimByUser.get(uid);
    if (
      s &&
      s.dto_version === WEEKLY_CARDS_DTO_VERSION &&
      snapComputedAt.get(uid) === s.snapshot_computed_at
    ) {
      out.set(uid, {
        scheduleReliability: s.schedule_rate,
        poA: s.po_a,
        poB: s.po_b,
        poC: s.po_c,
      });
    } else {
      needLiveIds.push(uid);
    }
  }

  // 4) live 폴백(미백필/불일치/컬럼부재) — 그 사용자만. 검증된 기존 경로 그대로.
  if (needLiveIds.length > 0) {
    const [scheduleRate, points] = await Promise.all([
      getScheduleReliabilityRateBatch(needLiveIds),
      sumPointsForUsers(needLiveIds),
    ]);
    for (const uid of needLiveIds) {
      const pts = points.get(uid) ?? ZERO_POINTS;
      out.set(uid, {
        scheduleReliability: scheduleRate.get(uid) ?? null,
        poA: pts.checkPoints,
        poB: pts.advantagePoints,
        poC: pts.penaltyPoints,
      });
    }
  }

  return out;
}

export async function listMembersRoster(options: {
  organization?: OrganizationSlug | null; // slug | null/undefined(전체)
  mode?: ScopeMode;
  // 단계별 소요 시간을 콘솔에 출력(진단 전용 — 라우트는 미사용, prod 로그 무영향).
  profile?: boolean;
}): Promise<{ members: MemberRosterRow[]; partialFailure: RosterPartialFailure | null }> {
  const mode = options.mode ?? "operating";
  const t = (label: string, ms: number) => {
    if (options.profile) console.log(`[roster][profile] ${label}=${ms}ms`);
  };

  // 1) 프로필/소속/팀·파트/학교·전공/등급/성별·생년월일 = crew DTO 배치(단일 SoT).
  //    org 미지정 = 전 조직(+소속 없음). scope·super admin 제외는 내부에서 처리.
  let s = Date.now();
  const crews = await listAdminCrewDtos(options.organization ?? undefined, mode);
  t("listAdminCrewDtos", Date.now() - s);
  const userIds = crews.map((c) => c.userId);
  if (userIds.length === 0) return { members: [], partialFailure: null };

  const ID_CHUNK = 200;

  // 2~5) 무거운 배치들을 동시에 실행(서로 독립). 성장상태/주차/활동완료율(snapshot)·품계(live
  //   getClubRank 동일 산식, 전체 포인트 1회)·누적 포인트·일정 신뢰도. user_grade_stats 캐시는
  //   고객 화면이 참조하지 않아(club-rank=live) parity 가 깨지므로 사용하지 않는다.
  s = Date.now();

  // 표시 성장상태 + 성장 성공/가능 + 활동 완료율 — 청크 단위 snapshot 배치.
  //   청크가 통째로 실패(예: snapshot statement timeout)해도 전체 로스터를 깨지 않는다(fail-soft):
  //   실패 청크는 건너뛰고 failedChunks 로 집계 → 해당 사용자는 아래에서 "-"(null)로 렌더되고,
  //   화면에 "일부 snapshot 조회 실패" 안내가 뜬다. (loading 무한 회전·전체 500 방지)
  const buildGrowthMap = async () => {
    const map = new Map<
      string,
      { displayGrowthStatus: string; successWeeks: number; growableWeeks: number; activityRate: number }
    >();
    let failedChunks = 0;
    for (let i = 0; i < userIds.length; i += ID_CHUNK) {
      const chunk = userIds.slice(i, i + ID_CHUNK);
      try {
        const rows = await getGrowthRosterBatchFast(chunk);
        for (const r of rows) {
          map.set(r.userId, {
            displayGrowthStatus: r.displayGrowthStatus,
            successWeeks: r.successWeeks,
            growableWeeks: r.growableWeeks,
            activityRate: r.activityRate,
          });
        }
      } catch (err) {
        failedChunks += 1;
        console.warn("[roster] growth batch chunk failed → fail-soft", {
          chunkStart: i,
          chunkSize: chunk.length,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { map, failedChunks };
  };

  // 일정 신뢰도 + Po.A/B/C 는 slim 우선(getRosterPointsScheduleFast) — 읽기 경로에서 전수 스캔 회피.
  //   품계(클럽 랭크)는 이 Phase 범위 밖 — 전체 코호트 백분위라 live 유지(후속 Phase 분리).
  const [growthResult, clubRankByUser, statsByUser] = await Promise.all([
    buildGrowthMap(),
    getClubRankGradeBatch(userIds),
    getRosterPointsScheduleFast(userIds),
  ]);
  const growthByUser = growthResult.map;
  t("batches(growth+clubRank+points·schedule-slim)", Date.now() - s);

  const members: MemberRosterRow[] = crews.map((c) => {
    const g = growthByUser.get(c.userId);
    const rank = clubRankByUser.get(c.userId) ?? null;
    const st = statsByUser.get(c.userId);
    return {
      userId: c.userId,
      displayName: c.displayName,
      organizationSlug: c.organizationSlug,
      role: c.role,
      membershipLevel: c.membershipLevel,
      displayGrowthStatus: g?.displayGrowthStatus ?? null,
      gender: c.gender,
      birthDate: c.birthDate,
      schoolName: c.schoolName,
      departmentName: c.departmentName,
      teamName: c.teamName,
      partName: c.partName,
      rankGradeNumber: rank?.grade ?? null,
      rankGradeLabel: rank?.label ?? null,
      successWeeks: g?.successWeeks ?? null,
      growableWeeks: g?.growableWeeks ?? null,
      poA: st?.poA ?? 0,
      poB: st?.poB ?? 0,
      poC: st?.poC ?? 0,
      scheduleReliability: st?.scheduleReliability ?? null,
      activityCompletion: g?.activityRate ?? null,
    };
  });

  // 이름(한글) → user_id 안정 정렬(클라이언트가 다시 정렬하므로 기본값).
  members.sort(
    (a, b) =>
      (a.displayName ?? "").localeCompare(b.displayName ?? "", "ko") ||
      a.userId.localeCompare(b.userId),
  );

  // 일부 사용자의 성장 지표(snapshot)를 못 읽었으면 부분 실패로 표기 → 화면 안내.
  //   - growthUnavailable = 성장상태/성공·가능주차/활동완료율이 비어 "-"로 렌더되는 사용자 수.
  //   - failedChunks      = 통째로 실패한 snapshot 배치(청크) 수(로그 상관용).
  const growthUnavailable = userIds.filter((id) => !growthByUser.has(id)).length;
  const partialFailure: RosterPartialFailure | null =
    growthUnavailable > 0 || growthResult.failedChunks > 0
      ? { growthUnavailable, failedChunks: growthResult.failedChunks }
      : null;
  if (partialFailure) {
    console.warn("[roster] partial failure", { ...partialFailure, total: userIds.length });
  }

  return { members, partialFailure };
}

// ─────────────────────────────────────────────────────────────────────────
// PATCH — 한 멤버의 일부 필드만 수정.
// auth_email, user_id, display_name 등은 whitelist 에 포함하지 않는다.
// ─────────────────────────────────────────────────────────────────────────

export class MemberPatchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MemberPatchError";
    this.status = status;
  }
}

export type MemberPatchInput = Partial<{
  organization_slug: string | null;
  status: string | null;
  // 성장 상태 수동 오버라이드 — MANUAL_OVERRIDE_STATUSES(graduated/suspended/paused)
  // 또는 null(오버라이드 해제)만 허용. 그 외 값(graduating 등)은 400.
  growth_status: string | null;
  // 오버라이드 변경 사유 (user_profiles 컬럼 아님 — user_growth_status_audit 기록용).
  growth_status_reason: string | null;
  // 성장 중단 적용 주차(weeks.id) 또는 null(해제). UUID 검증 필수.
  suspended_week_id: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  // role 은 enum(4종) 검증을 거치므로 nullable-string 화이트리스트와 별도로 다룬다.
  role: MemberAssignableRole;
}>;

function coerceNullableString(
  raw: unknown,
  field: MemberPatchField,
): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new MemberPatchError(400, `${field} must be a string or null`);
  }
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

export function pickMemberPatch(body: unknown): MemberPatchInput {
  if (!body || typeof body !== "object") {
    throw new MemberPatchError(400, "Request body must be a JSON object");
  }
  const input = body as Record<string, unknown>;
  const patch: MemberPatchInput = {};
  for (const key of MEMBER_PATCH_FIELDS) {
    if (!(key in input)) continue;
    patch[key] = coerceNullableString(input[key], key);
  }
  // growth_status 는 수동 오버라이드 3종 + null(해제)만 신규 쓰기 허용.
  // (자동 계산 상태 graduating/seasonal_rest/weekly_rest/active 는 저장 금지 —
  //  2026-06-07 auto/override 분리 정책)
  if (patch.growth_status !== undefined && patch.growth_status !== null) {
    if (!isManualOverrideStatus(patch.growth_status)) {
      throw new MemberPatchError(
        400,
        `growth_status must be one of: ${MANUAL_OVERRIDE_STATUSES.join(", ")} (or null to clear) — 그 외 상태는 자동 계산됩니다`,
      );
    }
  }
  // suspended_week_id 는 UUID 또는 null(해제)만 허용. (위 루프에서 nullable-string 으로 1차 coerce됨)
  if (patch.suspended_week_id !== undefined && patch.suspended_week_id !== null) {
    if (!isUuid(patch.suspended_week_id)) {
      throw new MemberPatchError(400, "suspended_week_id must be a weeks UUID or null");
    }
  }
  // 오버라이드 변경 사유 (audit 전용 — growth_status 와 함께 올 때만 의미).
  if ("growth_status_reason" in input) {
    const raw = input.growth_status_reason;
    if (raw !== null && typeof raw !== "string") {
      throw new MemberPatchError(400, "growth_status_reason must be a string or null");
    }
    const trimmed = typeof raw === "string" ? raw.trim() : null;
    patch.growth_status_reason = trimmed?.length ? trimmed : null;
  }
  // role 은 4종 enum 만 허용. null/미지정은 허용하지 않는다(역할은 항상 1개).
  if ("role" in input) {
    const raw = input.role;
    if (!isMemberAssignableRole(raw)) {
      throw new MemberPatchError(
        400,
        `role must be one of: ${MEMBER_ASSIGNABLE_ROLES.join(", ")}`,
      );
    }
    patch.role = raw;
  }
  if (Object.keys(patch).length === 0) {
    throw new MemberPatchError(400, "No editable fields provided");
  }
  return patch;
}

// ─────────────────────────────────────────────────────────────────────────
// 유일성 검증.
//   - team_leader : 같은 (org, current_team_name) 에 1명
//   - agent / part_leader : 같은 (org, current_team_name, current_part_name) 에 1명
//     (part_name 이 팀별로 재사용되므로 팀 + 파트를 함께 봐야 한다 →
//      2026-06-01_member_roles_part_scope_fix.sql 의 부분 유니크 인덱스와 일치)
// role 은 user_profiles, 팀/파트는 비정규화된 current_* 를 사용한다.
// DB 의 부분 유니크 인덱스가 최종 방어선이고, 이 함수는 친절한 한국어 409 를 위한 1차 검증.
// ─────────────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<MemberAssignableRole, string> = {
  crew: "크루",
  agent: "에이전트",
  part_leader: "파트장",
  team_leader: "팀장",
};

async function assertRoleUniqueness(
  userId: string,
  role: MemberAssignableRole,
  org: string | null,
  currentTeamName: string | null,
  currentPartName: string | null,
): Promise<void> {
  const isPartUnique = (PART_UNIQUE_ROLES as readonly string[]).includes(role);
  const isTeamUnique = (TEAM_UNIQUE_ROLES as readonly string[]).includes(role);
  if (!isPartUnique && !isTeamUnique) return; // crew 등은 제한 없음

  // 비교 축이 비어 있으면 유일성 강제 불가 → 통과시킨다.
  // (NULL 은 부분 유니크 인덱스에서도 충돌하지 않으므로 일관된 동작.)
  //   team_leader        → current_team_name 필요
  //   agent/part_leader  → current_team_name + current_part_name 모두 필요
  if (!currentTeamName) return;
  if (isPartUnique && !currentPartName) return;

  let query = supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("role", role)
    .eq("current_team_name", currentTeamName)
    .neq("user_id", userId);

  if (isPartUnique) {
    query = query.eq("current_part_name", currentPartName as string);
  }

  query = org === null ? query.is("organization_slug", null) : query.eq("organization_slug", org);

  const { data, error } = await query.limit(1);
  if (error) {
    throw new MemberPatchError(500, `유일성 검증 실패: ${error.message}`);
  }
  if (data && data.length > 0) {
    const scopeLabel = isTeamUnique
      ? `팀(${currentTeamName})`
      : `파트(${currentTeamName} / ${currentPartName})`;
    throw new MemberPatchError(
      409,
      `해당 ${scopeLabel}에는 이미 ${ROLE_LABEL[role]} 역할의 멤버가 있습니다. 한 ${isTeamUnique ? "팀" : "파트"}에는 ${ROLE_LABEL[role]}이 최대 1명만 가능합니다.`,
    );
  }
}

export async function updateMember(
  userId: string,
  patch: MemberPatchInput,
  actorId?: string | null,
): Promise<AdminMemberDto> {
  if (!isUuid(userId)) {
    throw new MemberPatchError(400, "user_id must be a UUID");
  }

  // 감사용 사유는 user_profiles 컬럼이 아니므로 DB update payload 에서 분리한다.
  const { growth_status_reason: overrideReason, ...dbPatch } = patch;
  if (Object.keys(dbPatch).length === 0) {
    throw new MemberPatchError(400, "No editable fields provided");
  }

  // role/growth_status 변경 시: 현재 행을 먼저 읽어 이전 값을 확보한다.
  // (role 은 유일성 사전 검증, growth_status 는 audit old_status 기록용.
  //  org 가 동시에 바뀌면 새 org 기준으로 검증.)
  let oldRole: string | null = null;
  let oldGrowthStatus: string | null = null;
  if (patch.role !== undefined || patch.growth_status !== undefined) {
    const { data: current, error: readError } = await supabaseAdmin
      .from("user_profiles")
      .select("role,growth_status,organization_slug,current_team_name,current_part_name")
      .eq("user_id", userId)
      .single();

    if (readError || !current) {
      if (readError?.code === "PGRST116") {
        throw new MemberPatchError(404, "user_profile not found");
      }
      throw new MemberPatchError(
        500,
        readError?.message ?? "Failed to read user_profile",
      );
    }

    oldRole = (current.role as string | null) ?? null;
    oldGrowthStatus = (current.growth_status as string | null) ?? null;

    if (patch.role !== undefined) {
      const effectiveOrg =
        patch.organization_slug !== undefined
          ? patch.organization_slug
          : ((current.organization_slug as string | null) ?? null);

      await assertRoleUniqueness(
        userId,
        patch.role,
        effectiveOrg,
        (current.current_team_name as string | null) ?? null,
        (current.current_part_name as string | null) ?? null,
      );
    }
  }

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .update(dbPatch)
    .eq("user_id", userId)
    .select(MEMBER_SELECT)
    .single();

  if (error || !data) {
    if (error?.code === "PGRST116") {
      throw new MemberPatchError(404, "user_profile not found");
    }
    // 부분 유니크 인덱스 위반 — 동시성/외부 경로로 검증을 빠져나간 경우의 최종 방어.
    if (error?.code === "23505") {
      throw new MemberPatchError(
        409,
        "같은 파트/팀에 동일 역할 멤버가 이미 존재합니다(유일성 제약 위반).",
      );
    }
    throw new MemberPatchError(500, error?.message ?? "Failed to update user_profile");
  }

  // PATCH 는 포인트를 바꾸지 않지만, 응답 DTO 가 포인트 집계/상태 표기를 항상
  // 정확히 담도록 단일 사용자 합·멤버십 등급을 채운다(목록 row 와 동일 의미 유지).
  const [pointSums, levels] = await Promise.all([
    sumPointsForUsers([userId]),
    fetchMembershipLevels([userId]),
  ]);
  const dto = toDto(
    data as unknown as MemberRow,
    pointSums.get(userId) ?? ZERO_POINTS,
    levels.get(userId) ?? null,
  );

  // 역할이 실제로 바뀐 경우만 감사 로그 (best-effort — 실패해도 저장은 성공 처리).
  if (patch.role !== undefined && actorId && dto.role !== oldRole) {
    const { error: auditError } = await supabaseAdmin
      .from("user_role_audit")
      .insert({
        user_id: userId,
        old_role: oldRole,
        new_role: dto.role,
        changed_by: actorId,
        reason: "updated via /admin/members",
      });
    if (auditError) {
      console.error("[updateMember] role audit insert failed", {
        userId,
        oldRole,
        newRole: dto.role,
        error: auditError.message,
      });
    }
  }

  // 성장 상태 오버라이드가 실제로 바뀐 경우 사유/변경자 감사 로그
  // (best-effort — 테이블 미생성/실패여도 저장은 성공 처리).
  if (
    patch.growth_status !== undefined &&
    actorId &&
    dto.growthStatus !== oldGrowthStatus
  ) {
    const { error: growthAuditError } = await supabaseAdmin
      .from("user_growth_status_audit")
      .insert({
        user_id: userId,
        old_status: oldGrowthStatus,
        new_status: dto.growthStatus,
        changed_by: actorId,
        reason: overrideReason ?? null,
      });
    if (growthAuditError) {
      console.error("[updateMember] growth_status audit insert failed", {
        userId,
        oldGrowthStatus,
        newGrowthStatus: dto.growthStatus,
        error: growthAuditError.message,
      });
    }
  }

  return dto;
}
