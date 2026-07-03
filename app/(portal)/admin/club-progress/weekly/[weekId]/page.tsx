import { Suspense } from "react";
import TeamPartsInfoWeekDetailManager from "@/components/admin/TeamPartsInfoWeekDetailManager";
import { LoadingState } from "@/components/ui/loading-state";

// 클럽 진행 > 주차 상세(활동 관리) — 개별 조직 운영진 · 조회 전용.
//   진입: /admin/club-progress/weekly/[weekId]?org=encre&mode=test
//   통합 어드민 상세와 동일한 화면(현재/관리 주차 · 허브/라인 오픈 설정 · 오픈 확인 · 주차 검수)을
//   재사용하되, readOnly=true 로 검수 완료 / 오픈 확인 / 허브·라인 체크박스를 모두 비활성화한다.
//   통합 어드민에서 설정한 상태를 그대로 조회만 한다. back-link 는 club-progress 목록으로 유지.
export default async function ClubProgressWeekDetailPage({
  params,
}: {
  params: Promise<{ weekId: string }>;
}) {
  const { weekId } = await params;
  return (
    <Suspense fallback={<LoadingState active />}>
      <TeamPartsInfoWeekDetailManager
        weekId={weekId}
        readOnly
        listHrefBase="/admin/club-progress/weekly"
      />
    </Suspense>
  );
}
