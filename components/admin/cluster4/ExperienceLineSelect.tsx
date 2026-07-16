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
//     넓게(min-w-[280px]) 유지해 라인명을 읽기 좋게 한다 — 트리거를 좁혀도 목록은 좁아지지 않는다.
//   · 닫힌 트리거는 컴팩트(180px)하게 유지하되, 선택값은 최대 3줄까지 줄바꿈(line-clamp-3)해
//     라인명을 식별할 수 있게 한다 — 셀 밖으로 넘치지 않고 행 높이도 과도하게 커지지 않는다.
//   · value=id(안정적 라인 ID=bridged_master_id) — 실제 문자열 "-" 를 값으로 저장하지 않는다.

const VOID = "__none__"; // 보이드 sentinel(→ 저장 null). 공통 Select 가 라벨을 '-' 로 표시.

// 라인명 Select 트리거 폭 SoT(개설 신청·검수·완료 공용, 이후 다른 관리자 화면도 재사용).
//   · 트리거는 셀(열) 폭을 가득 채운다(w-full) — 표는 table-fixed + colgroup 으로 열폭이 고정돼 있어
//     트리거가 표를 넓히지 않으며, 재조정한 열폭만큼 라인명이 더 넓게(3줄 클램프) 보인다.
//   · 긴 라인명은 최대 3줄로 줄바꿈(아래 VALUE_MULTILINE) — 셀 밖으로 넘치지 않고 행 높이도 과하지 않다.
//   · 개별 호출에서 triggerClassName 으로 덮어쓸 수 있다(공통 cn=twMerge).
export const EXPERIENCE_LINE_SELECT_WIDTH = "w-full min-w-0";

// 라인명 Select 펼친 목록(팝업) 폭 SoT.
//   · 트리거는 좁혀도(180px) 목록은 넓게(min 280px) 유지해 긴 라인명을 읽기 좋게 한다.
//   · 공통 Select 의 min-w-(--anchor-width)(=트리거 폭 앵커)를 이 값으로 덮는다 — 전역 정책은 불변.
const CONTENT_WIDTH = "min-w-[280px] max-w-[420px]";

// 닫힌 트리거를 다중 줄(2~3줄)로 허용하는 SoT.
//   · whitespace-normal: 공통 트리거 root 의 whitespace-nowrap 을 덮어 줄바꿈 허용(자식 값은
//     white-space 상속). h-auto/min-h-8: 고정 h-8 대신 내용 높이(1줄이면 그대로 8, 넘치면 증가).
//   · items-start: 다중 줄일 때 값·화살표를 상단 정렬. break-words: 단어 중간 잘림 방지.
//   · SelectValue 의 line-clamp-3! + leading-5: 공통 트리거가 값 span 에 descendant 로 건
//     line-clamp-1 을 무력화하고 최대 3줄로 캡한다 — 같은 요소를 겨냥한 더 높은 명시도라
//     important 로만 이긴다. leading-5 로 3줄이어도 행 높이가 과하게 커지지 않는다.
const TRIGGER_MULTILINE =
  "h-auto min-h-8 items-start whitespace-normal break-words data-[size=sm]:h-auto";
const VALUE_MULTILINE = "line-clamp-3! whitespace-normal break-words leading-5";

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
      <SelectContent className={CONTENT_WIDTH}>
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
