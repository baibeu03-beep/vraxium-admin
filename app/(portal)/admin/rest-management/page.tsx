import { Suspense } from "react";
import { requireAdminPage } from "@/lib/adminAuth";
import RestManagementManager from "@/components/admin/RestManagementManager";
import { LoadingState } from "@/components/ui/loading-state";

// 크루 활동 > 휴식 관리 (/admin/rest-management?org=&mode=).
//   크루 주차 휴식 신청(vacation_requests) 요약 — 클럽 탭 · 시즌 선택 · 정상/긴급/크루 집계.
//   신청 목록(Table)과 긴급 신청/전체 승인 기능은 후속 작업.
export default async function RestManagementPage() {
  await requireAdminPage();
  return (
    <Suspense fallback={<LoadingState active />}>
      <RestManagementManager />
    </Suspense>
  );
}
