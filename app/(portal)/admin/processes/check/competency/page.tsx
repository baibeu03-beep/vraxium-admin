import { requireAdminPage } from "@/lib/adminAuth";
import ProcessCheckManager from "@/components/admin/ProcessCheckManager";

// 통합 > 허브별 프로세스 > 프로세스 체크 · [실무 역량 급] (/admin/processes/check/competency?org=...).
//   info 와 동일 화면(공용 ProcessCheckManager) — 차이는 액트 목록이 hub=competency 로만 필터된다는 점뿐.
//   info 의 테스트 모드 주차 예외(13주차)는 비적용(데이터레이어 hubAllowsTestWeekException=info 한정).
//   ⚠ user_weekly_points.points/주차 성장 계산/snapshot 무접촉.
export default async function ProcessCheckCompetencyPage() {
  await requireAdminPage();
  return <ProcessCheckManager hub="competency" />;
}
