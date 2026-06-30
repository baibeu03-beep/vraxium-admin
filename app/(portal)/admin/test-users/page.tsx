import TestUsersManager from "@/components/admin/TestUsersManager";
import AdminHelp from "@/components/admin/AdminHelp";

// /admin/test-users — 데모/테스트 미리보기 대상 유저 선택 화면.
// 데이터는 클라이언트에서 GET /api/admin/test-users 로 조회한다.
// (portal) 레이아웃의 requireAdminPage() 로 어드민 인증이 강제된다.
export default function TestUsersPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">테스트 모드</h1>
        <AdminHelp />
      </div>
      <TestUsersManager />
    </div>
  );
}
