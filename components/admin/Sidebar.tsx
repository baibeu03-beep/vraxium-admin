"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Briefcase,
  CalendarDays,
  ChevronRight,
  LayoutDashboard,
  Network,
  PanelLeft,
  PanelLeftClose,
  TrendingUp,
  UserPlus,
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ORGANIZATIONS,
  ORGANIZATION_LABEL,
  isOrganizationSlug,
} from "@/lib/organizations";
import { ADMIN_LINE_OPENING_VISIBLE_PARTS } from "@/lib/adminLineOpening";
import { useSidebar } from "@/components/admin/sidebarContext";

type LeafItem = {
  kind: "leaf";
  label: string;
  href: string;
  icon: LucideIcon;
};

type ChildItem = {
  label: string;
  href: string;
  // 통합/조직 모드 메뉴 노출 분기 (Phase 1: 노출만 분기, 라우트·데이터 필터는 공용 유지)
  integratedOnly?: boolean; // 통합 검수 시스템(orgFocus 없음)에서만 노출
  orgOnly?: boolean; // 조직 모드(/admin/crews/{org} 이하)에서만 노출
};

type BranchItem = {
  kind: "branch";
  label: string;
  icon: LucideIcon;
  basePath: string;
  matchPaths?: string[];
  children: ChildItem[];
};


type MenuItem = LeafItem | BranchItem;

// 모든 href 는 현재 실재하는 admin route 만 사용한다. (route 가 없는 항목은 메뉴에 두지 않는다.)
// 기능 미구현 메뉴는 "추후 구현 예정" placeholder route 로 연결한다. (IA 개편 Phase 1, 2026-06-07)
const MENU: MenuItem[] = [
  { kind: "leaf", label: "대시보드", href: "/admin", icon: LayoutDashboard },
  {
    kind: "branch",
    label: "주차와 시즌",
    icon: CalendarDays,
    basePath: "/admin/season-weeks",
    matchPaths: [
      "/admin/periods",
      "/admin/season-weeks",
      "/admin/week-recognitions",
    ],
    children: [
      { label: "기간 등록", href: "/admin/periods/register" },
      { label: "기간 정보", href: "/admin/season-weeks" },
      { label: "주차 인정 결과", href: "/admin/week-recognitions" },
    ],
  },
  {
    kind: "branch",
    label: "허브와 라인",
    icon: Briefcase,
    basePath: "/admin/line-opening",
    matchPaths: [
      "/admin/lines",
      "/admin/line-opening",
      "/admin/career-projects",
    ],
    children: [
      { label: "라인 등록", href: "/admin/lines/register" },
      // Phase 2B: 라인 정보 = 통합 카탈로그(/admin/lines/info). 기존 개설 이력 화면은
      // 동일 URL 그대로 유지하고 메뉴명만 "개설 이력"으로 분리 노출한다.
      { label: "라인 정보", href: "/admin/lines/info" },
      { label: "개설 이력", href: "/admin/line-opening/line-history" },
      // 통합 모드: 실무 경력 단일 진입만 노출.
      // 조직 모드: 기존 허브별 4메뉴(실무 정보/경험/역량/경력)를 그대로 유지(orgOnly).
      {
        label: "라인 개설 [실무 경력]",
        href: "/admin/line-opening/practical-career",
        integratedOnly: true,
      },
      ...ADMIN_LINE_OPENING_VISIBLE_PARTS.map((part) => ({
        label: part.label,
        href: part.href,
        orgOnly: true,
      })),
    ],
  },
  {
    kind: "branch",
    label: "허브별 프로세스",
    icon: Workflow,
    basePath: "/admin/processes",
    children: [
      { label: "프로세스 등록", href: "/admin/processes/register" },
      { label: "프로세스 정보", href: "/admin/processes/info" },
      { label: "프로세스 체크 [실무 경력]", href: "/admin/processes/check" },
    ],
  },
  {
    kind: "branch",
    label: "팀과 파트",
    icon: Network,
    basePath: "/admin/team-parts",
    children: [
      { label: "팀 & 파트 정보", href: "/admin/team-parts/info" },
      { label: "팀 & 파트 등록", href: "/admin/team-parts/register" },
    ],
  },
  {
    kind: "branch",
    label: "클럽 진행",
    icon: TrendingUp,
    basePath: "/admin/club-progress",
    children: [
      { label: "주차 내역", href: "/admin/club-progress/weekly" },
      { label: "시즌 내역", href: "/admin/club-progress/seasons" },
    ],
  },
  {
    kind: "branch",
    label: "크루 활동",
    icon: Users,
    basePath: "/admin/members",
    matchPaths: [
      "/admin/members",
      "/admin/crews",
      "/admin/rest-management",
      "/admin/season-participations",
      "/admin/official-rest-periods",
      "/admin/communications",
    ],
    children: [
      // 통합 모드: 전체 멤버 목록. 조직 모드: 해당 조직 크루 목록만
      // (전체 멤버·타 조직 링크 숨김 — HOME 의 엥크레/오랑캐/팔랑크스 진입 정책 유지)
      { label: "크루 관리", href: "/admin/members", integratedOnly: true },
      ...ORGANIZATIONS.map((slug) => ({
        label: `크루 관리 (${ORGANIZATION_LABEL[slug]})`,
        href: `/admin/crews/${slug}`,
        orgOnly: true,
      })),
      { label: "휴식 관리", href: "/admin/rest-management" },
      { label: "시즌 참여/휴식", href: "/admin/season-participations" },
      { label: "공식 휴식 관리", href: "/admin/official-rest-periods" },
      { label: "커뮤니케이션", href: "/admin/communications" },
    ],
  },
  {
    kind: "branch",
    label: "크루 온보딩",
    icon: UserPlus,
    basePath: "/admin/users",
    children: [{ label: "크루 등록", href: "/admin/users/applicants" }],
  },
  {
    kind: "branch",
    label: "어드민 관리",
    icon: Wrench,
    basePath: "/admin/settings",
    // "/admin/settings" 광역 매칭 대신 실제 children 경로만 매칭한다.
    matchPaths: [
      "/admin/settings/accounts",
      "/admin/settings/edit-windows",
      "/admin/settings/permissions",
      "/admin/operation-health-check",
      "/admin/test-users",
      "/admin/import",
    ],
    children: [
      { label: "어드민 계정", href: "/admin/settings/accounts" },
      { label: "작성 기간 관리", href: "/admin/settings/edit-windows" },
      { label: "권한 설정", href: "/admin/settings/permissions" },
      { label: "운영 정합성 점검", href: "/admin/operation-health-check" },
      { label: "테스트 모드", href: "/admin/test-users" },
      { label: "가져오기", href: "/admin/import" },
    ],
  },
];

function isLeafActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(href + "/");
}

function isUnderBase(pathname: string, basePath: string) {
  return pathname === basePath || pathname.startsWith(basePath + "/");
}

function isUnderAnyBase(pathname: string, item: BranchItem) {
  const paths = item.matchPaths ?? [item.basePath];
  return paths.some((p) => isUnderBase(pathname, p));
}

export default function Sidebar() {
  const pathname = usePathname();
  const {
    open: sidebarOpen,
    setOpen: setSidebarOpen,
    toggle: toggleSidebar,
  } = useSidebar();

  // 관리자 정보 + 로그아웃은 상단 Header 우측으로 이동했다 (components/admin/Header.tsx).

  // /admin HOME 화면에서는 메뉴 UI 는 보이되 클릭/이동을 막는다.
  // (다른 하위 페이지에서는 기존대로 동작, 사이드바 접기/펼치기는 항상 가능)
  const navLocked = pathname === "/admin";

  // 조직 모드: /admin/crews/{org} 이하에서는 조직별 페이지 기준으로 메뉴를 분기.
  // (통합 검수 시스템 ↔ 조직별 페이지는 같은 사이드바에서 노출만 분기 — 라우트 공용)
  const crewsMatch = pathname.match(/^\/admin\/crews\/([^/]+)/);
  const orgFocus =
    crewsMatch && isOrganizationSlug(crewsMatch[1]) ? crewsMatch[1] : null;

  // - integratedOnly: 통합 모드에서만 노출 (조직 모드에서 숨김)
  // - orgOnly: 조직 모드에서만 노출 (통합 모드에서 숨김 — 허브별 라인 개설 메뉴 등)
  // - /admin/crews/{slug} 링크는 현재 조직 것만 노출 (기존 진입 정책 유지)
  const visibleChildren = (item: BranchItem) =>
    item.children.filter((child) => {
      if (child.integratedOnly && orgFocus) return false;
      if (child.orgOnly && !orgFocus) return false;
      const m = child.href.match(/^\/admin\/crews\/([^/]+)$/);
      if (m) return m[1] === orgFocus;
      return true;
    });

  const [openBranches, setOpenBranches] = useState<Record<string, boolean>>(
    () => {
      const init: Record<string, boolean> = {};
      for (const item of MENU) {
        if (item.kind === "branch" && isUnderAnyBase(pathname, item)) {
          init[item.basePath] = true;
        }
      }
      return init;
    },
  );

  // 홈(/admin) 도착 시 펼쳐져 있던 하위 카테고리를 모두 접는다.
  // (사이드바 HOME 링크·직접 URL 진입 공통 — URL 이동만이 아니라 open state 도 초기화.
  //  하위 페이지로 다시 이동하면 branchOpen 의 inSection fallback 으로 해당 분기가 자동으로 펼쳐진다.)
  useEffect(() => {
    if (pathname === "/admin") setOpenBranches({});
  }, [pathname]);


  return (
    <aside
      data-collapsed={!sidebarOpen}
      className={cn(
        // sticky+h-screen: 페이지 콘텐츠가 길어 문서 전체가 스크롤돼도 사이드바는
        // 뷰포트에 고정 (메뉴는 nav 내부 스크롤).
        "sticky top-0 h-screen flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
        sidebarOpen ? "w-60" : "w-14",
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-sidebar-border",
          sidebarOpen ? "justify-between px-4" : "justify-center px-0",
        )}
      >
        {sidebarOpen && (
          // HOME 라벨 = /admin 홈 링크. /admin(HOME)에서는 navLocked 로 다른 메뉴와 동일하게 이동 차단.
          <Link
            href="/admin"
            aria-disabled={navLocked || undefined}
            tabIndex={navLocked ? -1 : undefined}
            onClick={(e) => {
              if (navLocked) e.preventDefault();
            }}
            className={cn(
              "rounded-md text-[13px] font-semibold tracking-[0.02em] text-sidebar-foreground transition-colors hover:text-sidebar-accent-foreground",
              navLocked && "pointer-events-none",
            )}
          >
            HOME
          </Link>
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? "사이드바 접기" : "사이드바 펴기"}
          aria-expanded={sidebarOpen}
          title={sidebarOpen ? "사이드바 접기" : "사이드바 펴기"}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {sidebarOpen ? (
            <PanelLeftClose className="h-4 w-4" />
          ) : (
            <PanelLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      <nav
        className={cn(
          "flex flex-1 flex-col overflow-y-auto",
          sidebarOpen ? "gap-0.5 p-2.5" : "gap-1 p-2",
        )}
      >
        {MENU.map((item) => {
          if (item.kind === "leaf") {
            const Icon = item.icon;
            const active = isLeafActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={!sidebarOpen ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                aria-disabled={navLocked || undefined}
                tabIndex={navLocked ? -1 : undefined}
                onClick={(e) => {
                  if (navLocked) e.preventDefault();
                }}
                className={cn(
                  "group/leaf relative flex items-center rounded-md text-sm transition-colors",
                  sidebarOpen
                    ? "gap-2 px-3 py-1.5"
                    : "h-9 w-9 justify-center self-center",
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                  navLocked && "pointer-events-none",
                )}
              >
                <Icon className={cn("h-4 w-4 shrink-0", !active && "text-sidebar-foreground/55 group-hover/leaf:text-sidebar-accent-foreground")} />
                {sidebarOpen && <span className="truncate">{item.label}</span>}
              </Link>
            );
          }

          const Icon = item.icon;
          const inSection = isUnderAnyBase(pathname, item);
          const branchOpen = openBranches[item.basePath] ?? inSection;

          // 사이드바가 접힌 상태: 아이콘만, 클릭 시 펼치고 분기도 같이 연다.
          if (!sidebarOpen) {
            return (
              <button
                key={item.basePath}
                type="button"
                title={item.label}
                disabled={navLocked}
                onClick={() => {
                  setSidebarOpen(true);
                  setOpenBranches((p) => ({ ...p, [item.basePath]: true }));
                }}
                className={cn(
                  "flex h-9 w-9 items-center justify-center self-center rounded-md text-sm transition-colors",
                  inSection
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          }

          return (
            <div key={item.basePath} className="mt-1 first:mt-0 flex flex-col">
              <button
                type="button"
                disabled={navLocked}
                onClick={() =>
                  setOpenBranches((p) => ({
                    ...p,
                    [item.basePath]: !branchOpen,
                  }))
                }
                aria-expanded={branchOpen}
                aria-controls={`submenu-${item.basePath}`}
                className={cn(
                  "group/branch flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                  inSection
                    ? "text-sidebar-foreground font-medium"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className={cn("h-4 w-4 shrink-0", !inSection && "text-sidebar-foreground/55 group-hover/branch:text-sidebar-accent-foreground")} />
                <span className="flex-1 text-left">{item.label}</span>
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 text-sidebar-foreground/40 transition-transform",
                    branchOpen && "rotate-90",
                  )}
                />
              </button>

              {branchOpen && (
                <ul
                  id={`submenu-${item.basePath}`}
                  className="mt-0.5 mb-1 ml-[1.0625rem] flex flex-col gap-px border-l border-sidebar-border pl-2"
                >
                  {visibleChildren(item).map((child) => {
                    const childActive = isLeafActive(pathname, child.href);
                    return (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          aria-current={childActive ? "page" : undefined}
                          aria-disabled={navLocked || undefined}
                          tabIndex={navLocked ? -1 : undefined}
                          onClick={(e) => {
                            if (navLocked) e.preventDefault();
                          }}
                          className={cn(
                            "block rounded-md px-2.5 py-1 text-[13px] transition-colors",
                            childActive
                              ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                            navLocked && "pointer-events-none",
                          )}
                        >
                          {child.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}


