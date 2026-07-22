import { notFound } from "next/navigation";
import CrewWeekResultDetailWeek from "@/components/admin/CrewWeekResultDetailWeek";
import { isOrganizationSlug } from "@/lib/organizations";

// 클럽 정보 > 주차 결과(크루) > {클럽} > {주차} — 주차 세부 페이지(골격).
//   URL 세그먼트는 **불변 식별자만** 사용한다: organizationSlug(조직 slug) + weekId(weeks.id UUID).
//   표시 문자열(주차명/조직 한글명)이나 배열 인덱스는 URL 에 쓰지 않는다.
//
//   이번 단계 범위 = 안정적인 링크 경로 + breadcrumb 확장 구조까지.
//   내용(크루별 결과표 등)은 다음 작업에서 이 컴포넌트 안에 채운다.
export default async function CrewWeekResultWeekPage({
  params,
}: {
  params: Promise<{ organizationSlug: string; weekId: string }>;
}) {
  const { organizationSlug, weekId } = await params;
  if (!isOrganizationSlug(organizationSlug)) notFound();
  // weekId 는 UUID 형태만 허용(표시 문자열 유입 차단). 실제 존재 여부는 데이터 로드 단계에서 검증한다.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(weekId)) {
    notFound();
  }
  return (
    <CrewWeekResultDetailWeek organizationSlug={organizationSlug} weekId={weekId} />
  );
}
