"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Briefcase,
  CalendarDays,
  ChevronRight,
  LayoutDashboard,
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
  isOrganizationSlug,
} from "@/lib/organizations";
import { orgHref, readOrgParam } from "@/lib/adminOrgContext";
import { useSidebar } from "@/components/admin/sidebarContext";

// 통합/조직 모드 노출 분기 플래그. (대분류 leaf/branch + 중분류 child 공통)
//  - integratedOnly: 통합 검수 시스템(orgFocus 없음)에서만 노출
//  - orgOnly:        조직 모드(orgFocus 있음)에서만 노출
type ScopeFlags = {
  integratedOnly?: boolean;
  orgOnly?: boolean;
};

type LeafItem = ScopeFlags & {
  kind: "leaf";
  label: string;
  href: string;
  icon: LucideIcon;
};

type ChildItem = ScopeFlags & {
  label: string;
  href: string;
  // org 컬럼이 없는 전역 페이지(주차와 시즌 등) — 조직 모드에서도 ?org 를 부착하지 않는다.
  globalScope?: boolean;
};

type BranchItem = ScopeFlags & {
  kind: "branch";
  label: string;
  icon: LucideIcon;
  basePath: string;
  matchPaths?: string[];
  children: ChildItem[];
};


type MenuItem = LeafItem | BranchItem;

