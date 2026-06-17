import { requireAdminPage } from "@/lib/adminAuth";
import ProcessCheckManager from "@/components/admin/ProcessCheckManager";

// 통합 > 허브별 프로세스 > 프로세스 체크 · [클럽 총괄 급] (/admin/processes/check/club?org=...).
//   info 와 동일 화면(공용 ProcessCheckManager) — 차이는 액트 목록이 hub=club 으로만 필터된다는 점뿐.
//   테스트 모드 주차 예외(2026 봄 W13)는 club 만 비적용(PROCESS_HUB_TO_TEST_WEEK_HUB 에 미등재 = 현재 주차 유지).
//   ⚠ user_weekly_points.points/주차 성장 계산/snapshot 무접촉.
export default async function ProcessCheckClubPage() {
  await requireAdminPage();
  return <ProcessCheckManager hub="club" />;
}
