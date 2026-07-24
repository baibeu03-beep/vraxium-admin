import Sidebar from "@/components/admin/Sidebar";
import Header from "@/components/admin/Header";
import NavProgress from "@/components/admin/NavProgress";
import GlobalLoadingBanner from "@/components/admin/GlobalLoadingBanner";
import { LoadingBannerProvider } from "@/components/admin/loadingBannerContext";
import { SidebarProvider } from "@/components/admin/sidebarContext";
import { AdminRouteTitleProvider } from "@/components/admin/AdminRouteTitleProvider";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AdminDialogViewport } from "@/components/ui/admin-dialog";
import { ToastSafeArea, ToastViewport } from "@/components/ui/toast";
import HoverTooltipProvider from "@/components/admin/HoverTooltipProvider";
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
        {/* 앱 셸을 뷰포트 높이(h-screen)로 고정한다. 문서(window) 스크롤 대신 콘텐츠 영역(main)이
            자체 영역 안에서만 스크롤되게 하여, 토스트가 뜰 때 화면 하단에 안전영역을 만들 수 있게 한다.
            (이전의 window 스크롤 + main pb-32 방식은 문서 맨 끝에만 여백이 생겨, 스크롤 중간·상단에서는
             fixed 토스트가 여전히 콘텐츠를 덮었다 → 스크롤 컨테이너 자체를 분리해 근본 해결한다.)
            안전영역은 "상시 96px" 이 아니라 토스트가 떠 있는 동안에만 잡힌다 → 평소에는 하단 여백 0. */}
        <div className="flex h-screen bg-muted/40">
          <Sidebar />
          {/* min-w-0 lets this flex child shrink below intrinsic content width so
              wide tables scroll inside their own container instead of pushing the
              whole page (header + sidebar) horizontally. */}
          <div className="flex flex-1 flex-col min-w-0">
            <Header
              adminDisplayName={adminDisplayName}
              adminEmail={admin.email}
            />
            {/* 조직 환경 배너는 좌측 사이드바 상단(HOME/개별 아래)으로 이동했다(2026-07-24).
                → 우측 콘텐츠 영역에는 더 이상 렌더하지 않는다. components/admin/Sidebar.tsx 참조. */}
            {/* 공통 로딩 배너 — 헤더 바로 아래·콘텐츠 최상단 고정 위치(전역 단일 출처). */}
            <GlobalLoadingBanner />
            {/* 실제 페이지 콘텐츠 스크롤 영역 — 높이 = 뷰포트 − 헤더 − 배너 − 하단 토스트 영역.
                overflow-y-auto: 여기(main)가 유일한 세로 스크롤 컨테이너가 된다(window 대신).
                min-h-0: flex 자식의 기본 min-height:auto 를 풀어 콘텐츠가 넘칠 때 늘어나지 않고
                  실제로 내부 스크롤되게 한다(이게 없으면 overflow 가 무력화된다).
                p-6 등 기존 여백은 그대로 유지 → 개별 페이지 수정 없음. */}
            {/* data-admin-scroll-container: 어드민의 유일한 세로 스크롤 컨테이너 표식(단일 SoT).
                ToastSafeArea 가 안전영역 높이 변화만큼 스크롤 위치를 보정할 때 이 표식으로 찾는다. */}
            <main
              data-admin-scroll-container
              className="flex-1 min-h-0 min-w-0 overflow-y-auto p-6"
            >
              {children}
              {/* 푸터 예약 영역(전역 공통) — 향후 Footer 컴포넌트가 들어갈 자리만 미리 확보한다.
                  현재는 내용 없음(빈 공간). 콘텐츠 스크롤 흐름의 맨 끝에 위치하므로:
                    · 콘텐츠 영역/스크롤 컨테이너(main)를 별도로 줄이지 않는다 → 스크롤 동작 불변.
                    · 배경은 상위(bg-muted/40)를 그대로 상속 → border/shadow/텍스트/아이콘 없음.
                    · mode(일반/test)·org 분기 없이 어드민 전역 동일 적용(개별 페이지 수정 없음).
                  실제 푸터를 붙일 때는 이 div 내부에 <Footer /> 를 렌더하면 된다(구조 유지). */}
              <div aria-hidden className="h-48" data-admin-footer-reserved />
            </main>
            {/* 하단 토스트 안전영역 — main 스크롤 영역 "바깥"의 형제 요소.
                토스트가 떠 있을 때만(실측 높이만큼) 화면 하단을 비워 콘텐츠를 위로 밀어 올린다.
                토스트가 없으면 높이 0 → 하단 죽은 여백 없이 세로 공간을 전부 콘텐츠에 쓴다.
                스크롤 위치(상단·중간·하단) 무관하게 토스트가 콘텐츠를 덮지 않는 건 그대로 유지.
                mode/org 분기 없이 전역 적용. */}
            <ToastSafeArea />
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
        {/* 전역 Hover Tooltip — 어드민 전역의 네이티브 title 툴팁을 공통 말풍선 디자인으로 통일한다.
            여기 한 곳에만 마운트(document 위임 리스너 · body 포털). mode/org 무관·개별 페이지 수정 없음. */}
        <HoverTooltipProvider />
      </ConfirmProvider>
        </SidebarProvider>
        </AdminSessionProvider>
        </AdminOrgAccessProvider>
      </AdminModeProvider>
    </Suspense>
  );
}
