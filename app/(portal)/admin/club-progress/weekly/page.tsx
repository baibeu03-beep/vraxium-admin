import { Suspense } from "react";
import TeamPartsInfoWeeksManager from "@/components/admin/TeamPartsInfoWeeksManager";
import { LoadingState } from "@/components/ui/loading-state";

// 클럽 진행 > 주차 내역 (개별 조직 운영진 · 조회 전용).
//   진입: /admin/club-progress/weekly?org=encre|oranke|phalanx[&mode=test]
//   통합 어드민(/admin/team-parts/info/weeks)과 동일한 주차 목록/탭 구조를 재사용하되,
//   scoped=true 로 URL ?org 조직 1개에만 고정한다(통합 탭 미노출 · 조회 전용).
//   [활동 관리] 이동/상세 back-link 는 club-progress 경로로 유지된다.
export default function ClubProgressWeeklyPage() {
  return (
    <Suspense fallback={<LoadingState active />}>
      <TeamPartsInfoWeeksManager
        scoped
        detailBasePath="/admin/club-progress/weekly"
      />
    </Suspense>
  );
}
