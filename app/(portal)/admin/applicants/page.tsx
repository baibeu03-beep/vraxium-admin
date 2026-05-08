import { redirect } from "next/navigation";

// "사용자 관리 > 가입 대기자" 메뉴로 이동했다 (2026-05-08).
// 옛 북마크/링크 호환을 위해 이 경로는 유지하고 새 경로로 리다이렉트한다.
export default function LegacyApplicantsRedirect() {
  redirect("/admin/users/applicants");
}
