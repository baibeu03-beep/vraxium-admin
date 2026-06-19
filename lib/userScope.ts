// 사용자 스코프 단일 SoT — 운영 모드 / 테스트 모드 분리 (B안 Phase 1 골격).
// ─────────────────────────────────────────────────────────────────────
// 화면마다 test_user_markers 포함/제외를 다르게 처리하던 것을 단일 체계로 통합한다.
// 모든 집계(crews·members·weekly-ranking·finalization·line-opening·cluster4 cards·
// snapshot 코호트)는 이 모듈의 resolveUserScope() 한 곳을 거쳐 모집단을 결정한다.
//
// 정책(확정):
//   · operating(기본, mode 미지정) : 실사용자만. test_user_markers 전원 제외.
//   · test(mode=test)              : test_user_markers 만. 실사용자 전원 제외.
//
// 원칙:
//   1) 테스트 유저 SoT = public.test_user_markers (fetchTestUserMarkerIds).
//      display_name '%T%' 휴리스틱(isTestDisplayName/fetchIsTestUser)은 사용하지 않는다(제거 대상).
//   2) operating 의 운영 집계 숫자는 실사용자 기준 — test 모드는 실데이터에 영향을 주지 않는다(읽기 전용).
//   3) DTO·snapshot-only 조회 구조·demoUserId 경로 무관(이 모듈은 "누구를 모집단에 넣을지"만 판정).
//
// fail-safe 방향(원칙 2 보호):
//   · markers 조회 실패 → testUserIds = 빈 집합.
//     - operating: includes = !∅.has = 모두 포함 → 실사용자 누락 0(보수적, 기존 동작과 동일).
//     - test     : includes = ∅.has = 모두 제외 → 빈 결과(실사용자 절대 유입 안 됨).
//   어느 쪽도 실사용자를 잘못 노출/누락시키지 않는다.
//
// ⚠ Phase 1 = 순수 추가 모듈. 호출부 교체는 후속 Phase(2~6)에서 진행한다.
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  parseScopeMode,
  readScopeMode,
  appendModeQuery,
  setModeQuery,
  type ScopeMode,
} from "@/lib/userScopeShared";

// 순수 헬퍼는 userScopeShared(클라이언트 공용)에서 정의·여기서 재노출(서버 호출부 호환).
export { parseScopeMode, readScopeMode, appendModeQuery, setModeQuery };
export type { ScopeMode };

// useSearchParams()(ReadonlyURLSearchParams)·URLSearchParams 양쪽 호환 최소 형태.
type SearchParamsLike = { get(name: string): string | null } | null | undefined;

// 해소된 스코프 — 모집단 판정자 + 컨텍스트.
export type UserScope = {
  mode: ScopeMode;
  org: OrganizationSlug | null;
  team: string | null;
  // 단건 판정: 이 userId 가 현재 스코프(operating=실사용자 / test=테스트 유저)에 포함되는가.
  includes(userId: string): boolean;
  // 배열 필터: rows 에서 스코프 포함 행만. key 미지정 시 row 자체를 userId 문자열로 취급.
  filter<T>(rows: readonly T[], key?: (row: T) => string): T[];
  // PostgREST 대용량 쿼리 제약용 — 현재 스코프에서 제외해야 할 userId 목록.
  //   operating: 테스트 유저 전체(.not("user_id","in",(...)) 에 사용).
  //   test     : (제외 기반으로는 부적합 — test 는 포함 화이트리스트라 includeUserIds 사용 권장)
  excludeUserIds: ReadonlyArray<string>;
  // test 모드에서 .in("user_id", includeUserIds) 로 쓸 화이트리스트.
  //   operating: null(제외 기반이라 화이트리스트 불필요 — 무한 목록).
  //   test     : 테스트 유저 전체.
  includeUserIds: ReadonlyArray<string> | null;
  // 진단/검증용 원천 노출(테스트 유저 전체 집합).
  testUserIds: ReadonlySet<string>;
};

// 모집단 스코프 해소. team 은 컨텍스트로 보관(팀 단위 추가 필터는 호출부가 멤버십으로 적용).
//   ⚠ Phase 1: include/exclude 판정은 mode 기준만. team 레지스트리(팀 목록 필터)는 후속 Phase.
export async function resolveUserScope(
  mode: ScopeMode,
  org: OrganizationSlug | null,
  team?: string | null,
): Promise<UserScope> {
  const testUserIds = await fetchTestUserMarkerIds();
  const isTest = mode === "test";

  const includes = (userId: string): boolean =>
    isTest ? testUserIds.has(userId) : !testUserIds.has(userId);

  const allTestIds = Array.from(testUserIds);

  return {
    mode,
    org,
    team: team ?? null,
    includes,
    filter<T>(rows: readonly T[], key?: (row: T) => string): T[] {
      const getId = key ?? ((r: T) => r as unknown as string);
      return rows.filter((r) => includes(getId(r)));
    },
    // operating 은 테스트 유저를 제외, test 는 (제외 의미 없음) 빈 배열.
    excludeUserIds: isTest ? [] : allTestIds,
    // test 는 테스트 유저 화이트리스트, operating 은 무한 목록이라 null.
    includeUserIds: isTest ? allTestIds : null,
    testUserIds,
  };
}

