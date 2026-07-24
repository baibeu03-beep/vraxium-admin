"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  resolveLogScopeDisplay,
} from "@/lib/adminProcessCheckTypes";
import type { ProcessLineGroupScope } from "@/lib/adminProcessesTypes";
import { AdminLogEntity } from "@/components/admin/AdminLogPresentation";

// 체크 로그의 "팀명 + 범위 배지" 공용 표현.
//   팀명은 일반 텍스트, 범위(팀 총괄/실제 파트명/파트 미확인)는 색상 배지로 분리 렌더링한다.
//   전체를 `${teamName}(${partName})` 한 문자열로 조립하지 않는다(구조적 렌더링 = 명세 요구).
//   범위 색상 체계는 파트별로 다르지 않다(모든 파트 = 동일 '파트' 보라색) — 파트 추가 시 색상 로직 무증가.

// 데이터 오류(파트 미확인)만 별도 경고 배지. 정상 팀/파트는 공통 AdminLogEntity를 쓴다.
function MissingScopeBadge({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center whitespace-normal break-keep rounded border border-red-200 bg-red-100 px-1.5 py-0.5 text-xs font-semibold leading-tight text-red-800 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-200"
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
      <AdminLogEntity kind="team" className="whitespace-normal break-keep">
        {name} 팀
      </AdminLogEntity>
      {scope.kind === "part" && (
        <AdminLogEntity kind="part" className="whitespace-normal break-keep">
          {scope.label}
        </AdminLogEntity>
      )}
      {scope.kind === "team" && (
        <AdminLogEntity kind="primary" className="whitespace-normal break-keep">
          {scope.label}
        </AdminLogEntity>
      )}
      {scope.kind === "missing" && <MissingScopeBadge>{scope.label}</MissingScopeBadge>}
    </span>
  );
}
