import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";

// IA 개편 Phase 1 placeholder — 메뉴 연결 확인용. 실제 기능은 추후 구현.
export default function TeamPartsRegisterPage() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>팀 &amp; 파트 등록</CardTitle>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        팀 &amp; 파트 등록 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
