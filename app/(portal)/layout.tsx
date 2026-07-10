import Sidebar from "@/components/admin/Sidebar";
import Header from "@/components/admin/Header";
import NavProgress from "@/components/admin/NavProgress";
import GlobalLoadingBanner from "@/components/admin/GlobalLoadingBanner";
import { LoadingBannerProvider } from "@/components/admin/loadingBannerContext";
import { SidebarProvider } from "@/components/admin/sidebarContext";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastViewport } from "@/components/ui/toast";
import AdminSessionProvider from "@/components/admin/AdminSessionProvider";
import { requireAdminPage } from "@/lib/adminAuth";
import { loadAdminDisplayName } from "@/lib/adminMe";
import { AdminModeProvider } from "@/components/admin/AdminModeProvider";
import { Suspense } from "react";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdminPage();
  // 헤더 우측 관리자 정보 표시용(이름 SoT = user_profiles.display_name).
  const adminDisplayName = await loadAdminDisplayName(admin.userId);

  return (
    <Suspense fallback={null}>
      <AdminModeProvider>
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
        {/* 테스트 모드 전환은 URL ?mode=test 로만 진입한다(일반 UI 토글 제거).
            AdminModeProvider 가 ?mode 를 그대로 해석하므로 QA/테스트 동작은 불변. */}
        </LoadingBannerProvider>
        {/* 전역 토스트 뷰포트 — document.body 포털. 여기 한 곳에만 마운트한다.
            토스트를 발행하는 페이지가 있을 때만 화면에 나타나므로, 아직 옮기지 않은
            다른 페이지의 기존 배너 동작에는 영향을 주지 않는다. */}
        <ToastViewport />
      </ConfirmProvider>
        </SidebarProvider>
        </AdminSessionProvider>
      </AdminModeProvider>
    </Suspense>
  );
}
