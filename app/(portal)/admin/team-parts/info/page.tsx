import { Suspense } from "react";
import TeamPartsInfoManager from "@/components/admin/TeamPartsInfoManager";
import { LoadingState } from "@/components/ui/loading-state";

// 반기별 팀 정보 [섹션.1]. SoT = cluster4_team_halves(반기 → 마지막 시즌 기준).
export default function TeamPartsInfoPage() {
  return (
    <Suspense fallback={<LoadingState active />}>
      <TeamPartsInfoManager />
    </Suspense>
  );
}
