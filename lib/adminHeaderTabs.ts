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

// 크루 온보딩(/admin/users/applicants) 공통 2탭:
//   가입 대기자(기본, applicants 승인/거절) / 가입된 사용자(?tab=app-users, 소속 배정).
export function buildCrewOnboardingTabs(
  pathname: string,
  searchParams: SearchParamsLike,
  current: "applicants" | "app-users",
): AdminPageHeaderTab[] {
  return [
    {
      label: "가입 대기자",
      href: tabHref(pathname, searchParams, "tab", "app-users", true),
      active: current === "applicants",
    },
    {
      label: "가입된 사용자",
      href: tabHref(pathname, searchParams, "tab", "app-users", false),
      active: current === "app-users",
    },
  ];
}

// 라인 관리(/admin/lines/*) 공통 2탭: 라인 정보 / 라인 등록.
//   - 탭 기본값은 "경로 기반"(LineManagement): /admin/lines/register→등록, /admin/lines/info→정보.
//   - 따라서 두 탭 모두 ?tab 을 "명시적으로" 설정한다(정보=tab=info · 등록=tab=register). 정보 탭을
//     ?tab 삭제(default)로 두면 /register 경로에서 다시 등록 탭으로 판정돼 클릭이 먹지 않는다.
//   - 현재 경로(pathname)를 유지한 채 ?tab 만 토글 → org 등 다른 쿼리도 보존된다.
export function buildLineManageTabs(
  pathname: string,
  searchParams: SearchParamsLike,
  current: "info" | "register",
): AdminPageHeaderTab[] {
  return [
    {
      label: "라인 정보",
      // org·mode 등 현재 쿼리를 그대로 보존하고 ?tab=info 만 토글한다(통합↔조직 상태 불변).
      //   org 없음 = 통합 컨텍스트 유지(기본 org 를 새로 붙이지 않는다) · org 있음 = 그 org 보존.
      href: tabHref(pathname, searchParams, "tab", "info", false),
      active: current === "info",
    },
    {
      label: "라인 등록",
      href: tabHref(pathname, searchParams, "tab", "register", false),
      active: current === "register",
    },
  ];
}

// 조직 크루(/admin/crews/{org}) 공통 2탭: 크루 목록(기본) / 크루 관리(?tab=manage).
//   멤버 관리(/admin/members)와 동일한 UI 를 조직 스코프로 재사용한다:
//     · 크루 목록 = MembersList 목록(org 고정, 클럽 드롭다운 없음)
//     · 크루 관리 = 크루 정보(집계/통계) 뷰(MembersInfoTab)를 현재 org 로 스코프
//   org 는 path 로 고정되므로 tabHref 가 pathname 유지 + ?tab 만 토글 → org·mode 보존.
export function buildCrewsTabs(
  pathname: string,
  searchParams: SearchParamsLike,
  current: "list" | "manage",
): AdminPageHeaderTab[] {
  return [
    {
      label: "크루 목록",
      href: tabHref(pathname, searchParams, "tab", "manage", true),
      active: current === "list",
    },
    {
      label: "크루 관리",
      href: tabHref(pathname, searchParams, "tab", "manage", false),
      active: current === "manage",
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
