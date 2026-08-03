import * as React from "react";
import { cn } from "@/lib/utils";

// 상세 정보(라벨:값) 공용 레이아웃 — "변동 액트 상세/검수 완료 상세/라인 개설·크루수정 확인" 등
//   박스 안에 라벨:값을 나열하는 모든 상세 팝업의 단일 SoT(2026-08-03).
//   ⚠ 좌측 라벨은 항상 whitespace-nowrap — 길다고 줄바꿈하지 않고 폭(w-32)을 넉넉히 확보한다.
//   w-32(8rem)는 이 프로젝트에서 실제 쓰이는 가장 긴 라벨("소속 허브 급", "저장 후 대상",
//   "단감 / 인절미 / 어흥" 같은 조직별 포인트 3종 조합)까지 한 줄에 들어오는 폭으로 실측 확정했다.
//   더 좁히면(w-24 등) 재발하므로, 폭을 줄이는 방향의 override 는 지양한다.
export const DETAIL_ROW_LABEL_CLASS = "w-32 shrink-0 whitespace-nowrap text-muted-foreground";
export const DETAIL_ROW_VALUE_CLASS = "min-w-0 break-words font-medium";

/**
 * div/span 기반 라벨:값 1행. 대부분의 상세 팝업이 이 컴포넌트로 충분하다.
 * dt/dd(정의 목록) 시맨틱이 필요한 곳(<dl> 내부)은 이 컴포넌트 대신
 * DETAIL_ROW_LABEL_CLASS/DETAIL_ROW_VALUE_CLASS 상수를 dt/dd에 직접 적용한다.
 */
export function DetailRow({
  label,
  value,
  labelClassName,
  valueClassName,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  labelClassName?: string;
  valueClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-3 text-sm", className)}>
      <span className={cn(DETAIL_ROW_LABEL_CLASS, labelClassName)}>{label}</span>
      <span className={cn(DETAIL_ROW_VALUE_CLASS, valueClassName)}>{value}</span>
    </div>
  );
}
