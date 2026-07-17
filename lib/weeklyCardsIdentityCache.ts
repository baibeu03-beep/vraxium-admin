import { AsyncLocalStorage } from "node:async_hooks";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// weekly-cards 계산 경로의 "본인(profile user) identity" 요청 단위 캐시.
// ─────────────────────────────────────────────────────────────────────
// getCluster4WeeklyCardsForProfileUser 한 번을 계산할 때, 같은 profileUserId 의
//   user_profiles / user_memberships 를 여러 helper(fetchManagementSlotOpen·fetchUserTeamAndRole·
//   fetchUserOrganizationSlug·loadGrowthInput·fetchCurrentActivityFallback)가 각기 다른 select 로
//   반복 조회한다(실측: 본인 profile 6회·memberships 4회). 필터는 전부 user_id=eq.<self> 로 동일하고
//   select 만 달라 fetch URL 캐시로도 잡히지 않는다.
//
// 설계(정합 최우선):
//   · 스코프 안 + 본인 user_id 에 한해 두 테이블을 "각 helper 가 읽는 컬럼의 합집합(superset)" 으로
//     1회만 로드하고, **raw supabase 결과 { data, error } 를 그대로 공유**한다.
//   · 각 helper 는 캐시가 있으면 그 { data, error } 를, 없으면 기존 개별 쿼리를 사용한다. 이후
//     기존 에러 처리·null 처리·정렬·선택 로직은 **한 글자도 바꾸지 않는다**(값·에러 의미 동일).
//       → superset 은 각 helper select 를 모두 포함하고, 필터(user_id=eq.<self>)·에러도 동일하므로
//         helper 결과가 byte-identical. (swallow 하지 않고 error 를 그대로 넘겨 fail-closed 도 보존)
//   · 스코프는 getCluster4WeeklyCardsForProfileUser 만 진입. 본인 user_id 만 적용(동료·타 유저는 캐시
//     무시→기존 쿼리). 배치 재계산은 유저마다 별도 run() 스코프(동시성 격리). 쓰기 없음.

export type SelfProfileRow = {
  role: string | null;
  organization_slug: string | null;
  growth_status: string | null;
  status: string | null;
  activity_started_at: string | null;
  activity_ended_at: string | null;
  current_team_name: string | null;
  current_part_name: string | null;
};

export type SelfMembershipRow = {
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};

// supabase 결과와 동일한 최소 형태({ data, error }) — 호출부가 기존 에러 처리를 그대로 적용.
export type SelfResult<T> = { data: T; error: { message: string } | null };

// 각 helper select 의 합집합. 하나라도 누락되면 그 helper 결과가 달라질 수 있다(회귀 스위트로 검증).
//   fetchManagementSlotOpen: membership_level,team_name,is_current,updated_at · role
//   fetchUserTeamAndRole   : team_name,membership_level,is_current · role,organization_slug
//   fetchUserOrganizationSlug: organization_slug
//   loadGrowthInput        : growth_status,status,activity_started_at,activity_ended_at,organization_slug
//   fetchCurrentActivityFallback: team_name,part_name,membership_level,is_current,updated_at · role,current_team_name,current_part_name
const PROFILE_SELECT =
  "role,organization_slug,growth_status,status,activity_started_at,activity_ended_at,current_team_name,current_part_name";
const MEMBERSHIP_SELECT =
  "team_name,part_name,membership_level,is_current,updated_at";

type Store = {
  userId: string;
  profile?: Promise<SelfResult<SelfProfileRow | null>>;
  memberships?: Promise<SelfResult<SelfMembershipRow[]>>;
};

const als = new AsyncLocalStorage<Store>();

export function runWithSelfIdentityCache<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run({ userId }, fn);
}

async function loadSelfProfile(
  userId: string,
): Promise<SelfResult<SelfProfileRow | null>> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select(PROFILE_SELECT)
    .eq("user_id", userId)
    .maybeSingle();
  return { data: (data as SelfProfileRow | null) ?? null, error };
}

async function loadSelfMemberships(
  userId: string,
): Promise<SelfResult<SelfMembershipRow[]>> {
  const { data, error } = await supabaseAdmin
    .from("user_memberships")
    .select(MEMBERSHIP_SELECT)
    .eq("user_id", userId);
  return { data: (data as SelfMembershipRow[] | null) ?? [], error };
}

// 캐시 활성 + 본인 user_id 면 공유 raw 결과를 반환, 아니면 null(호출부가 기존 쿼리 실행).
export function getCachedSelfProfile(
  userId: string,
): Promise<SelfResult<SelfProfileRow | null>> | null {
  const s = als.getStore();
  if (!s || s.userId !== userId) return null;
  if (!s.profile) s.profile = loadSelfProfile(userId);
  return s.profile;
}

export function getCachedSelfMemberships(
  userId: string,
): Promise<SelfResult<SelfMembershipRow[]>> | null {
  const s = als.getStore();
  if (!s || s.userId !== userId) return null;
  if (!s.memberships) s.memberships = loadSelfMemberships(userId);
  return s.memberships;
}
