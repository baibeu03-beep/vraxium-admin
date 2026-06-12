import { requireAdminPage } from "@/lib/adminAuth";
import ProcessCheckManager from "@/components/admin/ProcessCheckManager";

// 개별 > 프로세스 체크 · [실무 경험 급] (/admin/processes/check/experience?org=...).
//   info 의 UX 재사용 + 팀 구분: 상태창1=팀별 문장(org 팀 동적), 로그창=팀명 포함.
//   이번 Phase = [섹션.0] 액트 관리(상태/로그/진행현황)만 — [섹션.1] 액트 체크 테이블은 후속(showActTable=false).
//   ⚠ user_weekly_points/주차 성장 계산/snapshot 무접촉.
export default async function ProcessCheckExperiencePage() {
  await requireAdminPage();
  return <ProcessCheckManager hub="experience" showActTable={false} />;
}
