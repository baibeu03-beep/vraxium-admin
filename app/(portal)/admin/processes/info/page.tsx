import { requireAdminPage } from "@/lib/adminAuth";
import ProcessInfoManager from "@/components/admin/ProcessInfoManager";

// 통합 > 허브별 프로세스 > 프로세스 정보 — 허브별 액트/라인급 조회 + 액트 삭제 (조회/삭제 Phase).
// 라인급 삭제 차단 로직·snapshot·주차 성장 계산 무접촉.
export default async function ProcessInfoPage() {
  await requireAdminPage();
  return <ProcessInfoManager />;
}
