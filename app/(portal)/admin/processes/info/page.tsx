import { requireAdminPage } from "@/lib/adminAuth";
import ProcessUnifiedManager from "@/components/admin/ProcessUnifiedManager";

// /admin/processes/info — 프로세스 관리 화면 재사용(등록 페이지와 동일 컴포넌트).
// 클럽 정보 > "허브별 프로세스 목록" 진입점도 동일 통합 화면을 노출한다.
export default async function ProcessInfoPage() {
  await requireAdminPage();
  return <ProcessUnifiedManager />;
}
