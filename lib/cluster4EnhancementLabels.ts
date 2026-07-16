// Cluster4 강화 상태(enhancementStatus) 표시 라벨/톤 — 단일 resolver(브라우저 안전).
//   화면 문구를 각 호출부에서 조합하지 않고 여기 한 곳에서 enum→라벨을 매핑한다.
//   문구 기준: 강화 성공 / 강화 실패 / 해당 없음 / (pending)집계 전.

import type { Cluster4EnhancementStatus } from "@/shared/cluster4.contracts";

const ENHANCEMENT_STATUS_LABEL: Record<Cluster4EnhancementStatus, string> = {
  success: "강화 성공",
  fail: "강화 실패",
  not_applicable: "해당 없음",
  pending: "집계 전", // 미확정(집계 전) — 결과값처럼 성공/실패로 표기하지 않는다
};

export function formatEnhancementStatusLabel(status: Cluster4EnhancementStatus): string {
  return ENHANCEMENT_STATUS_LABEL[status] ?? "-";
}

// status-badge tone(라이트/다크 공용 토큰 계열). success=성공, fail=위험, 나머지=중립.
export type EnhancementBadgeTone = "success" | "danger" | "neutral";

export function enhancementStatusTone(status: Cluster4EnhancementStatus): EnhancementBadgeTone {
  if (status === "success") return "success";
  if (status === "fail") return "danger";
  return "neutral"; // not_applicable / pending
}
