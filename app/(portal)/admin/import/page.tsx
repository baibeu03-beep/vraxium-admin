import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function ImportPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Import 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
