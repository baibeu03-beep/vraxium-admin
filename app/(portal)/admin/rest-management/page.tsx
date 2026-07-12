import { Suspense } from "react";
import { requireAdminPage } from "@/lib/adminAuth";
import RestManagementManager from "@/components/admin/RestManagementManager";
import { LoadingState } from "@/components/ui/loading-state";

// 크루 활동 > 휴식 관리 (/admin/rest-management?org=&mode=).
//   크루 주차 휴식 신청(vacation_requests) 요약 + 신청 목록(테이블).
//   시즌 선택 · 정상/긴급/크루 집계 · 승인/삭제/전체 승인.
//   긴급 휴식 "신청" 생성 기능은 후속 작업.
//
// org optional (lines/info 와 동일한 URL 스코프 정책):
//   · org 없는 통합 경로 `/admin/rest-management` 는 그대로 유지한다 —
//     기본 org(encre) 를 강제 주입/리다이렉트하지 않는다. 사이드바 배지도 URL org 를 읽어
//     org 없으면 [통합], ?org= 있으면 [개별 + 조직명] 으로 일관 표시된다.
//   · ?org={slug} 있으면 해당 조직 화면. 데이터 스코프/권한은 API(resolveAdminOrgAccess)가 담당.
//   · mode(운영/테스트)는 URL 만 보존하며 org 주입과 무관 — 일반/테스트 경로가 동일 스코프 규칙.
export default async function RestManagementPage() {
  await requireAdminPage();
  return (
    <Suspense fallback={<LoadingState active />}>
      <RestManagementManager />
    </Suspense>
  );
}
