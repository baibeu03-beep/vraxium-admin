import { Suspense } from "react";
import TeamPartsInfoWeekDetailManager from "@/components/admin/TeamPartsInfoWeekDetailManager";
import { LoadingState } from "@/components/ui/loading-state";

// 주차 상세(활동 관리) 페이지 A.
//   진입: /admin/team-parts/info/weeks/[weekId]?club=encre&mode=test
//   상단(현재/관리 주차) + 허브/라인 오픈 설정 + 오픈 확인 + 주차 검수. (액트 체크/라인 개설은 후속)
export default async function TeamPartsInfoWeekDetailPage({
  params,
}: {
  params: Promise<{ weekId: string }>;
}) {
  const { weekId } = await params;
  return (
    <Suspense fallback={<LoadingState active />}>
      <TeamPartsInfoWeekDetailManager weekId={weekId} />
    </Suspense>
  );
}
