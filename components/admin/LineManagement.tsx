"use client";

// 라인 관리 — 기존 "라인 정보" / "라인 등록" 화면을 재사용하는 래퍼.
//   - /admin/members 의 "크루 목록 / 크루 정보" 탭과 동일한 톤(AdminPageHeader + 탭).
//   - /admin/lines/register 는 integrated=true: 등록 → 정보 순서의 단일 화면, 탭은 "라인 등록" 하나.
//   - /admin/lines/info 는 기존 탭 화면을 유지한다(이번 통합 디자인의 적용 범위 밖).
//   - 본문은 기존 매니저 컴포넌트를 **그대로 재사용**한다(로직/저장/API 무변경).

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import PageSection from "@/components/admin/PageSection";
import { buildLineManageTabs } from "@/lib/adminHeaderTabs";
import { readOrgParam } from "@/lib/adminOrgContext";
import LineRegistrationManager from "@/components/admin/LineRegistrationManager";
import LineRegistrationInfoManager from "@/components/admin/LineRegistrationInfoManager";

export default function LineManagement({ integrated = false }: { integrated?: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // 탭 기본값은 "경로 기반" — /admin/lines/register 로 들어오면 등록 탭, /admin/lines/info 면 정보 탭.
  //   (기존엔 경로와 무관하게 항상 info 가 기본이라, 조직 미지정 통합 진입 시 /register 가 빈 화면이었다.)
  //   ?tab 이 명시되면 그 값이 우선한다(정보 ↔ 등록 상호 이동 유지·URL 불변).
  const explicitTab = searchParams?.get("tab");
  const tab: "info" | "register" =
    explicitTab === "register"
      ? "register"
      : explicitTab === "info"
        ? "info"
        : pathname.endsWith("/register")
          ? "register"
          : "info";
  // 사이드바 메뉴명과 페이지 제목 정합: 통합 모드 = "라인 관리", 조직 모드(?org) = "허브와 라인".
  const org = readOrgParam(searchParams);
  const tabs = buildLineManageTabs(pathname, searchParams, tab);

  // 기존 ?tab=info 북마크는 통합 화면의 정보 섹션으로 연결한다.
  // query 는 삭제하거나 교체하지 않으며, 일반/test/org 모두 같은 DOM 경로를 사용한다.
  useEffect(() => {
    if (!integrated || explicitTab !== "info") return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById("line-info");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [explicitTab, integrated]);

  return (
    <div className="admin-section-stack w-full">
      <AdminPageHeader
        title={org ? "허브와 라인" : "라인 관리"}
        tabs={integrated ? undefined : tabs}
      />
      {integrated ? (
        <>
          <PageSection title="라인 등록">
            <LineRegistrationManager integrated />
          </PageSection>
          <PageSection
            id="line-info"
            title="라인 정보"
            divider="wave-dot"
            tabIndex={-1}
            className="focus:outline-none"
          >
            <LineRegistrationInfoManager org={org} />
          </PageSection>
        </>
      ) : tab === "register" ? (
        <LineRegistrationManager />
      ) : (
        // 라인 정보 탭 — org optional: org 없으면 통합(전체 조직) 화면, org 있으면 해당 조직 화면.
        //   데이터 스코프/권한은 API(resolveAdminOrgAccess)가 담당한다. (안내 박스 폐지)
        <LineRegistrationInfoManager org={org} />
      )}
    </div>
  );
}
