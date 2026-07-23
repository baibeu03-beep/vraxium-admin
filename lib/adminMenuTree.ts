// 어드민 사이드바 메뉴 트리 SoT — 사이드바(components/admin/Sidebar.tsx)와 전역 헤더 경로 표시
// (components/admin/Header.tsx)가 **동일한 한글 메뉴명**을 공유하도록 이 파일 한 곳에 모은다.
//
// 여기서 export 하는 MENU_INTEGRATED/MENU_ORG 는 사이드바가 그대로 렌더에 사용하고,
// resolveAdminBreadcrumb() 는 pathname → 한글 경로 배열(string[])로 변환한다. 표시 구분자(">")는
// SoT 가 아니라 헤더 렌더러(components/admin/Header.tsx)에서 항목 사이에 넣는다.
// 헤더 경로 표시는 org/mode(?org·mode=test·actAsTestUserId·demoUserId) 쿼리와 무관하게
// pathname 만으로 결정된다 — 같은 pathname 은 언제나 같은 한글 경로.

import {
  Briefcase,
  CalendarDays,
  LayoutDashboard,
  Network,
  TrendingUp,
  UserPlus,
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { ORGANIZATIONS } from "@/lib/organizations";

// 통합/조직 모드 노출 분기 플래그. (대분류 leaf/branch + 중분류 child 공통)
//  - integratedOnly: 통합 검수 시스템(orgFocus 없음)에서만 노출
//  - orgOnly:        조직 모드(orgFocus 있음)에서만 노출
export type ScopeFlags = {
  integratedOnly?: boolean;
  orgOnly?: boolean;
};

export type LeafItem = ScopeFlags & {
  kind: "leaf";
  label: string;
  href: string;
  icon: LucideIcon;
  // /admin(HOME)에서도 클릭/이동을 허용한다(navLocked 예외). 대시보드 메뉴 전용.
  alwaysEnabled?: boolean;
};

export type ChildItem = ScopeFlags & {
  label: string;
  href: string;
  // 활성 판정용 추가 경로(선택). 하나의 메뉴가 여러 라우트를 묶을 때 사용
  //  (예: "라인 관리" = /admin/lines/register + /admin/lines/info). 없으면 href 로 판정.
  matchPaths?: string[];
  // 정확 일치만 활성으로 본다(하위 경로 제외). 예: "팀 관리"(/admin/team-parts/info)이
  //  "/admin/team-parts/info/weeks"(주차 활동(클럽))에서 같이 활성되지 않도록.
  exact?: boolean;
  // 대응 페이지가 아직 없는 "준비 중" 메뉴 — 사이드바가 링크가 아닌 비활성 span 으로 렌더한다.
  //  href 는 라우트가 아니라 안정적인 key 용 placeholder(실제 페이지 없음). 임의의 빈/리다이렉트
  //  페이지를 만들지 않고 메뉴명만 먼저 노출할 때 사용한다. breadcrumb 매칭에서도 제외된다.
  disabled?: boolean;
};

export type BranchItem = ScopeFlags & {
  kind: "branch";
  label: string;
  icon: LucideIcon;
  basePath: string;
  matchPaths?: string[];
  children: ChildItem[];
};

export type MenuItem = LeafItem | BranchItem;

// 모든 href 는 현재 실재하는 admin route 만 사용한다.
//
// 사이드바는 모드에 따라 **다른 메뉴 트리**를 노출한다(2026-06-08 정정):
//   - 통합 모드(통합 검수 시스템, orgFocus 없음)  = MENU_INTEGRATED (기존 8분류 — 원복).
//   - 조직 분기 모드(엥크레/오랑캐/팔랑크스)        = MENU_ORG (신규 5대분류).
// 통합 검수 시스템의 메뉴명/구조/라우팅/기능은 일절 바꾸지 않는다.

// ── 통합 검수 시스템(원본) — 기존 그대로 ──────────────────────────────────
export const MENU_INTEGRATED: MenuItem[] = [
  // 대시보드는 HOME(/admin)과 분리된 별도 빈 화면. HOME에서도 이동 가능하도록 navLocked 예외.
  { kind: "leaf", label: "대시보드", href: "/admin/dashboard", icon: LayoutDashboard, alwaysEnabled: true },
  {
    kind: "branch",
    label: "주차와 시즌",
    icon: CalendarDays,
    // [통합 2026-07-20] "기간 등록"(폼)과 "기간 정보"(구 /admin/season-weeks 목록)를 하나의
    //   "기간 관리" 페이지(/admin/periods/register)로 병합. 구 /admin/season-weeks 메뉴 항목 제거
    //   (라우트는 redirect 로 유지). basePath/matchPaths 에서 season-weeks 제거.
    basePath: "/admin/periods",
    matchPaths: [
      "/admin/periods",
      "/admin/week-recognitions",
      // [비활성화 2026-07-04] 주차 카드 집계 확정 페이지 비노출 — 재활성화 시 주석 해제.
      // "/admin/weekly-card-finalization",
    ],
    children: [
      { label: "기간 관리", href: "/admin/periods/register" },
      { label: "주차 인정 결과", href: "/admin/week-recognitions" },
      // [주차 카드 집계 확정] 메뉴 비노출(주석 처리) — /admin/weekly-card-finalization 라우트/컴포넌트는 유지.
      //   라우트도 page.tsx 에서 notFound() 처리됨. 재활성화하려면 아래 줄의 주석을 해제하세요.
      // { label: "주차 카드 집계 확정", href: "/admin/weekly-card-finalization" },
    ],
  },
  {
    kind: "branch",
    label: "허브와 라인",
    icon: Briefcase,
    basePath: "/admin/line-opening",
    matchPaths: ["/admin/lines", "/admin/line-opening", "/admin/career-projects"],
    children: [
      // 라인 등록/정보는 "라인 관리" 단일 메뉴로 통합(페이지 안에서 탭 전환).
      //   기본 진입 = 라인 등록. 두 라우트 모두 활성 하이라이트되도록 matchPaths 사용.
      {
        label: "라인 관리",
        href: "/admin/lines/register",
        matchPaths: ["/admin/lines"],
      },
      // [비활성화 2026-06-14] 개설 이력 페이지 임시 비활성화(복구 시 주석 해제).
      //   라우트도 page.tsx 에서 notFound() 처리됨.
      // { label: "개설 이력", href: "/admin/line-opening/line-history" },
      { label: "라인 개설 [실무 경력]", href: "/admin/line-opening/practical-career", disabled: true },
    ],
  },
  {
    kind: "branch",
    label: "허브별 프로세스",
    icon: Workflow,
    basePath: "/admin/processes",
    children: [
      { label: "프로세스 관리", href: "/admin/processes/register", matchPaths: ["/admin/processes/register", "/admin/processes/info"] },
      { label: "프로세스 체크 [실무 경력]", href: "/admin/processes/check", disabled: true },
    ],
  },
  {
    kind: "branch",
    label: "클럽 정보",
    icon: Network,
    basePath: "/admin/team-parts",
    children: [
      // [표시명 변경 2026-07-21] URL/라우트는 무변경 — 사이드바·헤더 표시 라벨만 변경.
      //   팀 내역→팀 관리 · 시즌 내역→시즌 관리 · 주차 내역→주차 활동(클럽).
      { label: "팀 관리", href: "/admin/team-parts/info", exact: true },
      { label: "시즌 관리", href: "/admin/team-parts/info/seasons", disabled: true },
      { label: "주차 활동(클럽)", href: "/admin/team-parts/info/weeks" },
      // [주차 결과(크루)] — 통합 목록(행=주차 · 열=클럽). 클럽 헤더 [상세] → /{organizationSlug}.
      //   기존 "주차와 시즌 > 주차 인정 결과"(/admin/week-recognitions)는 목적이 달라 재사용하지 않는다.
      //   ⚠ 상세 라우트는 추후 [개별] 어드민이 그대로 재사용한다(별도 페이지 신설 금지).
      { label: "주차 결과(크루)", href: "/admin/team-parts/info/crew-week-results" },
      // [팀 & 파트 등록] 메뉴 비노출(주석 처리) — /admin/team-parts/register 라우트/코드는 유지.
      //   재활성화하려면 아래 줄의 주석을 해제하세요.
      // { label: "팀 & 파트 등록", href: "/admin/team-parts/register" },
    ],
  },
  // [클럽 진행] 메뉴 비노출(주석 처리) — /admin/club-progress/* 라우트/코드는 유지.
  //   재활성화하려면 아래 블록의 주석을 해제하세요.
  // {
  //   kind: "branch",
  //   label: "클럽 진행",
  //   icon: TrendingUp,
  //   basePath: "/admin/club-progress",
  //   children: [
  //     { label: "주차 내역", href: "/admin/club-progress/weekly" },
  //     { label: "시즌 내역", href: "/admin/club-progress/seasons" },
  //   ],
  // },
  {
    kind: "branch",
    label: "크루 활동",
    icon: Users,
    basePath: "/admin/members",
    matchPaths: [
      "/admin/members",
      "/admin/rest-management",
      // 임시 비노출(페이지/API/로직 유지 — 메뉴만 숨김). 재활성화 시 아래 2줄 주석 해제.
      // "/admin/season-participations",
      // "/admin/official-rest-periods",
      "/admin/communications",
    ],
    children: [
      { label: "크루 관리", href: "/admin/members" },
      { label: "휴식 관리", href: "/admin/rest-management" },
      // 임시 비노출(페이지/API/로직 유지 — 메뉴만 숨김). 재활성화 시 아래 2줄 주석 해제.
      // { label: "시즌 참여/휴식", href: "/admin/season-participations" },
      // { label: "공식 휴식 관리", href: "/admin/official-rest-periods" },
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
    matchPaths: [
      "/admin/settings/accounts",
      "/admin/settings/edit-windows",
      "/admin/settings/line-opening-windows",
      "/admin/settings/process-check-windows",
      "/admin/settings/permissions",
      "/admin/operation-health-check",
      "/admin/test-users",
      "/admin/import",
    ],
    children: [
      { label: "어드민 계정", href: "/admin/settings/accounts" },
      { label: "작성 기간 관리", href: "/admin/settings/edit-windows" },
      { label: "라인 개설 기간", href: "/admin/settings/line-opening-windows" },
      { label: "프로세스 체크 예외 주차", href: "/admin/settings/process-check-windows" },
      { label: "권한 설정", href: "/admin/settings/permissions" },
      { label: "운영 정합성 점검", href: "/admin/operation-health-check" },
      { label: "테스트 모드", href: "/admin/test-users" },
      { label: "가져오기", href: "/admin/import" },
    ],
  },
];

// ── 조직 분기(엥크레/오랑캐/팔랑크스) — 신규 5대분류 ────────────────────────
// 조직 모드에서만 노출. 공유 페이지 링크는 ?org 가 부착되어 조직 컨텍스트가 유지된다.
export const MENU_ORG: MenuItem[] = [
  // 1) 라인 개설
  {
    kind: "branch",
    label: "라인 개설",
    icon: Briefcase,
    basePath: "/admin/line-opening",
    matchPaths: ["/admin/line-opening"],
    children: [
      { label: "실무 정보", href: "/admin/line-opening/practical-info" },
      { label: "실무 경험", href: "/admin/line-opening/practical-experience" },
      { label: "실무 역량", href: "/admin/line-opening/practical-competency" },
    ],
  },
  // 2) 프로세스 체크 — 기획 전 placeholder(라우트만).
  {
    kind: "branch",
    label: "프로세스 체크",
    icon: Workflow,
    basePath: "/admin/processes/check",
    children: [
      { label: "클럽 총괄 급", href: "/admin/processes/check/club" },
      { label: "실무 정보 급", href: "/admin/processes/check/info" },
      { label: "실무 경험 급", href: "/admin/processes/check/experience" },
      { label: "실무 역량 급", href: "/admin/processes/check/competency" },
      { label: "변동 액트", href: "/admin/processes/check/irregular" },
    ],
  },
  // 3) 클럽 진행 — 개별 조직 운영진의 팀·시즌·주차 진행 조회. 통합 목록(클럽 현황 표)에서 클럽명을
  //   눌러 들어가는 상세와 **동일한 상세 페이지/DTO** 를, 개별 페이지에서는 현재 조직(orgFocus) 것만
  //   바로 열도록 연결한다. 통합 어드민이 설정한 이번 주 활동 허브·라인·검수 상태는 "주차 내역"에서
  //   자기 조직(?org) 스코프 조회 전용으로 열람한다(설정 변경은 통합 전용·서버 403). 통합 트리
  //   (MENU_INTEGRATED)는 기존 "클럽 정보 > 팀/시즌/주차 내역" 을 그대로 유지한다.
  {
    kind: "branch",
    label: "클럽 진행",
    icon: TrendingUp,
    // /admin/team-parts/info 전체(팀 내역 상세 /{org}·시즌 /seasons·주차 /weeks)를 이 분기로 묶는다.
    basePath: "/admin/team-parts/info",
    matchPaths: ["/admin/team-parts/info"],
    children: [
      // 팀 내역 — 현재 조직 상세(/admin/team-parts/info/{org}). org 별 href 를 생성하고 사이드바가
      //   현재 orgFocus 것만 노출한다(크루 관리와 동일 패턴 — visibleChildren). path 로 org 를 결정하되
      //   ?org 도 함께 부착되어(Sidebar.childHref → orgHref) 상세 진입 후에도 [개별] 사이드바 컨텍스트가
      //   유지된다(상세 route 는 path 기반 resolveAdminOrgFocus 미인식). 통합 목록의 클럽명 클릭과 같은
      //   ClubTeamDetail 을 재사용한다(진입 위치별 별도 화면/API/DTO 없음).
      // [표시명 변경 2026-07-21] 통합 트리와 동일한 라벨을 공유한다(같은 페이지 = 같은 메뉴명,
      //   org/mode 로 이름이 갈라지지 않음). URL/라우트는 무변경.
      ...ORGANIZATIONS.map((slug) => ({
        label: "팀 관리",
        href: `/admin/team-parts/info/${slug}`,
        orgOnly: true,
      })),
      { label: "시즌 관리", href: "/admin/team-parts/info/seasons", disabled: true },
      { label: "주차 활동(클럽)", href: "/admin/team-parts/info/weeks" },
      // [주차 결과(크루)] 통합 트리와 동일 — 전용 페이지 부재로 disabled(준비 중).
      { label: "주차 결과(크루)", href: "/admin/team-parts/info/crew-week-results", disabled: true },
    ],
  },
  // 4) 크루 활동 — 크루 관리(해당 조직 목록), 휴식 관리, 커뮤니케이션.
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
    ],
    children: [
      // 현재 조직 크루 목록(path 기반 /admin/crews/{org}, 이미 서버 org 필터).
      ...ORGANIZATIONS.map((slug) => ({
        label: "크루 관리",
        href: `/admin/crews/${slug}`,
        orgOnly: true,
      })),
      { label: "휴식 관리", href: "/admin/rest-management" },
      { label: "커뮤니케이션", href: "/admin/communications", disabled: true },
    ],
  },
  // 5) 클럽 정보 — 카탈로그/정보 묶음. (팀 내역은 "클럽 진행"으로 이동 — 개별 페이지는 통합 목록이
  //   아니라 현재 조직 상세로 바로 진입한다. /admin/team-parts 경로 매칭도 "클럽 진행"이 전담하므로
  //   여기 matchPaths 에서 제거한다 — 이중 강조 방지.)
  {
    kind: "branch",
    label: "클럽 정보",
    icon: CalendarDays,
    // [통합 2026-07-20] 구 /admin/season-weeks(주차와 시즌 목록)는 "기간 관리"(/admin/periods/register)
    //   통합 페이지로 병합·redirect. 조직 모드 메뉴도 통합 페이지를 가리키도록 정정(라벨/href).
    basePath: "/admin/periods",
    matchPaths: [
      "/admin/periods",
      "/admin/lines/info",
      "/admin/processes/info",
    ],
    children: [
      // 기간 관리는 클럽 전역 데이터(org 컬럼 없음 → 데이터는 전체). ?org 는 사이드바 컨텍스트 유지용.
      { label: "기간 관리", href: "/admin/periods/register" },
      { label: "허브와 라인", href: "/admin/lines/info", disabled: true },
      { label: "허브별 프로세스 목록", href: "/admin/processes/info", disabled: true },
    ],
  },
];

