"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Checkbox — 어드민 전역 체크박스 단일 SoT.
// 네이티브 <input type="checkbox"> 를 감싸며, 실제 스타일은 app/globals.css 의
// `.admin-checkbox`(appearance:none 커스텀 렌더)가 담당한다. 페이지마다 스타일을
// 복제하지 말고 이 컴포넌트 + 아래 헬퍼(checkedTextClass·checkedRowClass)를 쓴다.
//
// 상태 표현(혼동 방지): 미체크=빈 상자 / 체크=accent 채움+체크마크 /
//   indeterminate=accent 채움+가로막대 / readonly=점선 muted / disabled=흐려짐.
//   mode·조직·actAsTestUserId 와 무관하게 동일 컴포넌트·동일 클래스를 탄다.
//
// 지원 props: 네이티브 input 전부 + `indeterminate`(ref 로 반영). readOnly 는
//   시각(점선 muted) + 토글 차단까지 처리한다(네이티브 checkbox 는 readOnly 로
//   토글이 막히지 않으므로 onClick 에서 preventDefault).
// ─────────────────────────────────────────────────────────────────────────────
export type CheckboxProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  /** 부분 선택 상태(select-all 등). true 면 accent 채움 + 가로 막대. */
  indeterminate?: boolean;
};

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(
    { className, indeterminate, readOnly, onClick, ...props },
    forwardedRef,
  ) {
    const innerRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(
      forwardedRef,
      () => innerRef.current as HTMLInputElement,
    );

    React.useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = Boolean(indeterminate);
    }, [indeterminate]);

    return (
      <input
        ref={innerRef}
        type="checkbox"
        data-slot="checkbox"
        data-readonly={readOnly ? "true" : undefined}
        aria-readonly={readOnly || undefined}
        readOnly={readOnly}
        onClick={(e) => {
          // 네이티브 checkbox 는 readOnly 로 토글이 막히지 않는다 → 직접 차단.
          if (readOnly) e.preventDefault();
          onClick?.(e);
        }}
        className={cn("admin-checkbox", className)}
        {...props}
      />
    );
  },
);

// 체크된 항목의 인덱스·라벨 텍스트 강조 recipe(단일 SoT). 체크=accent 색 + 굵기,
// 미체크=빈 문자열(호출부의 기본 중립색 유지). 인덱스 번호·이름 span 등에 붙인다.
export function checkedTextClass(checked: boolean): string {
  return checked ? "font-semibold text-checkbox-accent-text" : "";
}

// 체크된 행/카드/라벨 컨테이너의 옅은 강조 배경 recipe(단일 SoT).
export function checkedRowClass(checked: boolean): string {
  return checked ? "bg-checkbox-accent-row" : "";
}

// CheckboxField — "체크박스 + 인접 라벨(+선택 인덱스)" 인라인 패턴 편의 컴포넌트.
// 체크 시 라벨·인덱스에 checkedTextClass 를 자동 적용한다. 표/그리드처럼 인덱스와
// 체크박스가 다른 셀에 있는 레이아웃은 <Checkbox> + 헬퍼를 직접 조합해 쓴다.
export function CheckboxField({
  checked,
  label,
  index,
  className,
  labelClassName,
  disabled,
  readOnly,
  indeterminate,
  ...props
}: CheckboxProps & {
  checked?: boolean;
  label: React.ReactNode;
  /** 라벨 앞 인덱스/번호(선택). 체크 시 라벨과 함께 강조된다. */
  index?: React.ReactNode;
  /** 라벨 span 추가 className. */
  labelClassName?: string;
}) {
  const on = Boolean(checked);
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 text-sm",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        readOnly={readOnly}
        indeterminate={indeterminate}
        {...props}
      />
      {index != null && (
        <span className={cn("tabular-nums", checkedTextClass(on))}>{index}</span>
      )}
      <span className={cn(checkedTextClass(on), labelClassName)}>{label}</span>
    </label>
  );
}