// 모든 href 는 현재 실재하는 admin route 만 사용한다. (route 가 없는 항목은 메뉴에 두지 않는다.)
// 기능 미구현 메뉴는 "추후 구현 예정" placeholder route 로 연결한다.
//
// IA 개편 (통합 검수 시스템 ↔ 조직 진입 공통, 2026-06-08):
//   조직 모드(orgFocus 있음)  = 아래 5개 대분류 + 각 대분류의 비-integratedOnly child 만.
//   통합 모드(통합 검수 시스템) = 5개 대분류(관리성 integratedOnly child 포함) + 전역 대분류
//                                (대시보드 / 크루 온보딩 / 어드민 관리, 모두 integratedOnly).
//   → 기존 기능은 전부 통합 모드에서 도달 가능, 조직 모드는 요청된 5개 구조만 노출.
const MENU: MenuItem[] = [
  // 전역(통합 모드 전용)
  {
    kind: "leaf",
    label: "대시보드",
    href: "/admin",
    icon: LayoutDashboard,
    integratedOnly: true,
  },

  // 1) 라인 개설 — 기존 manager 그대로 유지(실무 정보/경험/역량).
  {
    kind: "branch",
    label: "라인 개설",
    icon: Briefcase,
    basePath: "/admin/line-opening",
    matchPaths: ["/admin/line-opening", "/admin/lines/register"],
    children: [
      { label: "실무 정보", href: "/admin/line-opening/practical-info" },
      { label: "실무 경험", href: "/admin/line-opening/practical-experience" },
      { label: "실무 역량", href: "/admin/line-opening/practical-competency" },
      // 통합 모드에서만 도달하는 기존 관리성 메뉴(기능 유지).
      { label: "라인 등록", href: "/admin/lines/register", integratedOnly: true },
      {
        label: "개설 이력",
        href: "/admin/line-opening/line-history",
        integratedOnly: true,
      },
      {
        label: "라인 개설 [실무 경력]",
        href: "/admin/line-opening/practical-career",
        integratedOnly: true,
      },
    ],
  },

  // 2) 프로세스 체크 — 기획 전 placeholder(라우트만). 데이터 API 없음.
  {
    kind: "branch",
    label: "프로세스 체크",
    icon: Workflow,
    basePath: "/admin/processes/check",
    children: [
      { label: "실무 정보 급", href: "/admin/processes/check/info" },
      { label: "실무 경험 급", href: "/admin/processes/check/experience" },
      { label: "실무 역량 급", href: "/admin/processes/check/competency" },
      { label: "클럽 급", href: "/admin/processes/check/club" },
    ],
  },

  // 3) 클럽 진행 — 기존 placeholder.
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

  // 4) 크루 활동 — 크루 관리(통합=전체 / 조직=해당 조직 목록), 휴식 관리·커뮤니케이션.
  {
    kind: "branch",
    label: "크루 활동",
    icon: Users,
    basePath: "/admin/members",
    matchPaths: [
      "/admin/members",
      "/admin/crews",
      "/admin/rest-management",
      "/admin/communications",
      "/admin/season-participations",
      "/admin/official-rest-periods",
    ],
    children: [
      // 통합 모드: 전체 멤버 목록(/admin/members, 서버 org 필터 없음).
      { label: "크루 관리", href: "/admin/members", integratedOnly: true },
      // 조직 모드: 해당 조직 크루 목록만(path 기반 /admin/crews/{org}, 이미 서버 org 필터).
      ...ORGANIZATIONS.map((slug) => ({
        label: "크루 관리",
        href: `/admin/crews/${slug}`,
        orgOnly: true,
      })),
      { label: "휴식 관리", href: "/admin/rest-management" },
      { label: "커뮤니케이션", href: "/admin/communications" },
      // 통합 모드에서만 도달하는 기존 메뉴(기능 유지).
      {
        label: "시즌 참여/휴식",
        href: "/admin/season-participations",
        integratedOnly: true,
      },
      {
        label: "공식 휴식 관리",
        href: "/admin/official-rest-periods",
        integratedOnly: true,
      },
    ],
  },

  // 5) 클럽 정보 — 카탈로그/정보 묶음.
  {
    kind: "branch",
    label: "클럽 정보",
    icon: CalendarDays,
    basePath: "/admin/season-weeks",
    matchPaths: [
      "/admin/season-weeks",
      "/admin/periods",
      "/admin/week-recognitions",
      "/admin/lines/info",
      "/admin/processes/info",
      "/admin/processes/register",
      "/admin/team-parts",
    ],
    children: [
      // 주차/시즌은 org 컬럼이 없는 전역 데이터 → 조직 모드에서도 ?org 미부착.
      { label: "주차와 시즌", href: "/admin/season-weeks", globalScope: true },
      { label: "허브와 라인", href: "/admin/lines/info" },
      { label: "허브별 프로세스 목록", href: "/admin/processes/info" },
      { label: "팀 & 파트", href: "/admin/team-parts/info" },
      // 통합 모드에서만 도달하는 기존 관리성 메뉴(기능 유지).
      { label: "기간 등록", href: "/admin/periods/register", integratedOnly: true },
      {
        label: "주차 인정 결과",
        href: "/admin/week-recognitions",
        integratedOnly: true,
      },
      {
        label: "프로세스 등록",
        href: "/admin/processes/register",
        integratedOnly: true,
      },
      {
        label: "팀 & 파트 등록",
        href: "/admin/team-parts/register",
        integratedOnly: true,
      },
    ],
  },

  // 전역(통합 모드 전용)
  {
    kind: "branch",
    label: "크루 온보딩",
    icon: UserPlus,
    basePath: "/admin/users",
    integratedOnly: true,
    children: [{ label: "크루 등록", href: "/admin/users/applicants" }],
  },
  {
    kind: "branch",
    label: "어드민 관리",
    icon: Wrench,
    basePath: "/admin/settings",
    integratedOnly: true,
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
  const searchParams = useSearchParams();
  const {
    open: sidebarOpen,
    setOpen: setSidebarOpen,
    toggle: toggleSidebar,
  } = useSidebar();

  // 관리자 정보 + 로그아웃은 상단 Header 우측으로 이동했다 (components/admin/Header.tsx).

  // /admin HOME 화면에서는 메뉴 UI 는 보이되 클릭/이동을 막는다.
  // (다른 하위 페이지에서는 기존대로 동작, 사이드바 접기/펼치기는 항상 가능)
  const navLocked = pathname === "/admin";

  // 조직 컨텍스트(orgFocus):
  //   1) /admin/crews/{org} (크루 목록은 path 기반 — 기존 진입 정책 유지)
  //   2) 그 외 공유 페이지는 ?org={slug} (사이드바가 부착, 어드민 org 컨텍스트 단일 출처)
  // path 가 우선. 둘 다 없으면 null = 통합 모드(통합 검수 시스템).
  const crewsMatch = pathname.match(/^\/admin\/crews\/([^/]+)/);
  const pathOrg =
    crewsMatch && isOrganizationSlug(crewsMatch[1]) ? crewsMatch[1] : null;
  const orgFocus = pathOrg ?? readOrgParam(searchParams);

  // 대분류(leaf/branch) 노출 분기: integratedOnly=통합 모드만, orgOnly=조직 모드만.
  const isItemVisible = (item: MenuItem) => {
    if (item.integratedOnly && orgFocus) return false;
    if (item.orgOnly && !orgFocus) return false;
    return true;
  };

  // - integratedOnly: 통합 모드에서만 노출 (조직 모드에서 숨김)
  // - orgOnly: 조직 모드에서만 노출 (통합 모드에서 숨김 — 조직별 크루 목록 등)
  // - /admin/crews/{slug} 링크는 현재 조직 것만 노출 (기존 진입 정책 유지)
  const visibleChildren = (item: BranchItem) =>
    item.children.filter((child) => {
      if (child.integratedOnly && orgFocus) return false;
      if (child.orgOnly && !orgFocus) return false;
      const m = child.href.match(/^\/admin\/crews\/([^/]+)$/);
      if (m) return m[1] === orgFocus;
      return true;
    });

  // 조직 모드에서 공유 페이지 링크에 ?org 를 부착한다.
  //   - /admin/crews/{org}: path 기반 → 그대로(부착 안 함)
  //   - globalScope(주차와 시즌 등 org 컬럼 없는 전역 페이지): 그대로(부착 안 함)
  //   - 그 외: orgHref 로 ?org 부착 (통합 모드면 orgFocus=null → 원본 그대로)
  const childHref = (child: ChildItem) => {
    if (child.globalScope) return child.href;
    if (/^\/admin\/crews\/[^/]+$/.test(child.href)) return child.href;
    return orgHref(child.href, orgFocus);
  };

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
        {MENU.filter(isItemVisible).map((item) => {
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
                          href={childHref(child)}
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


