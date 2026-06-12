import { requireAdminPage } from "@/lib/adminAuth";
import ProcessCheckManager from "@/components/admin/ProcessCheckManager";

// 개별 > 프로세스 체크 · [실무 경험 급] (/admin/processes/check/experience?org=...).
//   info 의 UX 재사용 + 팀 구분: 섹션.0=상태창1(팀별 문장)·로그창(팀명)·상태창2(전체 팀),
//   섹션.1=팀 탭 + 팀별 상태창2 + 팀별 액트 체크 테이블(팀 스코프 상태 저장).
//   ⚠ user_weekly_points/주차 성장 계산/snapshot 무접촉.
export default async function ProcessCheckExperiencePage() {
  await requireAdminPage();
  return <ProcessCheckManager hub="experience" />;
}
