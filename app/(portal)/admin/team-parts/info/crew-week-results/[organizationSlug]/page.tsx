import { Suspense } from "react";
import { notFound } from "next/navigation";
import CrewWeekResultsBoard from "@/components/admin/CrewWeekResultsBoard";
import { LoadingState } from "@/components/ui/loading-state";
import { isOrganizationSlug } from "@/lib/organizations";

// 클럽 정보 > 주차 결과(크루) > {클럽} — 클럽 상세.
//   URL 세그먼트는 **변하지 않는 식별자(조직 slug)** 다. 표시명(한글)은 절대 URL 에 쓰지 않는다.
//     예: /admin/team-parts/info/crew-week-results/encre
//   ⚠ 이 페이지는 추후 [개별] 어드민의 주차 결과(크루) 페이지로 **그대로 재사용**한다.
//     통합용/개별용을 따로 만들지 않는다 — 동일 컴포넌트(CrewWeekResultsBoard)·동일 DTO.
//   유효하지 않은 slug → 404(프로젝트 표준). 권한/데이터 스코프는 API(guardAdminOrgAccess)가 담당한다.
export default async function CrewWeekResultsDetailPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  if (!isOrganizationSlug(organizationSlug)) {
    notFound();
  }
  return (
    <Suspense fallback={<LoadingState active />}>
      <CrewWeekResultsBoard organizationSlug={organizationSlug} />
    </Suspense>
  );
}
