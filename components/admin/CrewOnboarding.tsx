"use client";

import { usePathname, useSearchParams } from "next/navigation";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { buildCrewOnboardingTabs } from "@/lib/adminHeaderTabs";
import ApplicantsList from "@/components/admin/ApplicantsList";
import AppUsersList from "@/components/admin/AppUsersList";
import { readScopeMode } from "@/lib/userScopeShared";

// 크루 온보딩 메인(/admin/users/applicants) — 신규 가입 승인과 가입된 사용자 소속 배정을
// 한 페이지의 2개 탭으로 묶는다. 본문은 기존 컴포넌트를 그대로 재사용한다(복붙 없음):
//   · 가입 대기자(기본)      → ApplicantsList (pending 신청 승인/거절, /api/admin/applicants)
//   · 가입된 사용자(?tab=…) → AppUsersList   (organization_slug 배정, /api/admin/app-users)
// 탭은 글로벌 ?tab 으로 구동되며(members 페이지와 동일 규칙), 활성 탭만 렌더되어
// 비활성 컴포넌트는 fetch 하지 않는다.
type OnboardingTab = "applicants" | "app-users";

export default function CrewOnboarding() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab: OnboardingTab =
    searchParams?.get("tab") === "app-users" ? "app-users" : "applicants";
  const mode = readScopeMode(searchParams);

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="크루 온보딩"
        description="신규 가입 신청 승인과 가입된 사용자의 소속(조직) 배정을 관리합니다."
        tabs={buildCrewOnboardingTabs(pathname, searchParams, tab)}
      />

      {tab === "app-users" ? (
        <AppUsersList mode={mode} />
      ) : (
        <ApplicantsList mode={mode} />
      )}
    </div>
  );
}
