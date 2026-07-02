import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// 주차 상세(활동 관리) 페이지 A — 라우팅만 준비(내용은 후속 작업 범위).
//   진입: /admin/team-parts/info/weeks/[weekId]?club=encre&mode=test
//   여기서 [주차 검수] 버튼이 추후 구현되며, 주차 내역 표의 "주차 검수" 컬럼에 반영된다.
export default async function TeamPartsInfoWeekDetailPage({
  params,
}: {
  params: Promise<{ weekId: string }>;
}) {
  const { weekId } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle>주차 활동 관리</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>주차 상세(활동 관리) 페이지는 추후 구현 예정입니다.</p>
        <p className="text-xs">weekId: {weekId}</p>
      </CardContent>
    </Card>
  );
}
