"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Moon,
  PanelLeft,
  PanelLeftClose,
  Sun,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/theme/ThemeProvider";
import { orgHref, resolveAdminOrgFocus } from "@/lib/adminOrgContext";
import {
  adminEnvironmentTheme,
  isOrganizationSlug,
  type OrganizationSlug,
} from "@/lib/organizations";
import { useSidebar } from "@/components/admin/sidebarContext";
import { useAdminMode } from "@/components/admin/AdminModeProvider";
import OrgEnvironmentBanner from "@/components/admin/OrgEnvironmentBanner";
import {
  MENU_INTEGRATED,
  MENU_ORG,
  isLeafActive,
  isUnderBase,
  type BranchItem,
  type ChildItem,
  type MenuItem,
} from "@/lib/adminMenuTree";

// 메뉴 트리(MENU_INTEGRATED/MENU_ORG)·타입·매칭 헬퍼(isLeafActive/isUnderBase)는
//   lib/adminMenuTree.ts 로 이관(사이드바·전역 헤더 경로 표시 공용 SoT). 여기서는 렌더만 담당.

// 마지막 세그먼트로 현재 조직을 path 인코딩하는 자식 메뉴의 org 를 뽑는다(없으면 null).
//   대상: 크루 목록(/admin/crews/{org}), 팀 내역 상세(/admin/team-parts/info/{org}),
//   주차 결과(크루)(/admin/team-parts/info/crew-week-results/{org}).
//   이런 자식은 org 별로 생성되며 사이드바가 현재 orgFocus 것 하나만 노출한다(visibleChildren).
//   ⚠ /admin/team-parts/info/{seasons|weeks} 처럼 org slug 가 아닌 정적 세그먼트는 스코프 자식이
//     아니다 — isOrganizationSlug 로 구분해 seasons/weeks 메뉴가 실수로 숨겨지지 않게 한다.
function orgScopedChildOrg(href: string): OrganizationSlug | null {
  const m = href.match(
    /^\/admin\/(?:crews|team-parts\/info(?:\/crew-week-results)?)\/([^/]+)$/,
  );
  return m && isOrganizationSlug(m[1]) ? m[1] : null;
}

