// [비활성화 2026-07-04] 주차 카드 집계 확정 페이지 임시 비활성화(feature-off).
//   - 사이드바 메뉴 항목도 components/admin/Sidebar.tsx 에서 주석 처리됨.
//   - 직접 URL(/admin/weekly-card-finalization) 접근 시 notFound()(404)로 차단.
//   - mode=test / mode=operating 모두 동일하게 차단(모드 분기 없음).
//   - 복구 시: 아래 원본 구현 주석을 해제하고 notFound 라우트 본문을 제거.
//   - View 컴포넌트(WeeklyCardFinalizationView)·API·DTO·snapshot 등 구조는 그대로 보존.
import { notFound } from "next/navigation";

// ── 원본 구현(복구용 보존) ──────────────────────────────────────────────
// import WeeklyCardFinalizationView from "@/components/admin/WeeklyCardFinalizationView";
//
// export default function WeeklyCardFinalizationPage() {
//   return <WeeklyCardFinalizationView />;
// }
// ────────────────────────────────────────────────────────────────────────

export default function WeeklyCardFinalizationPage() {
  notFound();
}
