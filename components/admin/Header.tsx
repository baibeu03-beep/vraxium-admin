"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LogOut, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  toggleDevQuery,
  useAdminDevMode,
} from "@/components/admin/useAdminDevMode";
import { cn } from "@/lib/utils";

// 개발자 표시 토글 버튼 노출 여부.
// 기능·로직·상태값은 모두 유지하고 렌더링만 끈다 — 다시 쓰려면 true 로 변경.
const SHOW_DEV_TOGGLE = false;

// 페이지 제목은 더 이상 글로벌 헤더가 렌더하지 않는다 — 각 페이지 본문의 제목만 단일 소스로
// 사용한다(중복 노출 제거). 헤더는 우측 사용자 정보(로그아웃/이메일)만 담당한다.

type HeaderProps = {
  // 로그인된 관리자 정보 — 표시 전용. (portal) layout(서버)에서 내려준다.
  // null 이면 "관리자님" fallback. 권한 로직과는 무관하다.
  adminDisplayName?: string | null;
  adminEmail?: string | null;
};

export default function Header({
  adminDisplayName = null,
  adminEmail = null,
}: HeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const devMode = useAdminDevMode();

  // 사이드바 최하단에 있던 기존 로그아웃 로직을 그대로 이동 (auth/세션 로직 수정 없음).
  const handleLogout = async () => {
    // Supabase 브라우저 SDK(~230KB)를 어드민 공통 초기 번들에서 제외 — 헤더는 모든 어드민
    // 페이지 레이아웃에 포함되므로, 로그아웃 클릭 시에만 동적 import 로 SDK 를 불러온다.
    const { getSupabaseBrowserClient } = await import("@/lib/supabaseBrowser");
    await getSupabaseBrowserClient().auth.signOut();
    router.push("/login");
    router.refresh();
  };

  // dev=true 만 토글하고 나머지 query/hash 는 보존.
  const handleToggleDev = () => {
    const qs = searchParams?.toString() ?? "";
    const current = qs ? `${pathname}?${qs}` : pathname;
    const next = toggleDevQuery(current, !devMode);
    router.replace(next);
  };

  // 관리자 정보 + 로그아웃: 헤더 우측에 세로 배치로 노출(테마 전환은 사이드바 하단으로 이동).
  // 1행: [로그아웃] 버튼 / 2행: 환영 문구 / 3행: 이름 | 이메일.
  // 이 3행 콘텐츠가 상단 바 높이(h-24)의 기준 — HOME 영역이 이 높이에 맞춰 늘어난다.
  const userArea = (
    // min-w-0(shrink-0 제거): 좁은 폭에서 고정폭 대신 이름/이메일 줄만 truncate 되도록
    <div className="flex min-w-0 flex-col items-end gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={handleLogout}
        aria-label="로그아웃"
        title="로그아웃"
        className="mb-2 shrink-0 font-semibold text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
      >
        <LogOut className="h-4 w-4" />
        로그아웃
      </Button>
      {/* 환영 문구 + 이름/이메일 두 줄은 같은 컨테이너에서 left-aligned —
          줄 길이가 달라도 왼쪽 시작 x좌표가 항상 일치한다. */}
      <div className="flex w-full min-w-0 flex-col items-start gap-0.5 text-left">
        <span className="text-sm font-medium text-foreground">
          반갑습니다! 😊
        </span>
        <span
          title={adminEmail ?? undefined}
          className="w-full max-w-52 truncate text-xs text-muted-foreground sm:max-w-80"
        >
          {(adminDisplayName ?? "관리자") + " 님"}
          {adminEmail ? ` | ${adminEmail}` : ""}
        </span>
      </div>
    </div>
  );

  // 페이지 제목(h1)은 글로벌 헤더에서 제거 — 본문 제목이 단일 소스. 헤더는 우측 사용자
  // 영역만 담당하므로 모든 페이지(HOME 포함)에서 동일하게 justify-end 로 정렬한다.
  // 고정 h-24 — 사이드바 상단 HOME 영역과 동일 높이(기준=Header, HOME 이 여기에 맞춰 늘어남).
  return (
    <header className="flex h-24 items-center justify-end gap-3 border-b border-border bg-background px-4 sm:gap-4 sm:px-6">
      {/* min-w-0(shrink-0 제거): 좁은 폭에서 userArea 의 이메일 줄이 truncate 되며 함께 줄어든다 */}
      <div className="flex min-w-0 items-center gap-2">
        {/* 개발자 표시 토글 — SHOW_DEV_TOGGLE=false 로 화면에서만 숨김 (기능/로직 유지) */}
        {SHOW_DEV_TOGGLE && (
          <Button
            type="button"
            variant={devMode ? "default" : "ghost"}
            size="sm"
            onClick={handleToggleDev}
            aria-pressed={devMode}
            title={
              devMode
                ? "개발자 표시 모드 ON — 클릭하여 끄기"
                : "개발자 표시 모드 OFF — 클릭하여 켜기"
            }
          >
            <Wrench className="h-4 w-4" />
            개발자 표시
            <span
              className={cn(
                "ml-1 rounded-full border px-1.5 py-0.5 text-2xs font-semibold",
                devMode
                  ? "border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground"
                  : "border-border bg-muted text-muted-foreground",
              )}
            >
              {devMode ? "ON" : "OFF"}
            </span>
          </Button>
        )}
        {userArea}
      </div>
    </header>
  );
}
