// 어드민 UI 의 "멤버 / 사용자 / 테스터 / 크루" 목록에서 super admin 계정을 숨기기 위한 공통 필터.
//
// 단일 출처(SSOT) = public.user_profiles.role = 'super_admin'
//   - db/migrations/2026-05-22_account_management_step1_schema.sql 의 7종 CHECK 값 중 하나.
//   - step2_backfill 가 두 운영자(super admin) row 를 role='super_admin' 으로 보장한다.
//   - admin_users.role='owner' 와 logical 매핑되지만, 멤버/사용자 목록의 소스는 모두
//     user_profiles 이므로 role 기준으로 일관되게 제외할 수 있다.
//
// ⚠ 인증/인가(requireAdmin, super_admin gate 등)에는 절대 사용하지 않는다.
//   여기서는 "목록 노출"에서만 숨긴다 — super admin 의 로그인/권한 체크는 그대로 둔다.
//   (계정 관리 화면 = admin_users 기반의 /admin/accounts, /admin/admin-users 는
//    super admin 을 계속 보여줘야 하므로 이 필터를 적용하지 않는다.)
//
// role 컬럼은 NULL 허용이므로 (role IS NULL OR role <> 'super_admin') 로 표현한다.
// 단순 .neq('role','super_admin') 는 Postgres 3-valued logic 때문에 role 이 NULL 인
// 일반 멤버까지 떨어뜨리므로 사용하지 않는다.

export const SUPER_ADMIN_ROLE = "super_admin";

// PostgREST or-필터 문자열. user_profiles 를 조회하는 supabase-js 빌더의 .or() 에 넣는다.
//   .or(SUPER_ADMIN_EXCLUDE_OR)  →  role IS NULL OR role != 'super_admin'
// role 을 select 하지 않은 쿼리에서도 필터는 정상 동작한다(별도 select 추가 불필요).
export const SUPER_ADMIN_EXCLUDE_OR = `role.is.null,role.neq.${SUPER_ADMIN_ROLE}`;

// supabase-js 쿼리 빌더(user_profiles 대상)에 super_admin 제외 필터를 적용한다.
// 빌더 타입을 보존하기 위해 제네릭으로 받는다. 클라이언트 종류(@/lib/supabaseAdmin,
// @/lib/supabase/admin 등)와 무관 — .or() 만 있으면 된다.
export function excludeSuperAdmins<T extends { or(filters: string): T }>(
  builder: T,
): T {
  return builder.or(SUPER_ADMIN_EXCLUDE_OR);
}