export function isLeafActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(href + "/");
}

export function isUnderBase(pathname: string, basePath: string) {
  return pathname === basePath || pathname.startsWith(basePath + "/");
}

// ── 전역 헤더 경로 표시용 resolver ──────────────────────────────────────────
// pathname → 한글 breadcrumb parts(["상위 메뉴", "현재 페이지"]). 표시 전용.
// org/mode 쿼리와 무관(pathname 만 사용). ID/UUID/slug 원문은 절대 노출하지 않는다.

// 브레드크럼 1항목 — 한글 라벨 + (선택) 이동 href. 마지막(현재 페이지) 항목은 Header 가 링크로
//   만들지 않고 강조만 한다. 중간 항목은 href 가 있으면 Header 가 링크로 렌더한다(관리자 전역 공통
//   UX — 이 페이지만의 예외 없음). href 는 컨텍스트(?org·mode 등) 미포함 순수 경로 — Header 가
//   buildAdminContextHref 로 진입 컨텍스트를 얹어 준다(org/mode/test/demo 보존).
export type AdminBreadcrumbItem = { label: string; href?: string };

// override.parts 는 정적 배열 또는 "매칭된 path 로 href 를 계산하는 함수"(크루 상세처럼 org 를 path
//   에서 뽑아야 하는 경우)일 수 있다.
type OverrideParts = AdminBreadcrumbItem[] | ((path: string) => AdminBreadcrumbItem[]);

