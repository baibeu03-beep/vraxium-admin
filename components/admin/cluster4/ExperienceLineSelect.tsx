"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { PartInputLineOption } from "@/lib/experiencePartInputTypes";

// 실무 경험 라인명 드롭다운(개설 신청·검수 공용).
//   · 항상 '-'(보이드) 옵션 제공 — 라인 미선택 상태. onChange(null) 로 전달·저장은 null.
//   · 긴 라인명은 팝업에서 2~3줄로 자연 줄바꿈(단어 중간 자르지 않음), 팝업 폭은 트리거보다
//     넓어질 수 있고 viewport 를 넘지 않는다 — 공통 Select(드롭다운 폭/높이 SoT) 그대로 사용.
//   · 닫힌 트리거도 말줄임(…) 없이 2~3줄까지 자연 줄바꿈해 라인명 전체를 노출한다 — 라인명은
//     사용자가 식별해야 하는 핵심 정보. 높이는 내용에 맞춰 늘어난다. 미선택 시 "라인명".
//   · value=id(안정적 라인 ID=bridged_master_id) — 실제 문자열 "-" 를 값으로 저장하지 않는다.

const VOID = "__none__"; // 보이드 sentinel(→ 저장 null). 공통 Select 가 라벨을 '-' 로 표시.

// 라인명 Select 트리거 폭 SoT(개설 신청·검수·완료 공용, 이후 다른 관리자 화면도 재사용).
//   · 닫힌 트리거에서 라인명이 대부분 한눈에 읽히도록 충분히 넓힌다(≈272~336px).
//   · min-w 로 컬럼 최소폭을 확보하고, max-w 로 과도한 확장을 막는다(넘치면 다음 줄로 줄바꿈).
//   · 개별 호출에서 triggerClassName 으로 덮어쓸 수 있으나(공통 cn=twMerge), 기본은 이 값.
export const EXPERIENCE_LINE_SELECT_WIDTH = "min-w-[17rem] max-w-[21rem]";

// 닫힌 트리거를 다중 줄(2~3줄)로 허용하는 SoT.
//   · whitespace-normal: 공통 트리거 root 의 whitespace-nowrap 을 덮어 줄바꿈 허용(자식 값은
//     white-space 상속). h-auto/min-h-8: 고정 h-8 대신 내용 높이(1줄이면 그대로 8, 넘치면 증가).
//   · items-start: 다중 줄일 때 값·화살표를 상단 정렬. break-words: 단어 중간 잘림 방지.
//   · SelectValue 의 line-clamp-none!: 공통 트리거가 값 span 에 descendant 로 건 line-clamp-1
//     (…말줄임)을 무력화 — 같은 요소를 겨냥한 더 높은 명시도라 important 로만 이긴다.
const TRIGGER_MULTILINE =
  "h-auto min-h-8 items-start whitespace-normal break-words data-[size=sm]:h-auto";
const VALUE_MULTILINE = "line-clamp-none! whitespace-normal break-words";

export default function ExperienceLineSelect({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  triggerClassName,
}: {
  value: string | null;
  options: PartInputLineOption[];
  onChange: (id: string | null) => void;
  disabled?: boolean;
  ariaLabel?: string;
  triggerClassName?: string;
}) {
  // null(미선택) → VOID sentinel. 트리거는 placeholder 대신 "라인명" 을 노출한다.
  const current = value ?? VOID;
  return (
    <Select
      value={current}
      onValueChange={(v: unknown) =>
        onChange(v == null || v === VOID ? null : String(v))
      }
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label={ariaLabel}
        className={cn(
          "w-full min-w-0",
          EXPERIENCE_LINE_SELECT_WIDTH,
          TRIGGER_MULTILINE,
          triggerClassName,
        )}
      >
        <SelectValue placeholder="라인명" className={VALUE_MULTILINE}>
          {(v: unknown) => {
            if (v == null || v === VOID || v === "") return "라인명";
            const opt = options.find((o) => o.id === v);
            return opt ? opt.lineName : String(v);
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {/* 보이드('-') — 라인 미선택. 항상 최상단. */}
        <SelectItem value={VOID}>-</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.lineName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
