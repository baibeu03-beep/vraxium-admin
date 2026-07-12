import { Suspense } from "react";
import TeamPartsInfoManager from "@/components/admin/TeamPartsInfoManager";
import { LoadingState } from "@/components/ui/loading-state";

// 반기별 팀 정보 [섹션.1]. SoT = cluster4_team_halves(반기 → 마지막 시즌 기준).
//
// org optional: org 없는 통합 경로 `/admin/team-parts/info` 는 그대로 유지한다 — 기본 org 를
//   강제 주입/리다이렉트하지 않는다. 통합 = 모든 조직 탭에 접근할 수 있는 관리자 진입 경로,
//   ?org={slug} = 해당 조직 개별 화면. 사이드바 배지는 URL org 로 판정(없으면 [통합], 있으면 [개별]).
//   데이터 스코프/권한은 API(resolveAdminOrgAccess)가 담당.
export default function TeamPartsInfoPage() {
  return (
    <Suspense fallback={<LoadingState active />}>
      <TeamPartsInfoManager />
    </Suspense>
  );
}
