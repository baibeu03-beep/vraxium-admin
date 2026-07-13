import Sidebar from "@/components/admin/Sidebar";
import Header from "@/components/admin/Header";
import NavProgress from "@/components/admin/NavProgress";
import GlobalLoadingBanner from "@/components/admin/GlobalLoadingBanner";
import { LoadingBannerProvider } from "@/components/admin/loadingBannerContext";
import { SidebarProvider } from "@/components/admin/sidebarContext";
import { AdminRouteTitleProvider } from "@/components/admin/AdminRouteTitleProvider";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AdminDialogViewport } from "@/components/ui/admin-dialog";
import { ToastViewport } from "@/components/ui/toast";
import AdminSessionProvider from "@/components/admin/AdminSessionProvider";
import { requireAdminPage } from "@/lib/adminAuth";
import { loadAdminDisplayName } from "@/lib/adminMe";
import { resolveAdminOrgAccess } from "@/lib/adminOrgAccess";
import { AdminModeProvider } from "@/components/admin/AdminModeProvider";
import { AdminOrgAccessProvider } from "@/components/admin/AdminOrgAccessProvider";
import { Suspense } from "react";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdminPage();
  // 헤더 우측 관리자 정보 표시용(이름 SoT = user_profiles.display_name).
  const adminDisplayName = await loadAdminDisplayName(admin.userId);
  // 관리자별 허용 조직(SoT = role + user_profiles.organization_slug). 조직 탭/필터 게이트용으로
  // 하위 클라이언트 트리에 주입한다(서버 계산 → 클라 fetch/로딩 없음). 서버 API 는 별도 재검증.
  const orgAccess = await resolveAdminOrgAccess(admin);

  return (
    <Suspense fallback={null}>
      <AdminModeProvider>
        {/* 관리자별 허용 조직 컨텍스트 — 조직 탭/필터 게이트(휴식 관리·라인 정보·팀/파트 정보). */}
        <AdminOrgAccessProvider value={orgAccess}>
        {/* 표준 쿠키 세션 관리(단일 SoT): 미사용 자동 로그아웃 + 탭 간 즉시 로그아웃 +
            헤더 카운트다운 공급. Header 가 소비할 수 있도록 하위 트리를 감싼다. */}
        <AdminSessionProvider>
        <SidebarProvider>
      {/* 데이터가 바뀌는 버튼(초기화/저장/완료/삭제/닫기)에 공통 확인 UI 제공 */}
      <ConfirmProvider>
        {/* 전역 로딩 배너 상태 — 화면별 조회 컴포넌트가 useReportLoading 으로 보고. */}
        <LoadingBannerProvider>
        {/* 전역 네비게이션 진행 표시(상단 Progress Bar + 클릭 피드백 + cursor:progress).
            Layout 한 곳에만 마운트 → 어드민 전체 공통 적용. */}
        <NavProgress />
        {/* 상세 페이지 표시명 공급(공통 route-title) — Header 와 main 을 함께 감싼다.
            상세 페이지가 이미 조회한 이름/주차명을 헤더 좌측 경로에 반영(중복 조회 없음). */}
        <AdminRouteTitleProvider>
        <div className="flex flex-1 min-h-screen bg-muted/40">
          <Sidebar />
          {/* min-w-0 lets this flex child shrink below intrinsic content width so
              wide tables scroll inside their own container instead of pushing the
              whole page (header + sidebar) horizontally. */}
          <div className="flex flex-1 flex-col min-w-0">
            <Header
              adminDisplayName={adminDisplayName}
              adminEmail={admin.email}
            />
            {/* 공통 로딩 배너 — 헤더 바로 아래·콘텐츠 최상단 고정 위치(전역 단일 출처). */}
            <GlobalLoadingBanner />
            <main className="flex-1 min-w-0 p-6">{children}</main>
          </div>
        </div>
        </AdminRouteTitleProvider>
        {/* 테스트 모드 전환은 URL ?mode=test 로만 진입한다(일반 UI 토글 제거).
            AdminModeProvider 가 ?mode 를 그대로 해석하므로 QA/테스트 동작은 불변. */}
        </LoadingBannerProvider>
        {/* 전역 토스트 뷰포트 — document.body 포털. 여기 한 곳에만 마운트한다.
            토스트를 발행하는 페이지가 있을 때만 화면에 나타나므로, 아직 옮기지 않은
            다른 페이지의 기존 배너 동작에는 영향을 주지 않는다. */}
        <ToastViewport />
        {/* 전역 커스텀 다이얼로그 뷰포트 — document.body 포털. 여기 한 곳에만 마운트한다
            (adminDialog store 싱글턴). 시스템 팝업(alert/confirm/prompt)과 페이지별 임시
            확인창을 대체한다. */}
        <AdminDialogViewport />
      </ConfirmProvider>
        </SidebarProvider>
        </AdminSessionProvider>
        </AdminOrgAccessProvider>
      </AdminModeProvider>
    </Suspense>
  );
}