// 동적/상세 라우트 override — 사이드바 메뉴에 없는 상세 페이지를 안정적인 한글명으로 매핑한다.
//   구조적 매칭보다 먼저 검사한다(상세 명칭 우선). 상위 계층은 사이드바 라벨을 그대로 재사용.
const BREADCRUMB_OVERRIDES: { test: RegExp; parts: OverrideParts }[] = [
  { test: /^\/admin\/?$/, parts: [{ label: "관리자 홈" }] },
  // 회원(크루) 상세 — /admin/members/{userId}[/weeks/{weekId}|/weekly-status]
  //   주차 상세: 회원명·주차명 두 동적 세그먼트는 페이지가 provider(AdminDetailTitle items)로
  //   실제 표시명 + 회원 상세 href 를 공급해 마지막 2칸을 교체한다(여기선 placeholder + 상위 href).
  {
    test: /^\/admin\/members\/[^/]+\/weeks\/[^/]+\/?$/,
    parts: [
      { label: "크루 활동", href: "/admin/members" },
      { label: "크루 관리", href: "/admin/members" },
      { label: "회원 상세" },
      { label: "주차 상세" },
    ],
  },
  {
    test: /^\/admin\/members\/[^/]+\/weekly-status\/?$/,
    parts: [
      { label: "크루 활동", href: "/admin/members" },
      { label: "크루 관리", href: "/admin/members" },
      { label: "주차 현황" },
    ],
  },
  {
    test: /^\/admin\/members\/[^/]+\/?$/,
    parts: [
      { label: "크루 활동", href: "/admin/members" },
      { label: "크루 관리", href: "/admin/members" },
      { label: "회원 상세" },
    ],
  },
  // 조직 크루 목록/상세 — /admin/crews/{org}[/{userId}[/cluster*]]. "크루 관리"는 org 목록(path 기반).
  {
    test: /^\/admin\/crews\/[^/]+\/[^/]+(\/[^/]+)?\/?$/,
    parts: (p) => {
      const org = p.match(/^\/admin\/crews\/([^/]+)/)?.[1] ?? null;
      const listHref = org ? `/admin/crews/${org}` : "/admin/members";
      return [
        { label: "크루 활동", href: listHref },
        { label: "크루 관리", href: listHref },
        { label: "크루 상세" },
      ];
    },
  },
  {
    test: /^\/admin\/crews(\/[^/]+)?\/?$/,
    parts: (p) => {
      const org = p.match(/^\/admin\/crews\/([^/]+)/)?.[1] ?? null;
      const listHref = org ? `/admin/crews/${org}` : "/admin/members";
      return [{ label: "크루 활동", href: listHref }, { label: "크루 관리" }];
    },
  },
  // 주차 결과(크루) 주차 세부 — /admin/team-parts/info/crew-week-results/{organizationSlug}/{weekId}
  //   끝 2칸(클럽명·주차명)은 페이지가 AdminDetailTitle items 로 실제 표시명 + 클럽 상세 href 를 공급.
  //   ⚠ 클럽 상세(1세그먼트)보다 **먼저** 와야 한다(2세그먼트가 1세그먼트 규칙에 먹히지 않도록).
  {
    test: /^\/admin\/team-parts\/info\/crew-week-results\/[^/]+\/[^/]+\/?$/,
    parts: [
      { label: "클럽 정보", href: "/admin/team-parts/info" },
      { label: "주차 결과(크루)", href: "/admin/team-parts/info/crew-week-results" },
      { label: "클럽 상세" },
      { label: "주차 상세" },
    ],
  },
  // 주차 결과(크루) 클럽 상세 — /admin/team-parts/info/crew-week-results/{organizationSlug}
  //   마지막 칸(클럽명)은 페이지가 AdminDetailTitle 로 실제 표시명을 공급해 교체한다
  //   (여기선 slug 를 절대 노출하지 않는 placeholder). weeks 규칙보다 먼저 둘 필요는 없지만
  //   동일 접두(team-parts/info)라 override 목록 안에서 함께 관리한다.
  {
    test: /^\/admin\/team-parts\/info\/crew-week-results\/[^/]+\/?$/,
    parts: [
      { label: "클럽 정보", href: "/admin/team-parts/info" },
      { label: "주차 결과(크루)", href: "/admin/team-parts/info/crew-week-results" },
      { label: "클럽 상세" },
    ],
  },
  // 주차 상세 — /admin/team-parts/info/weeks/{weekId}
  {
    test: /^\/admin\/team-parts\/info\/weeks\/[^/]+\/?$/,
    parts: [
      { label: "클럽 정보", href: "/admin/team-parts/info" },
      { label: "주차 활동(클럽)", href: "/admin/team-parts/info/weeks" },
      { label: "주차 상세" },
    ],
  },
  // 클럽 상세 — /admin/team-parts/info/{clubId} (clubId=org slug).
  //   weeks/seasons/crew-week-results 는 제외(별도 라우트) — negative-lookahead 에 반드시 추가할 것.
  //   ⚠ 누락하면 그 라우트의 목록 페이지가 "클럽 정보 > 팀 관리 > 클럽"으로 잘못 표시된다(실측 회귀).
  //   3단계: 클럽 정보 > 팀 내역 > 클럽. 클럽 정보·팀 내역은 별도 인덱스 라우트가 없어 둘 다 팀 내역
  //   목록(/admin/team-parts/info)으로 이동한다. 마지막 칸("클럽")은 페이지가 AdminDetailTitle 로 실제
  //   클럽명으로 교체한다(slug 미노출).
  {
    test: /^\/admin\/team-parts\/info\/(?!weeks(?:\/|$)|seasons(?:\/|$)|crew-week-results(?:\/|$))[^/]+\/?$/,
    parts: [
      { label: "클럽 정보", href: "/admin/team-parts/info" },
      { label: "팀 관리", href: "/admin/team-parts/info" },
      { label: "클럽" },
    ],
  },
  // 팀 상세 — /admin/team-parts/info/{clubId}/{teamHalfId}. 4단계: 클럽 정보 > 팀 내역 > 클럽 > 팀.
  //   마지막 2칸(클럽·팀)은 페이지가 AdminDetailTitle items 로 실제 클럽명·팀명(+클럽 href)으로 교체한다.
  //   weeks/seasons/crew-week-results 는 자체 라우트라 제외(negative-lookahead). 두 세그먼트라
  //   클럽 상세(1세그먼트)와 구분됨.
  {
    test: /^\/admin\/team-parts\/info\/(?!weeks(?:\/|$)|seasons(?:\/|$)|crew-week-results(?:\/|$))[^/]+\/[^/]+\/?$/,
    parts: [
      { label: "클럽 정보", href: "/admin/team-parts/info" },
      { label: "팀 관리", href: "/admin/team-parts/info" },
      { label: "클럽" },
      { label: "팀" },
    ],
  },
  // 라인 관리(등록/정보 탭 공용) — 통합 사이드바 정본 라벨로 고정(두 트리 중복 경로 정본화).
  {
    test: /^\/admin\/lines(\/.*)?$/,
    parts: [
      { label: "허브와 라인", href: "/admin/line-opening" },
      { label: "라인 관리", href: "/admin/lines/register" },
    ],
  },
  // 크루 온보딩 탭들(가입 대기자/가입된 사용자/어드민 사용자) — 모두 "크루 등록" 하위.
  {
    test: /^\/admin\/(users(\/[^/]+)?|applicants)\/?$/,
    parts: [
      { label: "크루 온보딩", href: "/admin/users/applicants" },
      { label: "크루 등록", href: "/admin/users/applicants" },
    ],
  },
];

