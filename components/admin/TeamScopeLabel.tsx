"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  resolveLogScopeDisplay,
  type LogScopeKind,
} from "@/lib/adminProcessCheckTypes";
import type { ProcessLineGroupScope } from "@/lib/adminProcessesTypes";

// 체크 로그의 "팀명 + 범위 배지" 공용 표현.
//   팀명은 일반 텍스트, 범위(팀 총괄/실제 파트명/파트 미확인)는 색상 배지로 분리 렌더링한다.
//   전체를 `${teamName}(${partName})` 한 문자열로 조립하지 않는다(구조적 렌더링 = 명세 요구).
//   범위 색상 체계는 파트별로 다르지 않다(모든 파트 = 동일 '파트' 보라색) — 파트 추가 시 색상 로직 무증가.

// 배지 종류별 색상 — 팀 총괄=파란색 · 파트=보라색 · 데이터 오류(파트 미확인)=빨간색.
//   접근성: 색상만으로 구분하지 않고 항상 텍스트를 함께 표시. 라이트/다크 모드 대비 확보.
const SCOPE_BADGE_CLASS: Record<Exclude<LogScopeKind, "none">, string> = {
  team: "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-400/30 dark:bg-sky-400/15 dark:text-sky-200",
  part: "border-violet-200 bg-violet-100 text-violet-800 dark:border-violet-400/30 dark:bg-violet-400/15 dark:text-violet-200",
  missing: "border-red-200 bg-red-100 text-red-800 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-200",
};

function ScopeBadge({ kind, children }: { kind: Exclude<LogScopeKind, "none">; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-normal break-keep rounded px-1.5 py-0.5 text-xs font-semibold leading-tight",
        SCOPE_BADGE_CLASS[kind],
      )}
    >
      {children}
    </span>
  );
}

// 팀명(일반 텍스트) + 범위 배지. 팀 구분 없는 허브(teamName 없음)면 아무것도 렌더링하지 않는다.
export default function TeamScopeLabel({
  teamName,
  scopeType,
  partName,
  className,
}: {
  teamName: string | null | undefined;
  scopeType: ProcessLineGroupScope | null | undefined;
  partName: string | null | undefined;
  className?: string;
}) {
  const name = (teamName ?? "").trim();
  if (!name) return null; // 비팀 허브(info 등) — 범위 세그먼트 자체 생략.
  const scope = resolveLogScopeDisplay(scopeType, partName);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1 align-middle", className)}>
      <span className="whitespace-normal break-keep font-medium text-foreground">{name} 팀</span>
      {scope.kind !== "none" && <ScopeBadge kind={scope.kind}>{scope.label}</ScopeBadge>}
    </span>
  );
}
