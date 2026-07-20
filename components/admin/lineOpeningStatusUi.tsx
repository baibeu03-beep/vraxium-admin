"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// 라인 개설 상태창 공용 표현 프리미티브.
//   기존: 상태 문장마다 별도 박스(rounded-md border + bg-green/amber/muted + px-3 py-2).
//   변경: 카드 외곽선만 유지하고, 내부 문장은 단순 bullet 목록으로 통일한다.
//         상태 구분은 문장 배경이 아니라 '색상 bullet(●)' 로만 표현한다.
//         (날짜·주차명·팀명 등 문장 내부 빨강 강조는 엔진/문구가 그대로 소유 — 여기선 무관.)
//   실무 정보/경험/역량이 동일 컴포넌트를 재사용해 4개 하위 페이지 UI 를 일치시킨다.

export type StatusTone = "neutral" | "positive" | "warning";

// 상태 → bullet 색상. positive=개설 완료(초록), warning=개설 필요(주황), neutral=해당 기간 아님(회색).
function bulletClass(tone: StatusTone): string {
  switch (tone) {
    case "positive":
      return "text-green-600";
    case "warning":
      return "text-amber-600";
    default:
      return "text-muted-foreground";
  }
}

export function StatusList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <ul className={cn("space-y-2", className)}>{children}</ul>;
}

export function StatusListItem({
  tone = "neutral",
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-foreground">
      <span
        aria-hidden="true"
        className={cn("select-none leading-6", bulletClass(tone))}
      >
        ●
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

// 상태창(상단)과 '라인 개설'(하단) 두 독립 섹션을 시각적으로 분리하는 공용 구분선.
//   ⚠ 두 섹션 사이의 '바깥' 여백만 만든다 — 상태창 내부 간격이나 라인 개설 폼 내부 padding 은 건드리지 않는다.
//   여백은 margin 이 아니라 padding 으로 준다: 소비 부모가 대부분 space-y-* 컨테이너라
//     자식 margin-top 이 space-y 규칙(더 높은 specificity)에 덮인다 → 위/아래 비대칭 발생.
//     padding 은 덮이지 않으므로 space-y 안에서도 구분선 위/아래가 대칭으로 유지된다.
//   실효 여백(부모 space-y-4 기준): 모바일 32px(py-4 16 + space-y 16) → 데스크톱 40px(lg:py-6 24 + 16), 상하 대칭.
export function LineOpeningSectionDivider() {
  return (
    <div aria-hidden="true" className="py-4 lg:py-6">
      <div className="border-t border-border" />
    </div>
  );
}
