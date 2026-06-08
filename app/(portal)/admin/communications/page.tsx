import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// IA 개편 Phase 1 placeholder — 메뉴 연결 확인용. 실제 기능은 추후 구현.
export default function CommunicationsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>커뮤니케이션</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        크루 커뮤니케이션 조회/답변 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
