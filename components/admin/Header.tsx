"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ORGANIZATION_LABEL, isOrganizationSlug } from "@/lib/organizations";
import {
  toggleDevQuery,
  useAdminDevMode,
} from "@/components/admin/useAdminDevMode";
import { cn } from "@/lib/utils";

// 사이드바 IA 와 1:1 동기화. (사용자 관리/설정 같은 옛 라벨은 더 이상 노출하지 않는다.)
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

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const devMode = useAdminDevMode();
  const title = resolveTitle(pathname);

  // 로그아웃 버튼은 사이드바 최하단으로 이동했다 (components/admin/Sidebar.tsx).

  // dev=true 만 토글하고 나머지 query/hash 는 보존.
  const handleToggleDev = () => {
    const qs = searchParams?.toString() ?? "";
    const current = qs ? `${pathname}?${qs}` : pathname;
    const next = toggleDevQuery(current, !devMode);
    router.replace(next);
  };

  // /admin HOME 화면에서는 헤더를 빈 상태로 둔다 (타이틀/버튼 모두 숨김).
  if (pathname === "/admin") {
    return (
      <header className="flex h-14 items-center border-b border-border bg-background px-6" />
    );
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-background px-6">
      <h1 className="text-[13.5px] font-semibold tracking-tight text-foreground">{title}</h1>
      <div className="flex items-center gap-2">
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
      </div>
    </header>
  );
}
