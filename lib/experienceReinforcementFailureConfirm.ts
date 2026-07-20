import { adminDialog } from "@/components/ui/admin-dialog";

// 실무 경험 "강화 실패(활동 인정 불가) 확인" 팝업 — 개설 신청/개설 검수 단계 공용 SoT.
//   활동 인정 판정 SoT = experienceScoreState().isReinforcementSuccess(점수 ≥ 4).
//   점수를 4점 미만으로 내리거나 체크를 해제해 해당 셀이 <강화 실패>가 되는 편집 **직전**에
//   두 단계 모두 이 함수를 호출한다 — 동일한 컴포넌트(adminDialog.confirm)·문구·버튼·흐름을 재사용.
//   반환 true=진행(편집 반영), false=취소(편집 롤백 — 호출부에서 updateCell 미호출).
export function confirmReinforcementFailure(crewName: string): Promise<boolean> {
  return adminDialog.confirm({
    title: "강화 실패 확인",
    description: `${crewName} 크루의 해당 라인이 <강화 실패>가 됩니다.\n이상이 없으신가요?`,
    confirmLabel: "확인",
    cancelLabel: "취소",
  });
}
