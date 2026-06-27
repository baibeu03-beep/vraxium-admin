import { requireAdminPage } from "@/lib/adminAuth";
import LineManagement from "@/components/admin/LineManagement";

// 라인 관리 페이지. 탭(라인 정보/라인 등록)은 ?tab 으로 구동되며 기본은 "라인 정보"다.
// /admin/lines/register 직접 접근 시에도 기본으로 라인 정보 탭이 먼저 보인다(2026-06-27).
// ?tab=register 면 라인 등록 폼(LineRegistrationManager). 기존 URL 유지·저장 로직 무변경.
export default async function LineRegisterPage() {
  await requireAdminPage();
  return <LineManagement />;
}
