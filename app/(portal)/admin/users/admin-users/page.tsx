import { redirect } from "next/navigation";

// 2026-05-22: "관리자 계정" 페이지가 /admin/settings/accounts (계정 관리) 로 이전됨.
// 기존 URL 은 한동안 redirect 로 유지한 뒤, 운영 안정화 후 디렉터리 자체 제거 예정.
// 기존 컴포넌트 components/admin/AdminUsersList.tsx 와
// /api/admin/admin-users 라우트는 deprecation 기간 동안 코드베이스에 남겨두지만,
// 사이드바 진입 경로가 사라져 사실상 호출되지 않는다.
export default function AdminUsersPageDeprecated() {
  redirect("/admin/settings/accounts");
}
