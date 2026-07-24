// 관리자 로그창 공통 presentation 토큰(browser-safe).
// 이벤트 판정·라벨·DTO는 각 도메인에 남기고, 의미별 색상과 엔티티 시각 위계만 공유한다.

export type AdminLogTone =
  | "submitted"
  | "resubmitted"
  | "reviewed"
  | "completed"
  | "cancelled"
  | "reverted"
  | "closed"
  | "neutral";

export const ADMIN_LOG_TONE_STYLES: Record<AdminLogTone, string> = {
  submitted:
    "border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300",
  resubmitted:
    "border-violet-200/80 bg-violet-50 text-violet-700 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-300",
  reviewed:
    "border-indigo-200/80 bg-indigo-50 text-indigo-700 dark:border-indigo-400/20 dark:bg-indigo-400/10 dark:text-indigo-300",
  completed:
    "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300",
  cancelled:
    "border-red-200/80 bg-red-50 text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300",
  reverted:
    "border-orange-200/80 bg-orange-50 text-orange-700 dark:border-orange-400/20 dark:bg-orange-400/10 dark:text-orange-300",
  closed:
    "border-slate-200/80 bg-slate-100/80 text-slate-600 dark:border-slate-400/20 dark:bg-slate-400/10 dark:text-slate-300",
  neutral:
    "border-border/70 bg-muted/50 text-muted-foreground dark:border-border/70 dark:bg-muted/40 dark:text-muted-foreground",
};

// team/part 는 기존 호출부의 도메인 의미를 보존하는 semantic alias다.
// team→primary, part→secondary 와 동일한 공통 presentation을 사용한다.
export type AdminLogEntityKind =
  | "team"
  | "part"
  | "primary"
  | "secondary"
  | "neutral";

export const ADMIN_LOG_ENTITY_STYLES: Record<AdminLogEntityKind, string> = {
  team:
    "bg-violet-100 font-semibold text-violet-800 ring-1 ring-violet-300/70 dark:bg-violet-900/45 dark:text-violet-100 dark:ring-violet-700/70",
  part:
    "bg-sky-100 font-semibold text-sky-800 ring-1 ring-sky-300/70 dark:bg-sky-900/45 dark:text-sky-100 dark:ring-sky-700/70",
  primary:
    "bg-violet-100 font-semibold text-violet-800 ring-1 ring-violet-300/70 dark:bg-violet-900/45 dark:text-violet-100 dark:ring-violet-700/70",
  secondary:
    "bg-sky-100 font-semibold text-sky-800 ring-1 ring-sky-300/70 dark:bg-sky-900/45 dark:text-sky-100 dark:ring-sky-700/70",
  neutral:
    "bg-slate-100 font-medium text-slate-700 ring-1 ring-slate-300/60 dark:bg-slate-800/70 dark:text-slate-200 dark:ring-slate-600/60",
};
