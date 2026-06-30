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
        <CardTitle>가져오기</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        가져오기 기능은 추후 구현 예정입니다.
      </CardContent>
    </Card>
  );
}
