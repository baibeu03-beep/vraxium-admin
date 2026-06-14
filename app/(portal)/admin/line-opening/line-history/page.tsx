// [비활성화 2026-06-14] 라인 개설 이력 페이지 임시 비활성화(feature-off).
//   - 사이드바 메뉴 항목도 components/admin/Sidebar.tsx 에서 주석 처리됨.
//   - 직접 URL(/admin/line-opening/line-history) 접근 시 notFound()(404)로 차단.
//   - 복구 시: 아래 원본 구현 주석을 해제하고 notFound 라우트 본문을 제거.
//   - 매니저 컴포넌트(LineHistoryManager) 등 구조는 그대로 보존.
import { notFound } from "next/navigation";

// ── 원본 구현(복구용 보존) ──────────────────────────────────────────────
// import { requireAdminPage } from "@/lib/adminAuth";
// import LineHistoryManager from "@/components/admin/LineHistoryManager";
//
// export default async function LineHistoryPage() {
//   await requireAdminPage();
//   return <LineHistoryManager />;
// }
// ────────────────────────────────────────────────────────────────────────

export default function LineHistoryPage() {
  notFound();
}
