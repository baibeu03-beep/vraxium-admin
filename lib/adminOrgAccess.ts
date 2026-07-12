import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  AdminAuthError,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import {
  ORGANIZATIONS,
  isOrganizationSlug,
  type OrganizationSlug,
} from "@/lib/organizations";

// ─────────────────────────────────────────────────────────────────────
// 관리자별 "허용 조직" 단일 출처(SoT).
//
// 이 프로젝트에는 관리자↔조직 권한 전용 테이블/컬럼이 없다. 허용 조직은 기존 데이터로만
// 판정한다(새 권한 모델을 만들지 않는다):
//
//   1) admin_users.role === "owner"(= super admin)      → 전체 조직
//   2) user_profiles.organization_slug === null(= 공통)   → 전체 조직
//   3) user_profiles.organization_slug === <org>          → 그 조직 하나만
//   4) 그 외(미인식 값)                                    → 없음(fail-closed)
//
// 판정 기준(role, organization_slug)은 계정 관리(AccountsManager)가 쓰는 값과 동일하다 —
//   계정별 이메일/이름 하드코딩·mode 분기 없이 오직 이 두 값으로만 결정된다.
//
// 이 모듈은 supabaseAdmin(server-only)을 import 하므로 서버에서만 사용한다. 클라이언트는
//   layout 이 주입하는 AdminOrgAccessProvider 컨텍스트로 동일 결과를 소비한다.
// ─────────────────────────────────────────────────────────────────────

export type AdminOrgAccess = {
  // 허용된 조직 slug 목록(항상 ORGANIZATIONS 순서). 전체 허용이면 ORGANIZATIONS 전부.
  allowedOrgs: OrganizationSlug[];
  // 전체 조직 허용 여부(owner 또는 공통). true 면 조직 스코프 필터를 적용하지 않는다.
  isAllOrgs: boolean;
};

const ALL_ORGS: AdminOrgAccess = {
  allowedOrgs: [...ORGANIZATIONS],
  isAllOrgs: true,
};

// 허용 조직 목록을 항상 ORGANIZATIONS 순서로 정규화한다.
function inCanonicalOrder(orgs: readonly OrganizationSlug[]): OrganizationSlug[] {
  return ORGANIZATIONS.filter((o) => orgs.includes(o));
}

export async function resolveAdminOrgAccess(
  admin: AdminContext,
): Promise<AdminOrgAccess> {
  // owner(super admin) = 전체 조직.
  if (admin.role === "owner") return { ...ALL_ORGS };

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("organization_slug")
    .eq("user_id", admin.userId)
    .maybeSingle();

  if (error) {
    // 조회 실패는 인증 계약(requireAdmin 의 admin_users 오류)과 동일하게 500 으로 올린다 —
    //   조용히 전체 허용/전체 차단으로 넘어가지 않는다.
    console.error("[resolveAdminOrgAccess] user_profiles lookup failed", {
      userId: admin.userId,
      error: error.message,
    });
    throw new AdminAuthError(500, error.message);
  }

  const raw = (data?.organization_slug ?? null) as string | null;
  const slug = raw?.trim() ?? "";
  // 공통(null/빈값) = 전체 조직.
  if (slug === "") return { ...ALL_ORGS };
  // 특정 조직 = 그 조직 하나만.
  if (isOrganizationSlug(slug)) {
    return { allowedOrgs: [slug], isAllOrgs: false };
  }
  // 미인식 값 = 없음(fail-closed).
  return { allowedOrgs: [], isAllOrgs: false };
}

export function isOrgAllowed(
  access: AdminOrgAccess,
  org: OrganizationSlug,
): boolean {
  return access.allowedOrgs.includes(org);
}

// 라인 등록 등 "행의 org"(공통 "common" · 미지정 null 포함)에 대한 접근 허용 여부.
//   전체 허용이면 항상 true. 아니면 특정 허용 org 만 true — 공통("common")/미지정(null)은
//   교차 조직이므로 단일 조직 관리자에게는 차단(fail-closed).
export function isRowOrgAllowed(
  access: AdminOrgAccess,
  org: string | null | undefined,
): boolean {
  if (access.isAllOrgs) return true;
  if (org == null || org === "common") return false;
  return (access.allowedOrgs as readonly string[]).includes(org);
}

// API 게이트 — 요청 org 가 허용 목록에 없으면 403(AdminAuthError). 라우트는 requireAdmin 과
//   동일한 try/catch + toAdminErrorResponse 로 응답을 만든다. 허용되면 access 를 반환한다.
export async function assertAdminOrgAccess(
  admin: AdminContext,
  org: OrganizationSlug,
): Promise<AdminOrgAccess> {
  const access = await resolveAdminOrgAccess(admin);
  if (!access.allowedOrgs.includes(org)) {
    throw new AdminAuthError(
      403,
      "이 클럽에 접근할 권한이 없습니다.",
    );
  }
  return access;
}

// 라우트용 게이트 — requireAdmin 과 동일한 방식으로 응답을 만든다.
//   허용되지 않은 org → 403(Response) 반환, 통과 시 null, 그 외 오류는 rethrow.
//   사용법: `const denied = await guardAdminOrgAccess(admin, org); if (denied) return denied;`
export async function guardAdminOrgAccess(
  admin: AdminContext,
  org: OrganizationSlug,
): Promise<Response | null> {
  try {
    await assertAdminOrgAccess(admin, org);
    return null;
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export { inCanonicalOrder as canonicalOrgOrder };
