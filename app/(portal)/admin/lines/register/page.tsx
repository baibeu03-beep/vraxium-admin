import { requireAdminPage } from "@/lib/adminAuth";
import LineManagement from "@/components/admin/LineManagement";

// 라인 관리 통합 페이지 — 라인 등록 다음에 기존 라인 정보 화면을 한 페이지에서 제공한다.
//   - ?tab=info 는 기존 링크 호환값으로 유지하며, 통합 화면의 라인 정보 섹션으로 이동한다.
//   - org optional: org 없으면 통합(전체 조직) 화면, org 있으면 해당 조직 화면.
//     (rest-management·team-parts/info 와 달리 lines 는 통합 컨텍스트를 유지 → org 강제 리다이렉트 없음.)
// 기존 URL 유지·저장 로직 무변경.
export default async function LineRegisterPage() {
  await requireAdminPage();
  return <LineManagement integrated />;
}
