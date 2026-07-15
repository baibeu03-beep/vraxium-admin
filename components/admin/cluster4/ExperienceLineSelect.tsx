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
//   · 닫힌 트리거는 선택 라인명을 1줄 말줄임(line-clamp-1, 공통 Select). 미선택 시 "라인명".
//   · value=id(안정적 라인 ID=bridged_master_id) — 실제 문자열 "-" 를 값으로 저장하지 않는다.

const VOID = "__none__"; // 보이드 sentinel(→ 저장 null). 공통 Select 가 라벨을 '-' 로 표시.

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
        className={cn("w-full min-w-0", triggerClassName)}
      >
        <SelectValue placeholder="라인명">
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