// 사이드바 최하단 설정 영역 — 라이트/다크 테마 전환. 네비게이션과 분리(상단 border-t).
//   · 펼침: "테마" 라벨 + 라이트/다크 세그먼트 토글(설정처럼 보이게).
//   · 접힘: 아이콘 1개만 — 클릭 시 토글.
// theme 은 useSyncExternalStore 기반이라 하이드레이션 중엔 서버값(light)으로 그려져 mismatch 가 없고,
// 하이드레이션 직후 실제 값으로 자동 전환된다.
function ThemeSettings({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  if (collapsed) {
    return (
      <div className="flex shrink-0 justify-center border-t border-sidebar-border p-2">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
          title={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
          className="flex h-9 w-9 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    );
  }

  const optionClass = (active: boolean) =>
    cn(
      "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
      active
        ? "bg-sidebar text-sidebar-foreground shadow-sm"
        : "text-sidebar-foreground/55 hover:text-sidebar-foreground",
    );

  return (
    <div className="shrink-0 border-t border-sidebar-border p-2.5">
      <p className="px-1 pb-1.5 text-2xs font-medium uppercase tracking-wide text-sidebar-foreground/45">
        테마
      </p>
      <div
        role="group"
        aria-label="테마 전환"
        className="flex gap-1 rounded-md bg-sidebar-accent/40 p-0.5"
      >
        <button
          type="button"
          onClick={() => setTheme("light")}
          aria-pressed={!isDark}
          className={optionClass(!isDark)}
        >
          <Sun className="h-3.5 w-3.5" />
          라이트
        </button>
        <button
          type="button"
          onClick={() => setTheme("dark")}
          aria-pressed={isDark}
          className={optionClass(isDark)}
        >
          <Moon className="h-3.5 w-3.5" />
          다크
        </button>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    open: sidebarOpen,
    setOpen: setSidebarOpen,
    toggle: toggleSidebar,
  } = useSidebar();
  const { href: modeHref } = useAdminMode();

  // 관리자 정보 + 로그아웃은 상단 Header 우측으로 이동했다 (components/admin/Header.tsx).

  // /admin HOME 화면에서는 메뉴 UI 는 보이되 클릭/이동을 막는다.
  // (다른 하위 페이지에서는 기존대로 동작, 사이드바 접기/펼치기는 항상 가능)
  const navLocked = pathname === "/admin";

  // 조직 컨텍스트(orgFocus) — 어드민 org 컨텍스트 단일 출처(resolveAdminOrgFocus):
  //   1) /admin/crews/{org} (크루 목록은 path 기반 — 기존 진입 정책 유지, path 우선)
  //   2) 그 외 공유 페이지는 ?org={slug}
  // 둘 다 없으면 null = 통합 모드(통합 검수 시스템). 링크 이동 시 컨텍스트 전달(buildAdminContextHref)과
  //   동일한 SoT 를 사용해 "상세로 이동하면 [통합]으로 새는" 유형의 불일치를 원천 차단한다.
  const orgFocus = resolveAdminOrgFocus(pathname, searchParams);

  // 현재 환경(통합 vs 개별+조직) 테마 — 배지 색·선택 메뉴 강조색의 단일 SoT.
  //   입력은 orgFocus 하나(통합=null / 개별=slug). mode(운영/test)·조직명 하드코딩 비교 없음.
  const envTheme = adminEnvironmentTheme(orgFocus);
  // 선택된(aria-current) 메뉴에 입힐 현재 환경 대표색(배경/글자/hover) — leaf·child 공용.
  const activeMenuClass = cn(
    envTheme.activeMenuClassName,
    envTheme.activeMenuHoverClassName,
  );

  // 대분류(leaf/branch) 노출 분기: integratedOnly=통합 모드만, orgOnly=조직 모드만.
  const isItemVisible = (item: MenuItem) => {
    if (item.integratedOnly && orgFocus) return false;
    if (item.orgOnly && !orgFocus) return false;
    return true;
  };

  // - integratedOnly: 통합 모드에서만 노출 (조직 모드에서 숨김)
  // - orgOnly: 조직 모드에서만 노출 (통합 모드에서 숨김 — 조직별 크루 목록 등)
  // - org 를 path 로 인코딩하는 자식(크루 목록 /admin/crews/{org}, 팀 내역 상세
  //   /admin/team-parts/info/{org})은 현재 조직 것만 노출 (기존 진입 정책 유지)
  const visibleChildren = (item: BranchItem) =>
    item.children.filter((child) => {
      if (child.integratedOnly && orgFocus) return false;
      if (child.orgOnly && !orgFocus) return false;
      const scopedOrg = orgScopedChildOrg(child.href);
      if (scopedOrg) return scopedOrg === orgFocus;
      return true;
    });

  // 노출 메뉴 트리: 조직 분기 모드면 신규 5대분류, 통합 모드면 기존(원본) 메뉴.
  const menu = orgFocus ? MENU_ORG : MENU_INTEGRATED;

  // 한 경로가 여러 branch 의 matchPaths(접두)에 동시에 걸릴 때 가장 구체적인(최장 일치) branch
  //   하나만 활성 표시한다. 예: /admin/team-parts/info/weeks 는 "클럽 정보"(/admin/team-parts)와
  //   "클럽 진행"(/admin/team-parts/info/weeks) 양쪽에 걸리지만 후자만 하이라이트한다(이중 강조 방지).
  const activeBranchBasePath = (() => {
    let best: string | null = null;
    let bestLen = -1;
    for (const item of menu) {
      if (item.kind !== "branch" || !isItemVisible(item)) continue;
      const paths = item.matchPaths ?? [item.basePath];
      for (const p of paths) {
        if (isUnderBase(pathname, p) && p.length > bestLen) {
          best = item.basePath;
          bestLen = p.length;
        }
      }
    }
    return best;
  })();

  // 조직 모드에서 공유 페이지 링크에 ?org 를 부착(조직 컨텍스트 유지).
  //   - /admin/crews/{org}: path 기반 → 그대로(부착 안 함)
  //   - 그 외: orgHref 로 ?org 부착 (통합 모드면 orgFocus=null → 원본 그대로 = ?org 없음)
  const childHref = (child: ChildItem) => {
    if (/^\/admin\/crews\/[^/]+$/.test(child.href)) return modeHref(child.href);
    return modeHref(orgHref(child.href, orgFocus));
  };

  // 기본값: 모든 대분류의 하위 메뉴를 펼친 상태로 시작한다(최초 진입/새로고침 공통).
  //   · 여기서 명시적으로 열어두고, 아래 branchOpen 도 미설정 시 `?? true` 로 폴백한다.
  //   · mode(test/일반)·org 분기와 무관 — 노출 조건(isItemVisible/visibleChildren)은 그대로.
  //   · 사용자가 직접 접으면 openBranches[basePath]=false 로 기록되어 그 상태가 유지된다.
  const [openBranches, setOpenBranches] = useState<Record<string, boolean>>(
    () => {
      const init: Record<string, boolean> = {};
      for (const item of menu) {
        if (item.kind === "branch") {
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
        // sticky+h-screen: 페이지 콘텐츠가 길어 문서 전체가 스크롤돼도 사이드바는
        // 뷰포트에 고정 (메뉴는 nav 내부 스크롤).
        "sticky top-0 h-screen flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
      )}
      // 폭은 공용 CSS 변수(단일 SoT)에서 가져온다 — 하단 ToastViewport 도 같은 변수로
      // 콘텐츠 영역 좌측 시작점을 계산한다(사이드바 폭 하드코딩 중복 제거).
      style={{
        width: sidebarOpen
          ? "var(--admin-sidebar-width-open)"
          : "var(--admin-sidebar-width-collapsed)",
      }}
    >
      <div
        className={cn(
          // h-32: 우측 Header 와 동일 높이(기준=Header). HOME 영역이 Header 높이에 맞춰 늘어나
          // 상단 바가 좌우 하나로 정렬된다.
          "flex h-32 shrink-0 items-center border-b border-sidebar-border",
          sidebarOpen ? "justify-between px-4" : "justify-center px-0",
        )}
      >
        {sidebarOpen && (
          // HOME 라벨 = /admin 홈 링크. /admin(HOME)에서는 navLocked 로 다른 메뉴와 동일하게 이동 차단.
          // HOME 우측 배지 = 현재 렌더 중인 사이드바 모드. orgFocus(사이드바 선택 SoT)를 그대로 사용
          //   → 조직 분기 사이드바(MENU_ORG)면 [개별], 통합 검수 시스템(MENU_INTEGRATED)이면 [통합].
          //   (URL 문자열/ mode=test 와 무관 — menu 를 결정하는 값과 동일 출처)
          <div className="flex items-center gap-2">
            <Link
              href={modeHref("/admin")}
              aria-disabled={navLocked || undefined}
              tabIndex={navLocked ? -1 : undefined}
              onClick={(e) => {
                if (navLocked) e.preventDefault();
              }}
              className={cn(
                "rounded-md text-xs font-semibold tracking-[0.02em] text-sidebar-foreground transition-colors hover:text-sidebar-accent-foreground",
                navLocked && "pointer-events-none",
              )}
            >
              HOME
            </Link>
            {/* HOME 화면(/admin)에서는 배지를 숨기고 HOME 만 노출. */}
            {!navLocked && (
              <span
                className={cn(
                  "rounded-md px-2.5 py-0.5 text-sm font-semibold",
                  // 배지 색/라벨은 현재 환경 테마(단일 SoT)에서:
                  //   개별 = 회색 [개별], 통합 검수 시스템 = 보라 [통합](빨강→보라, 2026-07-24).
                  envTheme.badgeClassName,
                )}
              >
                {envTheme.badgeLabel}
              </span>
            )}
          </div>
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

      {/* 조직 환경 배너 — HOME/개별 헤더 박스 "바로 아래" 사이드바 폭을 꽉 채우는 평평한 색 띠.
          지금 어떤 조직에서 작업 중인지를 조직 대표색 배경으로 견고하게(둥근모서리/여백 없이 edge-to-edge)
          상시 표시한다. 접힘(!sidebarOpen)=아이콘만, 펼침=아이콘+"{한글} / {영문}". 통합/미상 org·
          /admin 런처면 스스로 null 렌더한다(그 경우 이 슬롯은 사라지고 nav 가 헤더 박스에 바로 붙는다). */}
      <OrgEnvironmentBanner collapsed={!sidebarOpen} />

      <nav
        className={cn(
          "flex flex-1 flex-col overflow-y-auto",
          sidebarOpen ? "gap-0.5 p-2.5" : "gap-1 p-2",
        )}
      >
        {menu.filter(isItemVisible).map((item) => {
          if (item.kind === "leaf") {
            const Icon = item.icon;
            const active = isLeafActive(pathname, item.href);
            // 대시보드(alwaysEnabled)는 HOME에서도 클릭/이동 가능 — navLocked 예외.
            const leafLocked = navLocked && !item.alwaysEnabled;
            return (
              <Link
                key={item.href}
                href={modeHref(item.href)}
                title={!sidebarOpen ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                aria-disabled={leafLocked || undefined}
                tabIndex={leafLocked ? -1 : undefined}
                onClick={(e) => {
                  if (leafLocked) e.preventDefault();
                }}
                className={cn(
                  "group/leaf relative flex items-center rounded-md text-sm transition-colors",
                  sidebarOpen
                    ? "gap-2 px-3 py-1.5"
                    : "h-9 w-9 justify-center self-center",
                  active
                    ? activeMenuClass
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                  leafLocked && "pointer-events-none",
                )}
              >
                <Icon className={cn("h-4 w-4 shrink-0", !active && "text-sidebar-foreground/55 group-hover/leaf:text-sidebar-accent-foreground")} />
                {sidebarOpen && <span className="truncate">{item.label}</span>}
              </Link>
            );
          }

          const Icon = item.icon;
          // 최장 일치 branch 하나만 활성(활성 branch basePath 와 동일할 때만). isUnderAnyBase 접두
          //   매칭이 겹치는 weeks 경로에서 "클럽 정보"·"클럽 진행" 이중 강조되는 것을 막는다.
          const inSection = item.basePath === activeBranchBasePath;
          // 기본 펼침: 미설정(신규 노출된 분기 등)은 열림으로 폴백한다.
          //   사용자가 접으면 false 가 기록되어 그 값이 우선한다.
          const branchOpen = openBranches[item.basePath] ?? true;

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
                    // 준비 중(disabled) 메뉴 — 대응 페이지가 없어 링크가 아닌 비활성 span 으로 렌더.
                    //   이동/포커스 불가 + "준비 중" 배지. 임의 페이지를 만들지 않고 메뉴명만 노출한다.
                    if (child.disabled) {
                      return (
                        <li key={child.href}>
                          <span
                            aria-disabled="true"
                            title="준비 중"
                            className="flex cursor-not-allowed items-center justify-between gap-1.5 rounded-md px-2.5 py-1 text-xs text-sidebar-foreground/40"
                          >
                            <span className="truncate">{child.label}</span>
                            <span className="shrink-0 rounded bg-sidebar-accent/60 px-1 py-px text-[0.625rem] font-medium text-sidebar-foreground/50">
                              준비 중
                            </span>
                          </span>
                        </li>
                      );
                    }
                    const childActive = child.matchPaths
                      ? child.matchPaths.some((p) => isUnderBase(pathname, p))
                      : child.exact
                        ? pathname === child.href
                        : isLeafActive(pathname, child.href);
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
                            "block rounded-md px-2.5 py-1 text-xs transition-colors",
                            childActive
                              ? activeMenuClass
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

      {/* 설정 영역 — 네비게이션과 분리된 사이드바 최하단(테마 전환). */}
      <ThemeSettings collapsed={!sidebarOpen} />
    </aside>
  );
}