// write 직전 검증 — userIds 전원이 현재 스코프에 부합해야 한다.
//   operating: 테스트 계정이 하나라도 섞이면 throw.
//   test     : 실사용자가 하나라도 섞이면 throw.
// 하나라도 벗어나면 status=422 에러(라우트가 error.status 를 읽으면 그대로 응답).
export function assertUserIdsInScope(
  scope: UserScope,
  userIds: ReadonlyArray<string>,
): void {
  const unique = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  const offenders = unique.filter((id) => !scope.includes(id));
  if (offenders.length === 0) return;
  const msg =
    scope.mode === "test"
      ? `테스트 모드에서는 test_user_markers 등재 유저만 대상이 됩니다 — 실사용자 ${offenders.length}명이 포함되어 처리를 중단했습니다.`
      : `운영 모드에서는 test_user_markers 유저를 포함할 수 없습니다 — 테스트 계정 ${offenders.length}명이 포함되어 처리를 중단했습니다.`;
  throw Object.assign(new Error(msg), { status: 422 });
}

// org 컨텍스트까지 한 번에: URL searchParams → (mode, org) → UserScope.
//   route/서버 컴포넌트에서 자주 쓰는 진입점. org 는 호출부가 검증해 전달하거나 여기서 ?org 파싱.
export async function resolveUserScopeFromParams(
  searchParams: SearchParamsLike,
  org: OrganizationSlug | null,
  team?: string | null,
): Promise<UserScope> {
  return resolveUserScope(readScopeMode(searchParams), org, team);
}

export async function resolveRequestScope(
  request: Request,
  options: {
    bodyMode?: unknown;
    org?: OrganizationSlug | null;
    team?: string | null;
  } = {},
): Promise<UserScope> {
  const urlMode = new URL(request.url).searchParams.get("mode");
  const bodyMode = typeof options.bodyMode === "string" ? options.bodyMode : null;
  return resolveUserScope(
    parseScopeMode(urlMode ?? bodyMode),
    options.org ?? null,
    options.team ?? null,
  );
}

export async function assertUserInRequestScope(
  request: Request,
  userId: string,
  options: {
    bodyMode?: unknown;
    org?: OrganizationSlug | null;
    team?: string | null;
  } = {},
): Promise<UserScope> {
  const scope = await resolveRequestScope(request, options);
  assertUserIdsInScope(scope, [userId]);
  return scope;
}

export async function assertUsersInRequestScope(
  request: Request,
  userIds: ReadonlyArray<string>,
  options: {
    bodyMode?: unknown;
    org?: OrganizationSlug | null;
    team?: string | null;
  } = {},
): Promise<UserScope> {
  const scope = await resolveRequestScope(request, options);
  assertUserIdsInScope(scope, userIds);
  return scope;
}

type UserIdScopeQuery<T> = T & {
  in(column: string, values: readonly string[]): T;
  not(column: string, operator: string, value: string): T;
};

export function applyUserIdScope<T>(
  query: T,
  column: string,
  scope: UserScope,
): T | null {
  const builder = query as UserIdScopeQuery<T>;
  if (scope.mode === "test") {
    const ids = scope.includeUserIds ?? [];
    return ids.length > 0 ? builder.in(column, ids) : null;
  }
  return scope.excludeUserIds.length > 0
    ? builder.not(column, "in", `(${scope.excludeUserIds.join(",")})`)
    : query;
}

export async function listLineTargetUserIds(lineId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("line_id", lineId)
    .eq("target_mode", "user");
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) => (row as { target_user_id: string | null }).target_user_id)
    .filter((id): id is string => Boolean(id));
}

export async function assertLineInRequestScope(
  request: Request,
  lineId: string,
  bodyMode?: unknown,
): Promise<UserScope> {
  return assertUsersInRequestScope(
    request,
    await listLineTargetUserIds(lineId),
    { bodyMode },
  );
}

export async function getLineTargetUserId(
  targetId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("id", targetId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { target_user_id: string | null } | null)?.target_user_id ?? null;
}

export async function getExperienceDraftTargetUserIds(
  draftIds: readonly string[],
): Promise<string[]> {
  if (draftIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .select("target_user_id")
    .in("id", Array.from(draftIds));
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) => (row as { target_user_id: string | null }).target_user_id)
    .filter((id): id is string => Boolean(id));
}

// (선택) 현재 org 의 활동 명부 user_id 를 스코프 적용해 반환하는 헬퍼.
//   Phase 2+ 에서 crews/members 가 공통으로 쓸 수 있는 모집단 1차 필터(읽기 전용).
//   여기서는 user_profiles(organization_slug) 기준 user_id 만 — 상태/역할 필터는 각 경로 책임.
export async function listScopedOrgUserIds(scope: UserScope): Promise<string[]> {
  if (!scope.org) return [];
  let q = supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", scope.org);
  // test 모드는 화이트리스트로 좁혀 쿼리 비용 절감(테스트 유저만).
  if (scope.mode === "test") {
    const ids = scope.includeUserIds ?? [];
    if (ids.length === 0) return [];
    q = q.in("user_id", ids);
  }
  const { data, error } = await q;
  if (error) {
    console.error("[userScope] listScopedOrgUserIds failed", {
      org: scope.org,
      mode: scope.mode,
      error: error.message,
    });
    return [];
  }
  const rows = (data ?? []) as Array<{ user_id: string }>;
  // operating 은 쿼리에서 안 좁혔으므로 여기서 테스트 유저 제외 적용.
  return rows.map((r) => r.user_id).filter((id) => scope.includes(id));
}
