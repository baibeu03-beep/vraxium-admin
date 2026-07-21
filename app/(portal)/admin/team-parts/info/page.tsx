import { Suspense } from "react";
import TeamPartsSummarySection from "@/components/admin/TeamPartsSummarySection";
import ClubSummaryList from "@/components/admin/ClubSummaryList";
import { LoadingState } from "@/components/ui/loading-state";
import { Separator } from "@/components/ui/separator";

// 클럽 정보(상위 페이지).
//   [섹션.1] 기존 팀 내역 요약(해당 시기·오늘 날짜/주차·전체 클럽/팀/파트 수·클럽별 팀 배지) — 유지.
//   [섹션.2] 신규 클럽 현황 표 — 섹션.1 "아래"에 추가. 표의 클럽명을 누르면 상세 하위 페이지
//            `/admin/team-parts/info/[clubId]`(clubId=org slug)로 이동한다.
//   상단 요약 섹션 전체는 링크가 아니다 — 팀 배지는 정보 표시용으로 유지한다.
//
// org optional: org 없는 통합 경로 = 전 클럽, ?org={slug} = 해당 클럽. 데이터 스코프/권한은 API 담당.
export default function TeamPartsInfoPage() {
  return (
    <Suspense fallback={<LoadingState active />}>
      <div className="space-y-10">
        {/* 기존 상단 요약 섹션(대체·삭제 금지) */}
        <TeamPartsSummarySection />
        {/* 두 섹션 사이 구분선 — 요약(§1)과 클럽 현황 표(§2)를 시각적으로 분리 */}
        <Separator />
        {/* 신규 클럽 현황 표(요약 섹션 아래에 추가) */}
        <ClubSummaryList />
      </div>
    </Suspense>
  );
}
