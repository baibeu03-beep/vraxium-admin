import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";

export default function SettingsPage() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Settings</CardTitle>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Settings 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
