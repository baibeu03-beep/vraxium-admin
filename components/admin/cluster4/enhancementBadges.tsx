"use client";

// 4허브 어드민 공통 — 강화 상태 / 라인칸 제출 상태 배지.
// 백엔드 DTO(enhancementStatus / submissionStatus / enhancementReason)를 그대로
// 표시하기 위한 라벨·배지. 프론트는 재계산하지 않는다 (서버 계산값 그대로).
// 기존 라인 status(void/pending/success/fail) 와 절대 섞지 말 것 — 별개 축이다.

import { cn } from "@/lib/utils";
import type {
  Cluster4EnhancementReason,
  Cluster4EnhancementStatus,
  Cluster4SubmissionStatus,
} from "@/shared/cluster4.contracts";

// 강화 상태 라벨. not_applicable 은 reason 으로 "해당 없음"(career) / "미배정"(비career) 구분.
export function enhancementLabel(
  status: Cluster4EnhancementStatus,
  reason: Cluster4EnhancementReason,
): string {
  switch (status) {
    case "success":
      return "강화 성공";
    case "pending":
      return "강화 대기";
    case "fail":
      return "강화 실패";
    case "not_applicable":
      return reason === "target_missing_not_required_career"
        ? "해당 없음"
        : "미배정";
  }
}

const ENHANCEMENT_TONE: Record<Cluster4EnhancementStatus, string> = {
  success: "bg-emerald-100 text-emerald-800",
  pending: "bg-amber-100 text-amber-800",
  fail: "bg-red-100 text-red-800",
  not_applicable: "bg-gray-100 text-gray-600",
};

export function EnhancementStatusBadge({
  status,
  reason,
  className,
}: {
  status: Cluster4EnhancementStatus;
  reason: Cluster4EnhancementReason;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        ENHANCEMENT_TONE[status],
        className,
      )}
    >
      {enhancementLabel(status, reason)}
    </span>
  );
}

// 사용자 노출 라벨만 "기입" 용어로 변경 — 내부 필드명(submissionStatus)·DB(submission_*)는 유지.
export const SUBMISSION_STATUS_LABEL: Record<Cluster4SubmissionStatus, string> = {
  submitted: "기입",
  not_submitted: "미기입",
  not_required: "기입 불필요",
};

const SUBMISSION_TONE: Record<Cluster4SubmissionStatus, string> = {
  submitted: "text-green-700",
  not_submitted: "text-orange-600",
  not_required: "text-muted-foreground",
};

export function SubmissionStatusBadge({
  status,
  className,
}: {
  status: Cluster4SubmissionStatus;
  className?: string;
}) {
  return (
    <span className={cn("text-xs", SUBMISSION_TONE[status], className)}>
      {SUBMISSION_STATUS_LABEL[status]}
    </span>
  );
}

// 강화 상태 필터 — UI 드롭다운 값과 매칭 헬퍼.
export type EnhancementFilter = "all" | "success" | "pending" | "fail" | "na";

export const ENHANCEMENT_FILTER_OPTIONS: { value: EnhancementFilter; label: string }[] = [
  { value: "all", label: "전체 강화 상태" },
  { value: "success", label: "강화 성공" },
  { value: "pending", label: "강화 대기" },
  { value: "fail", label: "강화 실패" },
  { value: "na", label: "미배정/해당 없음" },
];

// 라인 단위 강화 상태는 모든 대상자가 동일하다 (마감 여부 + partType 만으로 결정되고
// submission 유무와 무관하므로). 대표값으로 첫 대상자의 값을 쓴다. 대상자 0명이면 null.
export function matchesEnhancementFilter(
  filter: EnhancementFilter,
  status: Cluster4EnhancementStatus | null,
): boolean {
  if (filter === "all") return true;
  if (status === null) return false;
  if (filter === "na") return status === "not_applicable";
  return status === filter;
}
