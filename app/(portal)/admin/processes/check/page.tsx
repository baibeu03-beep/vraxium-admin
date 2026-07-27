import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";
import {
  LineOpeningCardDot,
  lineOpeningCardClass,
  lineOpeningCardHeaderClass,
} from "@/components/admin/lineOpeningCardStyles";

// IA 개편 Phase 1 placeholder — 메뉴 연결 확인용. 실제 기능은 추후 구현.
// (QA 즉시 실행 A1 패널은 섹션 공용 layout.tsx 가 모든 하위 페이지 상단에 단일 출처로 노출한다.)
//   디자인: 미구현(빈 상태)이므로 프로세스 체크 공용 카드 SoT 의 중립 tone("muted")을 쓴다.
export default function ProcessCheckPage() {
  return (
    <Card className={lineOpeningCardClass("muted")}>
      <CardHeader className={lineOpeningCardHeaderClass("muted")}>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="inline-flex items-center gap-1.5">
            <LineOpeningCardDot tone="muted" />
            프로세스 체크 [실무 경력]
          </CardTitle>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        프로세스 체크 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
