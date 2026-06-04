"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Briefcase,
  ChevronRight,
  Database,
  LayoutDashboard,
  PanelLeft,
  PanelLeftClose,
  Users,
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

type BranchItem = {
  kind: "branch";
  label: string;
  icon: LucideIcon;
  basePath: string;
  matchPaths?: string[];
  children: { label: string; href: string }[];
};


type MenuItem = LeafItem | BranchItem;

// 모든 href 는 현재 실재하는 admin route 만 사용한다. (route 가 없는 항목은 메뉴에 두지 않는다.)
const MENU: MenuItem[] = [
  { kind: "leaf", label: "대시보드", href: "/admin", icon: LayoutDashboard },
  {
    kind: "branch",
    label: "멤버 관리",
    icon: Users,
    basePath: "/admin/members",
    matchPaths: [
      "/admin/members",
      "/admin/crews",
      "/admin/users",
      "/admin/test-users",
      "/admin/settings/accounts",
    ],
    children: [
      { label: "전체 멤버", href: "/admin/members" },
      ...ORGANIZATIONS.map((slug) => ({
        label: ORGANIZATION_LABEL[slug],
        href: `/admin/crews/${slug}`,
      })),
      { label: "승인 대기", href: "/admin/users/applicants" },
      { label: "운영자 계정", href: "/admin/settings/accounts" },
      { label: "테스트 모드", href: "/admin/test-users" },
    ],
  },
  {
    kind: "branch",
    label: "라인 개설",
    icon: Briefcase,
    basePath: "/admin/career-projects",
    matchPaths: [
      "/admin/line-opening",
      ...ADMIN_LINE_OPENING_VISIBLE_PARTS.map((part) => part.href),
    ],
    children: [
      ...ADMIN_LINE_OPENING_VISIBLE_PARTS.map((part) => ({
        label: part.label,
        href: part.href,
      })),
      { label: "개설 이력", href: "/admin/line-opening/line-history" },
    ],
  },
  {
    kind: "branch",
    label: "운영 관리",
    icon: Wrench,
    basePath: "/admin/settings",
    // "/admin/settings" 광역 매칭 대신 실제 남은 children 경로만 매칭한다.
    // (계정 관리가 멤버 관리로 이동했으므로 /admin/settings/accounts 가 운영 관리까지
    //  동시에 활성화되지 않도록 한다.)
    matchPaths: [
      "/admin/settings/edit-windows",
      "/admin/settings/permissions",
      "/admin/season-weeks",
      "/admin/week-recognitions",
      "/admin/season-participations",
      "/admin/official-rest-periods",
      "/admin/operation-health-check",
    ],
    children: [
      { label: "작성 기간 관리", href: "/admin/settings/edit-windows" },
      { label: "시즌/주차 기준표", href: "/admin/season-weeks" },
      { label: "주차 인정 결과", href: "/admin/week-recognitions" },
      { label: "시즌 참여/휴식", href: "/admin/season-participations" },
      { label: "공식 휴식 관리", href: "/admin/official-rest-periods" },
      { label: "운영 정합성 점검", href: "/admin/operation-health-check" },
      { label: "권한 설정", href: "/admin/settings/permissions" },
    ],
  },
  {
    kind: "branch",
    label: "데이터 관리",
    icon: Database,
    basePath: "/admin/import",
    children: [
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

  // /admin HOME 화면에서는 메뉴 UI 는 보이되 클릭/이동을 막는다.
  // (다른 하위 페이지에서는 기존대로 동작, 사이드바 접기/펼치기는 항상 가능)
  const navLocked = pathname === "/admin";

  // 조직 모드: /admin/crews/{org} 이하에서는 멤버 관리 메뉴를 해당 조직 기준으로만 노출.
  // (전체 멤버·타 조직 링크 숨김 — HOME 의 엥크레/오랑캐/팔랑크스 진입 정책)
  const crewsMatch = pathname.match(/^\/admin\/crews\/([^/]+)/);
  const orgFocus =
    crewsMatch && isOrganizationSlug(crewsMatch[1]) ? crewsMatch[1] : null;

  const visibleChildren = (item: BranchItem) => {
    if (item.basePath !== "/admin/members" || !orgFocus) return item.children;
    return item.children.filter((child) => {
      if (child.href === "/admin/members") return false;
      const m = child.href.match(/^\/admin\/crews\/([^/]+)$/);
      if (m) return m[1] === orgFocus;
      return true;
    });
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


  return (
    <aside
      data-collapsed={!sidebarOpen}
      className={cn(
        "shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
        sidebarOpen ? "w-60" : "w-14",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b border-sidebar-border",
          sidebarOpen ? "justify-between px-4" : "justify-center px-0",
        )}
      >
        {sidebarOpen && (
          <span className="text-[13px] font-semibold tracking-[0.02em] text-sidebar-foreground">
            HOME
          </span>
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
          "flex flex-col",
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


