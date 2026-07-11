import { requireAdminPage } from "@/lib/adminAuth";
import LineManagement from "@/components/admin/LineManagement";

// 라인 관리 페이지(라인 정보 탭 기본). /admin/lines/info 직접 접근도 라인 정보 탭으로 진입한다.
// org optional: org 없으면 통합(전체 조직) 라인 정보, ?org= 있으면 해당 조직 화면.
//   (rest-management·team-parts/info 는 org 스코프를 유지하지만, lines 는 통합 컨텍스트를
//    의도적으로 살려둔다 → requirePageOrganization 로 기본 org 강제 리다이렉트하지 않는다.)
//   데이터 스코프/권한은 API(resolveAdminOrgAccess)가 담당한다: owner=전체, 단일 org=그 org 로 강제.
// ?tab=register 면 라인 등록 폼. 기존 URL 유지·저장 로직 무변경.
export default async function LineInfoPage() {
  await requireAdminPage();
  return <LineManagement />;
}
