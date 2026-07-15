import CrewWeekDetail from "@/components/admin/CrewWeekDetail";
import { parseScopeMode } from "@/lib/userScopeShared";

// 회원별 · 주차별 상세(관리) 페이지. /admin/members/[userId] 하단 주차 표의 주차명 링크로 진입.
//   ?mode=<operating|test> — 진입 컨텍스트(목록/상세와 동일 모집단 모드) 유지.
export default async function CrewWeekDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string; weekId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, weekId } = await params;
  const sp = await searchParams;
  const modeRaw = typeof sp.mode === "string" ? sp.mode : null;
  const mode = parseScopeMode(modeRaw);

  return <CrewWeekDetail userId={userId} weekId={weekId} mode={mode} />;
}
