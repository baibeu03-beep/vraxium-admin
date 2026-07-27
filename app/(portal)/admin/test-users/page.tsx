import TestUsersManager from "@/components/admin/TestUsersManager";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import PageSection from "@/components/admin/PageSection";
import QaRunNowSnapshotPanels from "@/components/admin/QaRunNowSnapshotPanels";

// /admin/test-users — 데모/테스트 미리보기 대상 유저 선택 화면.
// 데이터는 클라이언트에서 GET /api/admin/test-users 로 조회한다.
// (portal) 레이아웃의 requireAdminPage() 로 어드민 인증이 강제된다.
export default function TestUsersPage() {
  return (
    <div className="admin-section-stack">
      <AdminPageHeader title="테스트 모드" />
      <TestUsersManager />
      {/* (추가) QA 즉시 실행: weekly-cards snapshot 재계산(테스트 전수 / 선택 유저) 입구.
          PageSection(divider="wave-dot") = "테스트 유저 선택(미리보기 대상)" ↔ "QA 스냅샷 재계산 도구"
          사이의 큰 섹션 경계 하나만 담당한다(/admin/periods/register 와 동일 SoT · 여백 48/56 대칭).
          제목은 추가하지 않으며 두 블록의 CardTitle 은 각 카드 안 그대로. */}
      <PageSection divider="wave-dot">
        <QaRunNowSnapshotPanels />
      </PageSection>
    </div>
  );
}
