import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";

// IA 개편 Phase 1 placeholder — 메뉴 연결 확인용. 실제 기능은 추후 구현.
// (QA 즉시 실행 A1 패널은 섹션 공용 layout.tsx 가 모든 하위 페이지 상단에 단일 출처로 노출한다.)
export default function ProcessCheckPage() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>프로세스 체크 [실무 경력]</CardTitle>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        프로세스 체크 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
