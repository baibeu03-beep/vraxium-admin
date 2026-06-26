"use client";

import { AlertTriangle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useDelayedLoading } from "@/lib/useDelayedLoading";
import { cn } from "@/lib/utils";

// 사용자 친화 문구 단일 출처(요구사항 문구). 페이지마다 다르게 적지 않는다.
export const LOADING_TEXT = {
  title: "불러오는 중...",
  body: "데이터를 불러오고 있습니다. 잠시만 기다려주세요.",
  slowTitle: "응답이 지연되고 있습니다.",
  slowBody: "네트워크 상태를 확인해주세요. 계속 시도하고 있습니다.",
} as const;

type LoadingStateProps = {
  /** 비동기 작업 진행 여부. true 여도 500ms 이내면 노출되지 않는다(깜빡임 방지). */
  active: boolean;
  /** 노출 형태: block(중앙 정렬 박스) / inline(텍스트 옆 스피너). 기본 block. */
  variant?: "block" | "inline";
  title?: string;
  body?: string;
  className?: string;
};

/**
 * 공통 로딩 표시(전역 단일 출처).
 * - 500ms 이상 지연부터 노출, 작업 완료 즉시 제거(useDelayedLoading).
 * - 10초 이상 지연되면 "응답이 지연되고 있습니다" 안내로 자동 전환(요구사항 7번).
 * - 스피너 + 안내 텍스트를 항상 함께 노출.
 */
export function LoadingState({
  active,
  variant = "block",
  title,
  body,
  className,
}: LoadingStateProps) {
  const { visible, slow } = useDelayedLoading(active);
  if (!visible) return null;

  if (variant === "inline") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "inline-flex items-center gap-2 text-sm",
          slow ? "text-tone-warn" : "text-muted-foreground",
          className,
        )}
      >
        {slow ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <Spinner size="sm" />}
        {slow ? LOADING_TEXT.slowTitle : title ?? LOADING_TEXT.title}
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-12 text-center",
        className,
      )}
    >
      {slow ? (
        <AlertTriangle className="h-6 w-6 text-tone-warn" />
      ) : (
        <Spinner size="lg" />
      )}
      <div className="space-y-1">
        <p className={cn("text-sm font-medium", slow ? "text-tone-warn" : "text-foreground")}>
          {slow ? LOADING_TEXT.slowTitle : title ?? LOADING_TEXT.title}
        </p>
        <p className="text-xs text-muted-foreground">
          {slow ? LOADING_TEXT.slowBody : body ?? LOADING_TEXT.body}
        </p>
      </div>
    </div>
  );
}
