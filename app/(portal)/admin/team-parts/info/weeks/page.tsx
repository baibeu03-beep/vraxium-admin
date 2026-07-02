import { Suspense } from "react";
import TeamPartsInfoWeeksManager from "@/components/admin/TeamPartsInfoWeeksManager";
import { LoadingState } from "@/components/ui/loading-state";

// 클럽 정보 > 주차 내역. 클럽 탭(통합=준비중 / 엥크레·오랑캐·팔랑크스)별 주차 목록 조회.
export default function TeamPartsInfoWeeksPage() {
  return (
    <Suspense fallback={<LoadingState active />}>
      <TeamPartsInfoWeeksManager />
    </Suspense>
  );
}
