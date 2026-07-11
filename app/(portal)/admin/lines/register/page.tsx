import { requireAdminPage } from "@/lib/adminAuth";
import LineManagement from "@/components/admin/LineManagement";

// 라인 관리 페이지. 탭(라인 정보/라인 등록)은 ?tab 으로 구동된다(기본 = 경로 기반, LineManagement 참조).
//   - /admin/lines/register 직접 접근 = 등록 탭 · ?tab=info = 라인 정보 탭.
//   - 라인 정보 탭은 org optional: org 없으면 통합(전체 조직) 화면, org 있으면 해당 조직 화면.
//     (rest-management·team-parts/info 와 달리 lines 는 통합 컨텍스트를 유지 → org 강제 리다이렉트 없음.)
// 기존 URL 유지·저장 로직 무변경.
export default async function LineRegisterPage() {
  await requireAdminPage();
  return <LineManagement />;
}
