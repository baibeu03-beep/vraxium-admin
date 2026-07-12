"use client";

// 관리자별 "허용 조직" 클라이언트 컨텍스트.
//
// 서버 SoT(lib/adminOrgAccess.resolveAdminOrgAccess)의 결과를 portal layout 이 서버에서
// 계산해 이 Provider 로 주입한다 → 클라이언트는 추가 fetch/로딩 없이 동일 값을 소비한다.
// (isSuperAdmin 을 DTO 로 내려 클라가 컨트롤을 제한하는 기존 패턴과 동일한 방향.)
//
// 세 페이지(휴식 관리 · 라인 정보 · 팀/파트 정보)가 조직 탭/필터를 이 컨텍스트로 필터링하고,
// useGatedOrg 로 URL 의 ?org 를 허용 조직으로 교정한다. 서버 API 는 별도로 assertAdminOrgAccess
// 로 재검증하므로 이 컨텍스트는 UI 게이트(방어의 한 겹)일 뿐 유일한 방어선이 아니다.

import { createContext, useContext, useEffect, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { orgHref } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import type { OrganizationSlug } from "@/lib/organizations";

export type AdminOrgAccessValue = {
  allowedOrgs: OrganizationSlug[];
  isAllOrgs: boolean;
};

const AdminOrgAccessContext = createContext<AdminOrgAccessValue>({
  allowedOrgs: [],
  isAllOrgs: false,
});

export function AdminOrgAccessProvider({
  value,
  children,
}: {
  value: AdminOrgAccessValue;
  children: React.ReactNode;
}) {
  // value 는 서버가 매 렌더 새 객체로 주므로, 참조 안정화(불필요 리렌더 방지)한다.
  const stable = useMemo<AdminOrgAccessValue>(
    () => ({ allowedOrgs: value.allowedOrgs, isAllOrgs: value.isAllOrgs }),
    [value.allowedOrgs, value.isAllOrgs],
  );
  return (
    <AdminOrgAccessContext.Provider value={stable}>
      {children}
    </AdminOrgAccessContext.Provider>
  );
}

export function useAdminOrgAccess(): AdminOrgAccessValue {
  return useContext(AdminOrgAccessContext);
}

export type GatedOrgResult = {
  allowedOrgs: OrganizationSlug[];
  isAllOrgs: boolean;
  // 실제 사용할 org. 허용되지 않은 ?org 이거나 교정 대기 중이면 null.
  org: OrganizationSlug | null;
  // 허용 조직이 하나도 없음(권한 없음 상태) — 데이터 조회를 하지 말 것.
  noAccess: boolean;
};

// ?org 를 허용 조직으로 교정하는 공통 훅.
//   - 허용 org 없음                → noAccess=true (리다이렉트 안 함, 조회 금지)
//   - ?org 가 허용되지 않음        → 허용 목록의 첫 org 로 replace 교정
//   - ?org 없음 + 단일 허용 org    → (autoSelectSingle) 그 org 로 replace 자동 선택
// 교정 링크는 현재 mode(?mode=test)와 pathname 을 보존한다.
export function useGatedOrg(opts: {
  org: OrganizationSlug | null;
  autoSelectSingle?: boolean;
}): GatedOrgResult {
  const { org, autoSelectSingle = false } = opts;
  const { allowedOrgs, isAllOrgs } = useAdminOrgAccess();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);

  const noAccess = allowedOrgs.length === 0;
  const orgAllowed = org != null && allowedOrgs.includes(org);
  const effectiveOrg = orgAllowed ? org : null;

  // 교정 대상 org 계산(렌더 중 side-effect 금지 → effect 에서 replace).
  const redirectTo = useMemo<OrganizationSlug | null>(() => {
    if (noAccess) return null;
    if (org != null && !allowedOrgs.includes(org)) {
      return allowedOrgs[0] ?? null; // 허용되지 않은 ?org → 첫 허용 org
    }
    if (org == null && autoSelectSingle && allowedOrgs.length === 1) {
      return allowedOrgs[0]; // 단일 허용 org 자동 선택
    }
    return null;
  }, [noAccess, org, allowedOrgs, autoSelectSingle]);

  useEffect(() => {
    if (!redirectTo || !pathname) return;
    const href = appendModeQuery(orgHref(pathname, redirectTo), mode);
    router.replace(href);
  }, [redirectTo, pathname, mode, router]);

  return { allowedOrgs, isAllOrgs, org: effectiveOrg, noAccess };
}

// 허용 조직이 하나도 없을 때(권한 없음) 공통 안내 카드. 데이터 조회/임의 org 접근을 하지 않는다.
export function AdminNoOrgAccess({
  title = "접근 권한 없음",
}: {
  title?: string;
}) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-1">
          현재 계정에 허용된 클럽이 없습니다. 클럽 접근이 필요하면 관리자에게 계정
          소속(클럽) 설정을 요청하세요.
        </p>
      </CardContent>
    </Card>
  );
}
