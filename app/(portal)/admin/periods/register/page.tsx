import PeriodManagementView from "@/components/admin/PeriodManagementView";

// 기간 관리(통합) — 기간 등록 폼 + 기간 정보 목록을 한 페이지로 제공한다.
//   (구 /admin/season-weeks 는 이 경로로 redirect 된다.)
export default function PeriodManagementPage() {
  return <PeriodManagementView />;
}