// 사이드바 메뉴에 없는 마지막 세그먼트를 안전한 한글명으로 매핑(비노출/레거시 라우트 대비).
const SEGMENT_FALLBACK_LABELS: Record<string, string> = {
  "weekly-card-finalization": "주차 카드 집계 확정",
  "season-participations": "시즌 참여/휴식",
  "official-rest-periods": "공식 휴식 관리",
  "line-history": "개설 이력",
  "career-projects": "경력 프로젝트",
};

// 후보 경로들 중 pathname 에 매칭되는 최장 접두 길이(없으면 -1). exactHref 지정 시 정확 일치만.
function matchLength(pathname: string, paths: string[], exactHref: string | null): number {
  if (exactHref) return pathname === exactHref ? exactHref.length : -1;
  let best = -1;
  for (const p of paths) {
    if (pathname === p || pathname.startsWith(p + "/")) best = Math.max(best, p.length);
  }
  return best;
}

/**
 * pathname 을 한글 경로 parts 로 변환한다("상위 메뉴 - 현재 페이지").
 * 우선순위: 1) 동적/상세 override → 2) 메뉴 트리 최장 일치(통합·조직 공통) → 3) 세그먼트 폴백 → 4) "관리자 페이지".
 * org/mode 쿼리는 관여하지 않는다(같은 pathname = 같은 결과). ID/UUID/slug 는 노출하지 않는다.
 */
