// /admin/dashboard — 네비게이션 '대시보드' 전용 빈 화면.
// HOME(/admin)과 분리된 경로로, 본문 영역만 비운다.
// 상단/사이드 네비게이션은 레이아웃에서 유지된다 (백엔드/DTO/snapshot 무관).
export default function AdminDashboardPage() {
  return <div className="min-h-[78vh] w-full" />;
}
