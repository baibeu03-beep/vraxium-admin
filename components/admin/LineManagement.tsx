"use client";

// 라인 관리 — "라인 정보" / "라인 등록" 두 화면을 상단 탭으로 묶는 래퍼.
//   - /admin/members 의 "크루 목록 / 크루 정보" 탭과 동일한 톤(AdminPageHeader + 탭).
//   - 탭 상태는 ?tab 로 구동된다: 기본(쿼리 없음)=라인 정보, ?tab=register=라인 등록.
//     → /admin/lines/register 로 들어와도 기본으로 "라인 정보" 탭이 먼저 보인다(2026-06-27).
//   - 기존 두 라우트(/admin/lines/register · /admin/lines/info)는 모두 이 래퍼를 렌더한다 → URL 불변.
//   - 본문은 기존 매니저 컴포넌트를 **그대로 재사용**한다(로직/저장/API 무변경).

import { usePathname, useSearchParams } from "next/navigation";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { buildLineManageTabs } from "@/lib/adminHeaderTabs";
import LineRegistrationManager from "@/components/admin/LineRegistrationManager";
import LineRegistrationInfoManager from "@/components/admin/LineRegistrationInfoManager";

export default function LineManagement() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab: "info" | "register" =
    searchParams?.get("tab") === "register" ? "register" : "info";

  return (
    <div className="flex w-full flex-col gap-4">
      <AdminPageHeader
        title="라인 관리"
        tabs={buildLineManageTabs(pathname, searchParams, tab)}
      />
      {tab === "register" ? (
        <LineRegistrationManager />
      ) : (
        <LineRegistrationInfoManager />
      )}
    </div>
  );
}
