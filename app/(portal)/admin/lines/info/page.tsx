import { requireAdminPage } from "@/lib/adminAuth";
import LineManagement from "@/components/admin/LineManagement";

// 라인 관리 페이지(라인 정보 탭 기본). /admin/lines/info 직접 접근도 라인 정보 탭으로 진입한다.
// ?tab=register 면 라인 등록 폼. 기존 URL 유지·저장 로직 무변경.
export default async function LineInfoPage() {
  await requireAdminPage();
  return <LineManagement />;
}
