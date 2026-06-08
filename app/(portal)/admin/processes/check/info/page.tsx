import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// IA 개편 placeholder — 메뉴/라우트 연결 확인용. 기획 전이라 데이터 API 없이 준비 중 화면만 노출.
export default function ProcessCheckInfoPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>프로세스 체크 · 실무 정보 급</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        실무 정보 급 프로세스 체크 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
