import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

// 조회 대상 사용자의 조직(org)을 user_profiles.organization_slug 에서 읽는다.
//
// 단일 출처(SoT). 두 곳에서 같은 함수를 공유해야 정책 분기가 생기지 않는다(요구사항 #7):
//   1) snapshot 생성: org 라인 노출 필터(getCluster4WeeklyCardsForProfileUser).
//   2) snapshot 조회: 페이지 slug ↔ 실제 org 접근 게이트(assertPageAccessBySlug).
//
// null(미상/미지정)이면 호출자는 org 제약을 적용하지 않는다(fail-open). 쿼리 실패해도
// 전체 흐름을 깨뜨리지 않고 null 로 폴백한다.
export async function fetchUserOrganizationSlug(
  profileUserId: string,
): Promise<OrganizationSlug | null> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("organization_slug")
    .eq("user_id", profileUserId)
    .maybeSingle();
  if (error) {
    console.warn("[userOrg] user org lookup failed (fail-open)", {
      profileUserId,
      message: error.message,
    });
    return null;
  }
  const slug = (data as { organization_slug: string | null } | null)?.organization_slug;
  return isOrganizationSlug(slug) ? slug : null;
}
