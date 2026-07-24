"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import type { StatusToken, StatusTokenKind } from "@/lib/lineOpeningStatusEngine";

// 라인 개설 상태창 공용 표현 프리미티브.
//   기존: 상태 문장마다 별도 박스(rounded-md border + bg-green/amber/muted + px-3 py-2).
//   변경: 카드 외곽선만 유지하고, 내부 문장은 단순 bullet 목록으로 통일한다.
//   bullet 정책(2026-07-24): bullet 은 '상태 표시'가 아니라 '목록 구분' 역할만 한다.
//     - 상태마다 다르던 bullet 색(green/amber/muted)을 전면 폐지하고, 모든 bullet 을
//       동일한 중립색(bg-muted-foreground/50) 고정 크기 작은 원으로 통일한다(라이트·다크 자동 대응).
//     - `●` 글자 대신 고정 크기 원형 요소(size-1)를 쓴다 — 페이지/폰트마다 크기가 달라지는 문제 방지.
//     - 상태 구분은 오직 문구·배지·텍스트 강조 색(statusTokenClass)으로만 표현한다(bullet 로는 구분 안함).
//   문장 내부 강조는 역할(토큰 kind)별 공통 토큰 스타일(statusTokenClass)로 통일한다 —
//     날짜·주차=rose / 팀·라인=blue / 개설 완료·크루 기입=green / 개설 필요=amber / 해당 기간 아님=gray.
//     페이지마다 개별 색을 만들지 않고 이 SoT 하나만 쓴다(라이트·다크 모두 가독성 확보).
//   실무 정보/경험/역량 + 프로세스 체크가 동일 컴포넌트를 재사용해 하위 페이지 UI 를 일치시킨다.

// tone 은 하위호환용으로 남겨둔 API(호출부가 계속 전달) — 더 이상 bullet 색/모양을 바꾸지 않는다.
//   상태 구분은 문구·배지·statusTokenClass 로만 하므로 tone 값은 렌더에 영향을 주지 않는다.
export type StatusTone = "neutral" | "positive" | "warning";

// 토큰 역할(kind) → 강조 클래스 SoT. 라이트/다크 모두 가독성 확보. 상태창 전 페이지 공용.
//   빨간색을 모든 중요 정보에 공통 사용하지 않는다 — 역할별로 색을 분리한다.
export function statusTokenClass(kind: StatusTokenKind): string {
  switch (kind) {
    case "date": // 날짜·주차명 — 로즈.
      return "font-semibold text-rose-600 dark:text-rose-400";
    case "team": // 팀·라인명 — 블루.
      return "font-semibold text-blue-600 dark:text-blue-400";
    case "openDone": // 개설 완료 — 연한 초록 하이라이트.
      return "rounded bg-emerald-500/10 px-1 font-semibold text-emerald-700 dark:text-emerald-400";
    case "openNeed": // 개설 필요 — 연한 앰버 하이라이트.
      return "rounded bg-amber-500/10 px-1 font-semibold text-amber-700 dark:text-amber-400";
    case "crewOk": // 크루 기입 가능 — 초록 강조.
      return "font-semibold text-emerald-700 dark:text-emerald-400";
    case "periodNone": // 해당 기간 아님·휴식·미오픈 — 보조 텍스트(회색).
      return "font-medium text-muted-foreground";
    case "accent": // 온라인/오프라인 등 보조 강조 — 인디고.
      return "font-semibold text-indigo-600 dark:text-indigo-400";
    default:
      return "";
  }
}

// 역할별 토큰 배열 렌더러(공통) — 상태창 전 페이지가 동일 강조 규칙을 쓴다.
export function StatusTokens({ tokens }: { tokens: ReadonlyArray<StatusToken> }) {
  return (
    <>
      {tokens.map((tk, i) => {
        const cls = statusTokenClass(tk.kind);
        return cls ? (
          <span key={i} className={cls}>
            {tk.text}
          </span>
        ) : (
          <span key={i}>{tk.text}</span>
        );
      })}
    </>
  );
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
  children,
}: {
  // tone 은 하위호환용 API — 호출부가 계속 전달하지만 렌더에 사용하지 않는다(상태 구분=문구·배지·강조 색만).
  tone?: StatusTone;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-foreground">
      {/* 목록 구분용 중립 bullet — 상태와 무관한 동일 색·고정 크기(라이트/다크 자동 대응).
          mt-[0.6em] 로 첫 줄 텍스트 중앙에 맞춘다(em 기준이라 폰트 크기와 무관하게 정렬 유지). */}
      <span
        aria-hidden="true"
        className="mt-[0.6em] size-1 shrink-0 rounded-full bg-muted-foreground/50"
      />
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
      {/* 공통 Separator(기본 fade) — 양끝이 흐려지는 부드러운 섹션 구분선.
          바깥 py- 래퍼가 상/하 대칭 여백을 유지(space-y 부모에서도 안전) → 간격 규칙 불변. */}
      <Separator />
    </div>
  );
}
