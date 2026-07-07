import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";

// 클럽 정보 > 시즌 내역 — 메뉴 구조 placeholder(실제 기능은 추후 구현).
export default function TeamPartsInfoSeasonsPage() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>시즌 내역</CardTitle>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        클럽별 시즌 내역 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
