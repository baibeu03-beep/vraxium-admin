"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LogOut, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabaseClient } from "@/lib/supabaseClient";
import { ORGANIZATION_LABEL, isOrganizationSlug } from "@/lib/organizations";
import { readOrgParam } from "@/lib/adminOrgContext";
import {
  toggleDevQuery,
  useAdminDevMode,
} from "@/components/admin/useAdminDevMode";
import { cn } from "@/lib/utils";

// 개발자 표시 토글 버튼 노출 여부.
// 기능·로직·상태값은 모두 유지하고 렌더링만 끈다 — 다시 쓰려면 true 로 변경.
const SHOW_DEV_TOGGLE = false;

// 라인 개설 분기 페이지(실무 정보/경험/…): 헤더 title 텍스트 대신 [라인 관리]/[라인 개설] 2탭을 노출한다.
// 탭은 URL ?tab 으로 구동되어 본문 Manager 와 공유되고, 새로고침·?org 가 유지된다.
// 특정 org 에 하드코딩하지 않고 path 집합으로만 판별한다 — 조직 분기는 ?org(orgScoped)로 처리.
const LINE_OPENING_TAB_PATHS = new Set<string>([
  "/admin/line-opening/practical-info",
  "/admin/line-opening/practical-experience",
]);
const LINE_OPENING_TABS = [
  { key: "manage", label: "라인 관리" },
  { key: "open", label: "라인 개설" },
] as const;

// 통합 검수 시스템(원본) 헤더 타이틀 — 기존 그대로. (조직 분기 메뉴 개편과 무관하게 유지)
const TITLES: Record<string, string> = {
  "/admin": "대시보드",
  "/admin/periods/register": "주차와 시즌 · 기간 등록",
  "/admin/season-weeks": "주차와 시즌 · 기간 정보",
  "/admin/members": "멤버 관리 · 전체 멤버",
  "/admin/crews": "멤버 관리 · 조직별",
  "/admin/users/applicants": "멤버 관리 · 승인 대기",
  "/admin/users/app-users": "멤버 관리 · 가입된 사용자",
  "/admin/users/admin-users": "멤버 관리 · 관리자 계정",
  "/admin/settings/edit-windows": "운영 관리 · 작성 기간",
  "/admin/settings/line-opening-windows": "운영 관리 · 라인 개설 기간",
  "/admin/lines/register": "허브와 라인 · 라인 등록",
  "/admin/lines/info": "허브와 라인 · 라인 정보",
  "/admin/career-projects": "라인 개설 · 실무 경력",
  "/admin/import": "데이터 관리 · 가져오기",
};

function resolveTitle(pathname: string): string {
  const direct = TITLES[pathname];
  if (direct) return direct;
  const orgMatch = pathname.match(/^\/admin\/crews\/([^/]+)/);
  if (orgMatch) {
    const slug = orgMatch[1];
    if (isOrganizationSlug(slug)) {
      return `멤버 관리 · ${ORGANIZATION_LABEL[slug]}`;
    }
  }
  return "Admin";
}

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
  const title = resolveTitle(pathname);

  // 라인 개설 2탭은 **조직 분기 모드(?org 있음)** 에서만 title 영역에 노출한다.
  // 통합 검수 시스템(원본)에는 영향이 없어야 하므로 ?org 없는 경우는 기존 title 텍스트를 그대로 둔다.
  const orgScoped = readOrgParam(searchParams) != null;
  const isLineOpeningTabs = LINE_OPENING_TAB_PATHS.has(pathname) && orgScoped;
  const currentInfoTab: "manage" | "open" =
    searchParams?.get("tab") === "open" ? "open" : "manage";
  const infoTabHref = (key: "manage" | "open") => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (key === "open") params.set("tab", "open");
    else params.delete("tab"); // 기본(라인 관리) = tab 파라미터 제거(깔끔한 URL)
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  // 사이드바 최하단에 있던 기존 로그아웃 로직을 그대로 이동 (auth/세션 로직 수정 없음).
  const handleLogout = async () => {
    await supabaseClient.auth.signOut();
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

  // 관리자 정보 + 로그아웃: 항상 헤더 우측에 세로 배치로 노출.
  // (사이드바 footer 제거로 헤더가 유일한 로그아웃 진입점 — HOME 에서도 노출)
  // 1행: [로그아웃] 버튼 / 2행: 환영 문구 / 3행: 이름 | 이메일
  const userArea = (
    // min-w-0(shrink-0 제거): 좁은 폭에서 고정폭 대신 이름/이메일 줄만 truncate 되도록
    <div className="flex min-w-0 flex-col items-end gap-0.5">
      {/* size sm→default(1단계 업: h-7/text-[0.8rem] → h-8/text-sm) + font-semibold —
          우측 영역에서 가장 눈에 띄는 요소. mb-2 로 아래 사용자 정보와 세로 여백 분리. */}
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
      {/* w-full+min-w-0: items-end 컬럼에서 stretch 가 풀려도 부모 폭을 따라가
          이름/이메일 span 의 truncate 가 좁은 폭에서 실제로 동작하게 한다 */}
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

  // /admin HOME 화면에서는 타이틀/버튼은 숨기되 관리자 정보+로그아웃은 유지한다.
  // (우측 세로 3행 배치 — 고정 h-14 대신 py 로 가변 높이)
  if (pathname === "/admin") {
    return (
      <header className="flex items-center justify-end gap-4 border-b border-border bg-background px-4 py-2 sm:px-6">
        {userArea}
      </header>
    );
  }

  return (
    // px-4 sm:px-6 + 타이틀 flex-1: 좁은 폭(사이드바 펼침 + 모바일)에서도 우측 영역이 잘리지 않도록
    // 우측 세로 3행 배치 — 고정 h-14 대신 py 로 가변 높이
    <header className="flex items-center justify-between gap-3 border-b border-border bg-background px-4 py-2 sm:gap-4 sm:px-6">
      {isLineOpeningTabs ? (
        // 헤더 title 텍스트 대신 라인 관리/라인 개설 2탭. (org 보존, ?tab 구동, 새로고침 유지)
        <nav
          aria-label="라인 개설 탭"
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          {LINE_OPENING_TABS.map((t) => {
            const active = currentInfoTab === t.key;
            return (
              <Link
                key={t.key}
                href={infoTabHref(t.key)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-3.5 py-1.5 text-sm font-semibold transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      ) : (
        <h1 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-tight text-foreground">
          {title}
        </h1>
      )}
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
                "ml-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
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
