"use client";

import { CheckCircle2, CircleDashed, ClipboardCheck, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExperienceOpeningProgress } from "@/lib/experienceOpeningProgress";

const PROGRESS_UI = {
  required: {
    label: "개설 필요",
    icon: CircleDashed,
    className: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  },
  application_completed: {
    label: "개설 신청 완료",
    icon: Send,
    className: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
  },
  review_completed: {
    label: "개설 검수 완료",
    icon: ClipboardCheck,
    className: "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
  },
  opened: {
    label: "개설 완료",
    icon: CheckCircle2,
    className: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
} as const;

export default function ExperienceOpeningStatus({
  progress,
  className,
}: {
  progress: ExperienceOpeningProgress;
  className?: string;
}) {
  const ui = PROGRESS_UI[progress];
  const Icon = ui.icon;
  return (
    <span
      role="status"
      data-slot="experience-opening-status"
      data-state={progress}
      aria-label={ui.label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium",
        ui.className,
        className,
      )}
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span>{ui.label}</span>
    </span>
  );
}
