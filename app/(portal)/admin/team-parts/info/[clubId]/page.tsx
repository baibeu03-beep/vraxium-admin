import { Suspense } from "react";
import { notFound } from "next/navigation";
import ClubTeamDetail from "@/components/admin/ClubTeamDetail";
import { LoadingState } from "@/components/ui/loading-state";
import { isOrganizationSlug } from "@/lib/organizations";

// 클럽 상세 하위 페이지. clubId = 조직 slug(encre|oranke|phalanx).
//   진입: /admin/team-parts/info/encre[?mode=test]
//   URL 로 클럽이 결정되므로 조직 탭 없이 선택 클럽의 팀·파트 상세만 표시한다.
//   유효하지 않은 clubId → 404(프로젝트 표준). 권한/데이터 스코프는 API(guardAdminOrgAccess)가 담당.
export default async function ClubTeamDetailPage({
  params,
}: {
  params: Promise<{ clubId: string }>;
}) {
  const { clubId } = await params;
  if (!isOrganizationSlug(clubId)) {
    notFound();
  }
  return (
    <Suspense fallback={<LoadingState active />}>
      <ClubTeamDetail clubId={clubId} />
    </Suspense>
  );
}
