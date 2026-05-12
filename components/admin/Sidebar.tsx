"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronRight,
  LayoutDashboard,
  PanelLeft,
  PanelLeftClose,
  Upload,
  UserCog,
  Users,
  Settings as SettingsIcon,
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
  children: { label: string; href: string }[];
};

type MenuItem = LeafItem | BranchItem;

const MENU: MenuItem[] = [
  { kind: "leaf", label: "대시보드", href: "/admin", icon: LayoutDashboard },
  {
    kind: "branch",
    label: "조직 관리",
    icon: Users,
    basePath: "/admin/crews",
    children: ORGANIZATIONS.map((slug) => ({
      label: ORGANIZATION_LABEL[slug],
      href: `/admin/crews/${slug}`,
    })),
  },
  {
    kind: "branch",
    label: "사용자 관리",
    icon: UserCog,
    basePath: "/admin/users",
    children: [
      { label: "가입된 사용자", href: "/admin/users/app-users" },
      { label: "가입 대기자", href: "/admin/users/applicants" },
      { label: "관리자 계정", href: "/admin/users/admin-users" },
    ],
  },
  { kind: "leaf", label: "가져오기", href: "/admin/import", icon: Upload },
  { kind: "leaf", label: "설정", href: "/admin/settings", icon: SettingsIcon },
];

function isLeafActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(href + "/");
}

function isUnderBase(pathname: string, basePath: string) {
  return pathname === basePath || pathname.startsWith(basePath + "/");
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
        if (item.kind === "branch" && isUnderBase(pathname, item.basePath)) {
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
          <span className="text-base font-semibold tracking-tight text-sidebar-foreground">
            Vraxium Admin
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
          "flex flex-col gap-1",
          sidebarOpen ? "p-3" : "p-2",
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
                className={cn(
                  "flex items-center rounded-md text-sm font-medium transition-colors",
                  sidebarOpen
                    ? "gap-2 px-3 py-2"
                    : "h-9 w-9 justify-center self-center",
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {sidebarOpen && item.label}
              </Link>
            );
          }

          const Icon = item.icon;
          const inSection = isUnderBase(pathname, item.basePath);
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
                  "flex h-9 w-9 items-center justify-center self-center rounded-md text-sm font-medium transition-colors",
                  inSection
                    ? "bg-sidebar-primary/15 text-sidebar-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
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
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  inSection
                    ? "bg-sidebar-primary/15 text-sidebar-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1 text-left">{item.label}</span>
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    branchOpen && "rotate-90",
                  )}
                />
              </button>

              {branchOpen && (
                <ul
                  id={`submenu-${item.basePath}`}
                  className="mt-1 flex flex-col gap-0.5 border-l border-sidebar-border/60 pl-3 ml-4"
                >
                  {item.children.map((child) => {
                    const childActive = isLeafActive(pathname, child.href);
                    return (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          className={cn(
                            "block rounded-md px-2.5 py-1.5 text-sm transition-colors",
                            childActive
                              ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                              : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
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
