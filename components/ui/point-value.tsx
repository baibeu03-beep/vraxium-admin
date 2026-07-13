import * as React from "react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// 포인트 표시 색상 SoT (2026-07-13) — 어드민 전역 공통.
//
//   Point A(check)   = 연두(good)  — 좋은 의미
//   Point B(net/방패) = 연두(good)  — 좋은 의미 (음수가 될 수 있는 유일한 값이지만, 색은 종류 기준 = 연두)
//   Point C(penalty) = 빨강(danger) — 경고/차감 의미. 값은 항상 0 이상(양수)이며 마이너스 부호를 붙이지 않는다.
//
// 색은 "부호(양/음)"가 아니라 "포인트 종류"로 정한다. 따라서 C 가 양수여도 빨강,
// 최종 B 가 음수여도 연두다. 페이지별 하드코딩 대신 이 helper/component 를 SoT 로 사용한다.
// 실제 색 토큰은 app/globals.css 의 --point-good / --point-danger (light/dark 모두 정의, theme-aware).
// ─────────────────────────────────────────────────────────────────────────────

export type PointKind = "a" | "b" | "c";

const POINT_KIND_CLASS: Record<PointKind, string> = {
  a: "text-point-good",
  b: "text-point-good",
  c: "text-point-danger",
};

/** 포인트 종류에 대응하는 텍스트 색상 유틸 클래스를 반환한다. className 조합용. */
export function pointColorClass(kind: PointKind): string {
  return POINT_KIND_CLASS[kind];
}

/**
 * 포인트 값 한 개를 종류별 색으로 렌더한다.
 * - 값은 항상 양수 개념으로 표시(+/− 접두사 없음). null/undefined → dash.
 * - Point C 도 양수 그대로 표시하되 색상(빨강)으로 경고 의미를 전달한다.
 */
export function PointValue({
  kind,
  value,
  suffix,
  dash = "—",
  className,
  title,
}: {
  kind: PointKind;
  value: number | null | undefined;
  suffix?: string;
  dash?: string;
  className?: string;
  title?: string;
}) {
  const isNil = value == null;
  return (
    <span
      title={title}
      className={cn("tabular-nums", pointColorClass(kind), className)}
    >
      {isNil ? dash : `${value.toLocaleString()}${suffix ?? ""}`}
    </span>
  );
}
