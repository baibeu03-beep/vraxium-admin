import { requireAdminPage } from "@/lib/adminAuth";
import ProcessUnifiedManager from "@/components/admin/ProcessUnifiedManager";

// 통합 > 허브별 프로세스 > 프로세스 관리 — 등록 폼 + 전체 허브 액트 목록 통합 화면.
// point.check(A)/advantage(B)/penalty(C)를 "정의"하는 마스터이며, 주차 성장 계산/snapshot 무접촉.
export default async function ProcessRegisterPage() {
  await requireAdminPage();
  return <ProcessUnifiedManager />;
}
