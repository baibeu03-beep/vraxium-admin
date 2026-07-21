import { Suspense } from "react";
import { notFound } from "next/navigation";
import TeamDetail from "@/components/admin/TeamDetail";
import { LoadingState } from "@/components/ui/loading-state";
import { isOrganizationSlug } from "@/lib/organizations";

// 팀 상세 하위 페이지. clubId = 조직 slug, teamHalfId = cluster4_team_halves.id(앵커).
//   진입: /admin/team-parts/info/encre/{teamHalfId}[?half=2026-H2]
//   잘못된 clubId slug → 404. 팀 수준 검증(미존재/타org/비활성/스코프)은 team-detail API(loadTeamDetail)
//   가 담당하며 404 응답 → 클라이언트가 not-found 상태를 표시한다.
export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ clubId: string; teamHalfId: string }>;
}) {
  const { clubId, teamHalfId } = await params;
  if (!isOrganizationSlug(clubId)) {
    notFound();
  }
  return (
    <Suspense fallback={<LoadingState active />}>
      <TeamDetail orgSlug={clubId} teamHalfId={teamHalfId} />
    </Suspense>
  );
}
