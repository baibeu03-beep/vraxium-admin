import { requireAdminPage } from "@/lib/adminAuth";
import ProcessCheckManager from "@/components/admin/ProcessCheckManager";

// 통합 > 허브별 프로세스 > 프로세스 체크 · [실무 정보 급] (/admin/processes/check/info?org=...).
//   이번 주 N(월~일) 고정 화면 — 액트별 체크 신청/취소/완료(상태 저장 + 로그). ?org 기준 데이터 분기.
//   ⚠ user_weekly_points.points/주차 성장 계산/snapshot 무접촉(후속 Phase).
export default async function ProcessCheckInfoPage() {
  await requireAdminPage();
  return <ProcessCheckManager hub="info" />;
}
