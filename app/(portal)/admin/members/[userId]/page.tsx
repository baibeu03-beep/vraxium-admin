import CrewDetail from "@/components/admin/CrewDetail";
import { parseScopeMode } from "@/lib/userScopeShared";

// 크루 상세 페이지. /admin/members 표 A 의 [이동] 버튼으로 진입.
//   ?mode=<operating|test> — 목록과 동일 모집단 모드 유지(커리어레쥬메 링크/복귀에 사용).
export default async function CrewDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId } = await params;
  const sp = await searchParams;
  const modeRaw = typeof sp.mode === "string" ? sp.mode : null;
  const mode = parseScopeMode(modeRaw);

  return <CrewDetail userId={userId} mode={mode} />;
}
