"use client";

import { CheckCircle2, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";

// 실무 경험 [라인 개설] 상단 개설 신청 상태 표시 — 공통 컴포넌트.
//   state 는 team-overall 서버 응답(SoT)에서 파생한다(프론트 로컬/버튼기록 금지):
//     · 개별 파트   → PartInputGetData/OverallBoardPart.submitted (개설 신청 완료 여부)
//     · 팀 총괄     → ExperienceTeamOverallBoard.status === "opened" (최종 개설 완료 여부)
//   문구는 파트/팀총괄이 다르므로 호출부가 라벨을 주입한다(기본값 = 파트 문구).
//   A/B 디자인(이미지)은 추후 이 컴포넌트 내부 아이콘/스타일만 교체하면 되고, 호출부는 불변.
//   색상만으로 구분하지 않도록 아이콘 + 문구를 항상 함께 렌더하고 aria-label 로 상태를 노출한다.

export type ExperienceOpeningState = "required" | "completed";

export default function ExperienceOpeningStatus({
  state,
  requiredLabel = "개설 신청 필요",
  completedLabel = "개설 신청 완료",
  className,
}: {
  state: ExperienceOpeningState;
  requiredLabel?: string;
  completedLabel?: string;
  className?: string;
}) {
  const completed = state === "completed";
  const label = completed ? completedLabel : requiredLabel;
  const Icon = completed ? CheckCircle2 : CircleDashed;
  return (
    <span
      role="status"
      data-slot="experience-opening-status"
      data-state={state}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium",
        completed
          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
        className,
      )}
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  );
}
