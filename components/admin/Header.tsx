"use client";

import { Fragment } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, LogOut, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  toggleDevQuery,
  useAdminDevMode,
} from "@/components/admin/useAdminDevMode";
import SessionCountdown from "@/components/admin/SessionCountdown";
import { resolveAdminBreadcrumb } from "@/lib/adminMenuTree";
import { useAdminRouteTitleForPath } from "@/components/admin/AdminRouteTitleProvider";
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

  // 헤더 좌측 현재 위치 표시("상위 메뉴 > 현재 페이지") — 사이드바와 동일한 메뉴명 SoT
  //   (lib/adminMenuTree.resolveAdminBreadcrumb). pathname 만 사용 → org/mode(?org·mode=test·
  //   actAsTestUserId·demoUserId) 와 무관, ID/UUID/slug 는 노출하지 않는다.
  const baseBreadcrumb = resolveAdminBreadcrumb(pathname);
  // 상세 페이지가 공급한 실제 표시명(이유나·26년 여름 시즌 8주차 …)이 있으면 마지막(현재 페이지)
  //   문구를 그것으로 교체한다. 없으면 고정 폴백("회원 상세" 등) 유지. — 중복 조회 없이 페이지가
  //   이미 가진 상세 DTO 표시명을 재사용(AdminRouteTitleProvider).
  const detailTitle = useAdminRouteTitleForPath(pathname);
  const breadcrumb =
    detailTitle && baseBreadcrumb.length > 0
      ? [...baseBreadcrumb.slice(0, -1), detailTitle]
      : baseBreadcrumb;

  // 사이드바 최하단에 있던 기존 로그아웃 로직을 그대로 이동 (auth/세션 로직 수정 없음).
  const handleLogout = async () => {
    // Supabase 브라우저 SDK(~230KB)를 어드민 공통 초기 번들에서 제외 — 헤더는 모든 어드민
    // 페이지 레이아웃에 포함되므로, 로그아웃 클릭 시에만 동적 import 로 SDK 를 불러온다.
    const { getSupabaseBrowserClient } = await import("@/lib/supabaseBrowser");
    await getSupabaseBrowserClient().auth.signOut();
    // 다른 모든 탭/창도 즉시 로그아웃 화면으로 보낸다(공유 쿠키는 이미 위 signOut 으로 제거됨).
    const { postAdminLogout } = await import("@/lib/adminAuthChannel");
    postAdminLogout();
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
  // 1행: [로그아웃] 버튼 / 2행: 환영 문구 / 3행: 이름 | 이메일 / 4행: 자동 로그아웃 카운트다운.
  // 이 4행 콘텐츠가 상단 바 높이(h-28)의 기준 — HOME 영역이 이 높이에 맞춰 늘어난다.
  // justify-center 로 블록 전체를 헤더 내부에서 세로 중앙 정렬(위/아래 여백 균등 → border 안 겹침).
  const userArea = (
    // min-w-0(shrink-0 제거): 좁은 폭에서 고정폭 대신 이름/이메일 줄만 truncate 되도록
    <div className="flex min-w-0 flex-col items-end justify-center gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={handleLogout}
        aria-label="로그아웃"
        title="로그아웃"
        // 표준 size(h-8)·items-center 유지 — 헤더 높이가 4행을 담으므로 글자 잘림 없음.
        className="shrink-0 font-semibold text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
      >
        <LogOut className="h-4 w-4" />
        로그아웃
      </Button>
      {/* 환영 문구 + 이름/이메일 + 카운트다운은 같은 컨테이너에서 left-aligned —
          줄 길이가 달라도 왼쪽 시작 x좌표가 항상 일치한다. leading-tight 로 줄 간격 정돈. */}
      <div className="flex w-full min-w-0 flex-col items-start gap-0.5 text-left leading-tight">
        <span className="whitespace-nowrap text-sm font-medium text-foreground">
          반갑습니다! 😊
        </span>
        <span
          title={adminEmail ?? undefined}
          className="w-full max-w-52 truncate text-xs text-muted-foreground sm:max-w-80"
        >
          {(adminDisplayName ?? "관리자") + " 님"}
          {adminEmail ? ` | ${adminEmail}` : ""}
        </span>
        {/* 자동 로그아웃 카운트다운 — 실제 로그아웃 타이머와 동일 SoT(AdminSessionProvider).
            mt-0.5 로 이메일 줄과 살짝 띄우고, 상단 헤더의 세로 중앙 정렬 여백이 하단 border 와의 간격을 확보. */}
        <SessionCountdown className="mt-0.5" />
      </div>
    </div>
  );

  // 페이지 제목(h1)은 본문(AdminPageHeader)이 단일 소스로 유지 — 헤더 좌측 경로는 현재 위치를
  //   보여주는 보조 내비게이션(본문 제목은 제거하지 않는다). 헤더 우측은 기존 사용자 영역 그대로.
  // 고정 h-32 — 4행 사용자 정보(로그아웃/환영/이름·이메일/카운트다운)가 잘리지 않고
  //   하단 border 와 여유(약 7px)가 생기는 높이. 사이드바 HOME 영역과 동일 높이(기준=Header).
  return (
    <header className="flex h-32 items-center justify-between gap-3 border-b border-border bg-background px-4 sm:gap-4 sm:px-6">
      {/* 좌측: 현재 위치 경로("상위 메뉴 > 현재 페이지"). 각 항목은 의미상 분리된 요소로 렌더링하고,
          단계 사이 구분자는 ChevronRight 아이콘(aria-hidden — 스크린리더가 읽지 않음)으로 표시한다.
          상위 계층=muted, 현재 페이지=semibold/foreground 로 시각 위계를 나눈다. 긴 경로는 각 항목의
          truncate 로 좁은 폭에서 줄어들어 우측 영역을 밀지 않는다(기존 반응형 동작 유지). */}
      <div className="min-w-0 flex-1">
        <nav
          aria-label="현재 위치"
          className="flex min-w-0 items-center gap-1.5"
        >
          {breadcrumb.map((part, i) => {
            const isCurrent = i === breadcrumb.length - 1;
            return (
              <Fragment key={i}>
                {i > 0 && (
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                )}
                <span
                  className={cn(
                    "truncate text-sm sm:text-base",
                    isCurrent
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {part}
                </span>
              </Fragment>
            );
          })}
        </nav>
      </div>

      {/* 우측: 기존 로그아웃·사용자 정보·자동 로그아웃 카운트다운(구조/동작 무변경).
          이메일 줄이 max-w+truncate 로 폭이 제한되므로 shrink-0 으로 좌측 경로에 밀리지 않는다. */}
      <div className="flex min-w-0 shrink-0 items-center gap-2">
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
