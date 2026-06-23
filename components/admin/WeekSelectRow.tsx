"use client";

// 공용 주차 선택 행 — 라벨·드롭다운·날짜 범위·상태 배지를 한 줄에 세로 중앙 정렬.
//   프로세스 체크(info/club/experience/competency) + 변동 액트(irregular) 공용 SoT.
//   정책: 현재 주차 기본 선택 · 미래 주차 미노출 · 과거 주차 조회 전용(editable=false).
//   드롭다운 표기 = "26년 봄 시즌 17주차 (현재)" (periodLabel = processCheckLogPeriodLabel).
//
// ⚠ 표시 전용(presentational) — 데이터/상태는 부모가 소유. value/onChange 로 제어한다.

import { cn } from "@/lib/utils";
import type { ProcessWeekOptionDto } from "@/lib/adminProcessCheckTypes";

export function WeekSelectRow({
  weeks,
  selectedWeekId,
  editable,
  value,
  onChange,
  disabled,
  selectId = "week-select",
}: {
  weeks: ProcessWeekOptionDto[];
  selectedWeekId: string | null;
  editable: boolean; // 선택 주차 == 현재 주차(쓰기 가능) 여부
  value: string; // 제어 select 값(weekId 또는 "")
  onChange: (weekId: string | null) => void;
  disabled?: boolean; // 예: org 미지정
  selectId?: string; // 페이지별 고유 id
}) {
  const selectedOption = weeks.find((w) => w.weekId && w.weekId === selectedWeekId) ?? null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor={selectId} className="shrink-0 text-xs text-muted-foreground">
        주차 선택
      </label>
      <select
        id={selectId}
        aria-label="주차 선택"
        value={value}
        disabled={disabled || weeks.length === 0}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-9 min-w-[200px] rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
      >
        {weeks.length === 0 && <option value="">주차 정보 없음</option>}
        {weeks.map((w) => (
          <option key={w.weekId ?? w.weekNumber} value={w.weekId ?? ""} disabled={!w.weekId}>
            {w.periodLabel}
            {w.isCurrent ? " (현재)" : ""}
          </option>
        ))}
      </select>
      {selectedOption && (
        <>
          <span className="rounded-md border bg-muted/40 px-2.5 py-1 text-sm tabular-nums text-muted-foreground">
            ({selectedOption.startDate} ~ {selectedOption.endDate})
          </span>
          <span
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium",
              selectedOption.isOfficialRest
                ? "border-slate-300 bg-slate-100 text-slate-600"
                : "border-emerald-300 bg-emerald-50 text-emerald-700",
            )}
          >
            {selectedOption.statusLabel}
          </span>
          {!editable && (
            <span className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
              조회 전용 (현재 주차만 등록/취소 가능)
            </span>
          )}
        </>
      )}
    </div>
  );
}
