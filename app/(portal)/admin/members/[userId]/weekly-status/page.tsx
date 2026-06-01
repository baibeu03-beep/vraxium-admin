import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import UserWeeklyStatusView from "@/components/admin/UserWeeklyStatusView";

type Props = {
  params: Promise<{ userId: string }>;
};

export default async function MemberWeeklyStatusPage({ params }: Props) {
  const { userId } = await params;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link
          href="/admin/members"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          전체 멤버
        </Link>
        <span>/</span>
        <span className="text-foreground">주차 상태</span>
      </div>

      <UserWeeklyStatusView userId={userId} />
    </div>
  );
}
