import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";

// IA 개편 Phase 1 placeholder — 메뉴 연결 확인용. 실제 기능은 추후 구현.
// (크루 휴식 "신청" 워크플로 — 기존 시즌 참여/휴식·공식 휴식 관리와는 별개 메뉴)
export default function RestManagementPage() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>휴식 관리</CardTitle>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        크루 휴식 신청 조회 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
