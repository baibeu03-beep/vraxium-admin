import { requireAdminPage } from "@/lib/adminAuth";
import ProcessIrregularManager from "@/components/admin/ProcessIrregularManager";

// 통합 > 허브별 프로세스 > 프로세스 체크 · 변동 액트 (/admin/processes/check/irregular?org=...).
//   정규 기준표(process_acts) 외 변동 액트의 검수 신청/수동 부여 관리. 허브 무관 독립 페이지.
//   ?org 기준 분기 · ?mode(operating/test) 분리는 대상자(고객) 기준.
//   ⚠ 고객앱·snapshot·user_weekly_points·demoUserId 무접촉(관리자 전용). 포인트 A/B/C=표시/관리용.
export default async function ProcessCheckIrregularPage() {
  await requireAdminPage();
  return <ProcessIrregularManager />;
}
