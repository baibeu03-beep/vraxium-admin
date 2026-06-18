import type { AdminPageHeaderTab } from "@/components/admin/AdminPageHeader";

// 어드민 상단 탭 href 빌더 — 기존 글로벌 Header.tsx 의 infoTabHref/membersTabHref 와
// byte-identical 한 규칙(현재 쿼리스트링 전체 보존 + ?tab 만 토글, 기본 탭은 ?tab 제거).
// org 등 다른 파라미터는 searchParams.toString() 으로 그대로 유지된다 — 라우팅/스코프 불변.

type SearchParamsLike = { toString(): string } | null | undefined;

function tabHref(
  pathname: string,
  searchParams: SearchParamsLike,
  param: string,
  value: string,
  isDefault: boolean,
): string {
  const params = new URLSearchParams(searchParams?.toString() ?? "");
  if (isDefault) params.delete(param);
  else params.set(param, value);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

// 라인 개설 페이지(실무 정보/경험/역량) 공통 2탭: 라인 관리(기본) / 라인 개설(?tab=open).
export function buildLineOpeningTabs(
  pathname: string,
  searchParams: SearchParamsLike,
  current: "manage" | "open",
): AdminPageHeaderTab[] {
  return [
    {
      label: "라인 관리",
      href: tabHref(pathname, searchParams, "tab", "open", true),
      active: current === "manage",
    },
    {
      label: "라인 개설",
      href: tabHref(pathname, searchParams, "tab", "open", false),
      active: current === "open",
    },
  ];
}

// 멤버 관리(/admin/members) 공통 2탭: 크루 목록(기본) / 크루 정보(?tab=info).
export function buildMembersTabs(
  pathname: string,
  searchParams: SearchParamsLike,
  current: "list" | "info",
): AdminPageHeaderTab[] {
  return [
    {
      label: "크루 목록",
      href: tabHref(pathname, searchParams, "tab", "info", true),
      active: current === "list",
    },
    {
      label: "크루 정보",
      href: tabHref(pathname, searchParams, "tab", "info", false),
      active: current === "info",
    },
  ];
}
