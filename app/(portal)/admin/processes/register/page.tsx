import { requireAdminPage } from "@/lib/adminAuth";
import ProcessRegisterManager from "@/components/admin/ProcessRegisterManager";

// 통합 > 허브별 프로세스 > 프로세스 등록 — 액트/라인급 마스터 카탈로그 (additive Phase).
// point.check(A)/advantage(B)/penalty(C)를 "정의"하는 마스터이며, 주차 성장 계산/snapshot 무접촉.
export default async function ProcessRegisterPage() {
  await requireAdminPage();
  return <ProcessRegisterManager />;
}
