"use client";

import { Fragment } from "react";
import { Check, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExperienceOpeningProgress } from "@/lib/experienceOpeningProgress";

// 실무 경험 [라인 개설] 진행 단계 플로우.
//   기존 단일 상태 pill(ExperienceOpeningStatus)을 대체 — 4단계 전체를 항상 노출하고
//   현재 도달한 단계만 강조한다. 단계 판정 SoT 는 상위의 resolveExperienceOpeningProgress
//   (= 서버 team-overall 상태) — 이 컴포넌트는 표시 전용(낙관적 진행 없음).
//     required            → 1단계(개설 신청 필요)
//     application_completed → 2단계(개설 신청 완료 / 개설 검수 필요)
//     review_completed    → 3단계(개설 검수 완료 / 개설 필요)
//     opened              → 4단계(개설 완료)

type StepDef = {
  key: ExperienceOpeningProgress;
  title: string;
  subtitle?: string;
};

// 화면에 항상 보이는 전체 순서(문구 고정 — 임의 변경 금지).
const STEPS: readonly StepDef[] = [
  { key: "required", title: "개설 신청 필요" },
  { key: "application_completed", title: "개설 신청 완료", subtitle: "개설 검수 필요" },
  { key: "review_completed", title: "개설 검수 완료", subtitle: "개설 필요" },
  { key: "opened", title: "개설 완료" },
] as const;

// 현재 단계 색상(도달한 단계만 per-state 강조 — 기존 pill 의 색 의미 보존).
const CURRENT_STYLE: Record<ExperienceOpeningProgress, string> = {
  required:
    "border-amber-400 bg-amber-50 text-amber-800 ring-1 ring-amber-300 dark:border-amber-600 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-700",
  application_completed:
    "border-sky-400 bg-sky-50 text-sky-800 ring-1 ring-sky-300 dark:border-sky-600 dark:bg-sky-950/50 dark:text-sky-200 dark:ring-sky-700",
  review_completed:
    "border-violet-400 bg-violet-50 text-violet-800 ring-1 ring-violet-300 dark:border-violet-600 dark:bg-violet-950/50 dark:text-violet-200 dark:ring-violet-700",
  opened:
    "border-emerald-400 bg-emerald-50 text-emerald-800 ring-1 ring-emerald-300 dark:border-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-200 dark:ring-emerald-700",
};

// 지나온(완료) 단계 — 활성색 유지하되 현재보다 강조도 낮게(체크 아이콘 병기, 색 무의존).
const DONE_STYLE =
  "border-emerald-200 bg-emerald-50/60 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/25 dark:text-emerald-300/90";

// 아직 도달하지 않은 단계 — 회색/흐림, 아이콘 없음, 점선 테두리.
const UPCOMING_STYLE =
  "border-dashed border-border bg-muted/20 text-muted-foreground/60 dark:bg-muted/10";

type StepState = "done" | "current" | "upcoming";

const STATE_A11Y: Record<StepState, string> = {
  done: "완료됨",
  current: "현재 단계",
  upcoming: "아직 진행 전",
};

export default function ExperienceOpeningProgressSteps({
  progress,
  className,
}: {
  progress: ExperienceOpeningProgress;
  className?: string;
}) {
  const currentIndex = STEPS.findIndex((s) => s.key === progress);

  return (
    <ol
      data-slot="experience-opening-progress-steps"
      data-state={progress}
      aria-label="라인 개설 진행 단계"
      className={cn(
        // 넓은 화면=가로 한 줄, 좁으면 가로 스크롤(단계 문구 찌그러짐 방지 — min-w 고정).
        "flex items-stretch gap-1 overflow-x-auto pb-1",
        className,
      )}
    >
      {STEPS.map((step, i) => {
        const state: StepState =
          i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
        // 연결선: 현재 단계까지만 불이 들어온다(현재로 진입하는 구간 포함).
        const connectorActive = i <= currentIndex;
        return (
          <Fragment key={step.key}>
            {i > 0 && (
              <li aria-hidden className="flex min-w-[1.25rem] flex-1 items-center px-0.5">
                <span
                  className={cn(
                    "h-0.5 w-full rounded-full",
                    connectorActive
                      ? "bg-emerald-400 dark:bg-emerald-600"
                      : "bg-border",
                  )}
                />
              </li>
            )}
            <li
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "flex min-w-[8.5rem] shrink-0 items-start gap-2 rounded-md border px-3 py-2",
                state === "current" && CURRENT_STYLE[step.key],
                state === "done" && DONE_STYLE,
                state === "upcoming" && UPCOMING_STYLE,
              )}
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                {state === "done" && (
                  <Check aria-hidden className="h-4 w-4" />
                )}
                {state === "current" && (
                  <CircleDot aria-hidden className="h-4 w-4" />
                )}
                {/* 미도달: 아이콘 없음(색상 무의존 — 상태 텍스트는 sr-only 로 전달). */}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-xs font-semibold leading-tight",
                    state === "upcoming" && "font-medium",
                  )}
                >
                  {step.title}
                </span>
                {step.subtitle && (
                  <span className="mt-0.5 block text-[11px] leading-tight opacity-80">
                    {step.subtitle}
                  </span>
                )}
                <span className="sr-only">
                  {`, ${STATE_A11Y[state]}`}
                </span>
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
