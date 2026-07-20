"use client";

import { useAdminSession } from "@/components/admin/AdminSessionProvider";
import { formatRemaining } from "@/lib/adminSessionCountdown";
import { cn } from "@/lib/utils";

// Header countdown to auto-logout. Reads `remainingMs` straight from
// AdminSessionProvider (the same value that drives the actual logout), so it is
// never a separate/arbitrary timer. Resets to the full window whenever the user
// is active (the provider updates the shared clock).
export default function SessionCountdown({ className }: { className?: string }) {
  const { remainingMs } = useAdminSession();
  const { text, level } = formatRemaining(remainingMs);

  const color =
    level === "danger"
      ? "text-red-600"
      : level === "warning"
        ? "text-orange-500"
        : "text-muted-foreground";

  return (
    <span
      data-testid="admin-session-countdown"
      data-level={level}
      // block w-full + truncate: 넓은 폭(데스크톱)에서는 문장 전체가 한 줄로 보이고, 아주 좁은
      // 폭에서만 줄바꿈(높이 증가) 대신 말줄임으로 줄어들어 헤더 가로 오버플로를 유발하지 않는다.
      className={cn("block w-full truncate text-xs leading-normal tabular-nums", color, className)}
      title="클릭, 입력, 페이지 이동 등의 활동이 없으면 자동으로 로그아웃됩니다. 활동하면 남은 시간이 다시 초기화됩니다."
    >
      활동이 없으면 {text} 후 자동 로그아웃
    </span>
  );
}
