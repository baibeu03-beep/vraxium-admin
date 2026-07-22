import { Suspense } from "react";
import CrewWeekResultsBoard from "@/components/admin/CrewWeekResultsBoard";
import { LoadingState } from "@/components/ui/loading-state";

// 클럽 정보 > 주차 결과(크루) — [통합] 목록.
//   행=주차(최신 상단) · 열=클럽. 각 셀에 활동 유형(공식 활동/공식 휴식)과 검수 상태를 표시한다.
//   클럽 헤더의 [상세] → /admin/team-parts/info/crew-week-results/{organizationSlug}.
//   조직 스코프는 서버(권한)가 정한다 — 페이지는 조직 목록을 하드코딩하지 않는다.
export default function CrewWeekResultsPage() {
  return (
    <Suspense fallback={<LoadingState active />}>
      <CrewWeekResultsBoard />
    </Suspense>
  );
}
