"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
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
import { ORGANIZATIONS, ORGANIZATION_LABEL } from "@/lib/organizations";
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

type SectionHeader = { kind: "section"; label: string };

type MenuItem = LeafItem | BranchItem | SectionHeader;

// 4-axis IA: 대시보드 / 멤버 관리 / 운영 관리 / 데이터 관리.
// 사이드바는 운영 행위(사람·정책·데이터) 기준으로 묶고, 프론트 화면 단위(cluster 등)는 노출하지 않는다.
// section 헤더는 사람(워크) vs 시스템(정책·데이터) 두 묶음을 시각적으로 구분만 한다 — 라우팅 없음.
// 모든 href 는 현재 실재하는 admin route 만 사용한다. (route 가 없는 항목은 메뉴에 두지 않는다.)
const MENU: MenuItem[] = [
  { kind: "leaf", label: "대시보드", href: "/admin", icon: LayoutDashboard },
  { kind: "section", label: "WORKSPACE" },
  {
    kind: "branch",
    label: "멤버 관리",
    icon: Users,
    basePath: "/admin/members",
    matchPaths: ["/admin/members", "/admin/crews", "/admin/users"],
    children: [
      { label: "전체 멤버", href: "/admin/members" },
      ...ORGANIZATIONS.map((slug) => ({
        label: ORGANIZATION_LABEL[slug],
        href: `/admin/crews/${slug}`,
      })),
      { label: "승인 대기", href: "/admin/users/applicants" },
      { label: "가입된 사용자", href: "/admin/users/app-users" },
      { label: "관리자 계정", href: "/admin/users/admin-users" },
    ],
  },
  { kind: "section", label: "SYSTEM" },
  {
    kind: "branch",
    label: "운영 관리",
    icon: Wrench,
    basePath: "/admin/settings",
    children: [
      { label: "작성 기간 관리", href: "/admin/settings/edit-windows" },
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

  // section 헤더는 다음에 오는 branch 들의 상위 묶음이지만 라우팅을 갖지 않으므로
  // 사이드바가 접힌 상태에서는 숨겨서 아이콘 줄을 일관되게 유지한다.
  const visibleMenu = sidebarOpen
    ? MENU
    : MENU.filter((item) => item.kind !== "section");

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
            Vraxium <span className="text-sidebar-foreground/50">Admin</span>
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
        {visibleMenu.map((item, idx) => {
          if (item.kind === "section") {
            return (
              <div
                key={`section-${idx}`}
                className="mt-3 mb-1 px-3 text-[10px] font-semibold tracking-[0.12em] text-sidebar-foreground/40 uppercase first:mt-1"
              >
                {item.label}
              </div>
            );
          }

          if (item.kind === "leaf") {
            const Icon = item.icon;
            const active = isLeafActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={!sidebarOpen ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group/leaf relative flex items-center rounded-md text-sm transition-colors",
                  sidebarOpen
                    ? "gap-2 px-3 py-1.5"
                    : "h-9 w-9 justify-center self-center",
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
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
            <div key={item.basePath} className="flex flex-col">
              <button
                type="button"
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
                  {item.children.map((child) => {
                    const childActive = isLeafActive(pathname, child.href);
                    return (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          aria-current={childActive ? "page" : undefined}
                          className={cn(
                            "block rounded-md px-2.5 py-1 text-[13px] transition-colors",
                            childActive
                              ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
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
