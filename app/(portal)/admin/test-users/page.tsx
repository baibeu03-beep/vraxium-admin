import TestUsersManager from "@/components/admin/TestUsersManager";

// /admin/test-users — 데모/테스트 미리보기 대상 유저 선택 화면.
// 데이터는 클라이언트에서 GET /api/admin/test-users 로 조회한다.
// (portal) 레이아웃의 requireAdminPage() 로 어드민 인증이 강제된다.
export default function TestUsersPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">테스트 유저</h1>
        <p className="text-sm text-muted-foreground">
          더미 유저를 선택해 고객 페이지를 데모 모드로 미리볼 수 있습니다.
        </p>
      </div>
      <TestUsersManager />
    </div>
  );
}