export function resolveAdminBreadcrumb(pathname: string): AdminBreadcrumbItem[] {
  const path = pathname.replace(/\/+$/, "") || "/admin";

  // 1) 동적/상세 override 우선.
  for (const o of BREADCRUMB_OVERRIDES) {
    if (o.test.test(pathname) || o.test.test(path)) {
      return typeof o.parts === "function" ? o.parts(path) : o.parts;
    }
  }

  // 2) 메뉴 트리 최장 일치(통합→조직 순, 길이 동률이면 통합 우선).
  //   중간(그룹/부모) 항목의 href = 그 그룹의 첫 자식 href(항상 실재 라우트). 리프/자식은 자기 href.
  let best: AdminBreadcrumbItem[] | null = null;
  let bestLen = -1;
  const consider = (parts: AdminBreadcrumbItem[], len: number) => {
    if (len > bestLen) {
      best = parts;
      bestLen = len;
    }
  };
  for (const tree of [MENU_INTEGRATED, MENU_ORG]) {
    for (const item of tree) {
      if (item.kind === "leaf") {
        const len = matchLength(path, [item.href], null);
        if (len >= 0) consider([{ label: item.label, href: item.href }], len);
        continue;
      }
      // 그룹(부모) href = 첫 자식 href(basePath 는 실 페이지가 아닐 수 있어 회피).
      const groupHref = item.children.find((c) => !c.disabled)?.href ?? item.basePath;
      for (const child of item.children) {
        // 준비 중(disabled) 메뉴는 대응 라우트가 없으므로 경로 매칭에서 제외한다.
        if (child.disabled) continue;
        const paths = child.matchPaths ?? [child.href];
        const exactHref = child.exact && !child.matchPaths ? child.href : null;
        const len = matchLength(path, paths, exactHref);
        if (len >= 0) {
          consider(
            [
              { label: item.label, href: groupHref },
              { label: child.label, href: child.href },
            ],
            len,
          );
        }
      }
      // child 매칭이 없을 때를 대비한 branch 자체 매칭(하위 계층 미상 → 상위 메뉴만).
      const branchLen = matchLength(path, item.matchPaths ?? [item.basePath], null);
      if (branchLen >= 0) consider([{ label: item.label, href: groupHref }], branchLen);
    }
  }
  if (best) return best;

  // 3) 세그먼트 폴백 — 마지막 세그먼트가 알려진 라벨이면 사용(동적 ID/slug 는 매핑 없음 → 스킵).
  const segs = path.split("/").filter(Boolean); // ["admin", ...]
  for (let i = segs.length - 1; i >= 1; i--) {
    const label = SEGMENT_FALLBACK_LABELS[segs[i]];
    if (label) return [{ label }];
  }

  // 4) 최종 폴백.
  return [{ label: "관리자 페이지" }];
}
