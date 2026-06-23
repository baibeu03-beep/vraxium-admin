"use client";

// 변동 액트 포인트 입력 UI — 액트 종류(전원/부분)에 따른 A/B/C 입력 규칙.
//   전원(all)    : A/B/C 모두 활성(독립 입력).
//   부분(partial): A 또는 B 입력 시 C 비활성 · C 입력 시 A/B 비활성(택1).
//        각 포인트 옆 [X] 초기화 버튼 — A·B 를 모두 0 으로 초기화해야 C 입력 가능,
//        C 를 0 으로 초기화해야 A/B 입력 가능. (포인트 방식은 값에서 파생 — 별도 라디오 없음)
//   ⚠ 최종 저장값 정규화(ab→C=0 / c→A=B=0)는 서버 normalizeIrregularPoints 가 단일 SoT 로 강제.

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IrregularCrewReaction } from "@/lib/adminProcessIrregularTypes";

const POINTS = Array.from({ length: 21 }, (_, i) => i); // 0~20

// 부분 액트에서 현재 입력값으로부터 포인트 방식(ab|c)을 파생 — 제출 시 서버로 전달.
//   C>0 → "c", 그 외 → "ab"(기본). 전원은 무관(서버 무시).
export function derivePartialPointMode(pointC: number): "ab" | "c" {
  return pointC > 0 ? "c" : "ab";
}

export function IrregularPointFields({
  crewReaction,
  pointA,
  setPointA,
  pointB,
  setPointB,
  pointC,
  setPointC,
  disabled,
}: {
  crewReaction: IrregularCrewReaction;
  pointA: number;
  setPointA: (n: number) => void;
  pointB: number;
  setPointB: (n: number) => void;
  pointC: number;
  setPointC: (n: number) => void;
  disabled?: boolean;
}) {
  const isPartial = crewReaction === "partial";
  // 부분 — A/B 에 값이 있으면 C 잠금, C 에 값이 있으면 A/B 잠금.
  const abHasValue = pointA > 0 || pointB > 0;
  const cHasValue = pointC > 0;
  const abLocked = isPartial && cHasValue;
  const cLocked = isPartial && abHasValue;

  const fields: Array<readonly [string, number, (n: number) => void, boolean, () => void]> = [
    ["포인트 A", pointA, setPointA, abLocked, () => setPointA(0)],
    ["포인트 B", pointB, setPointB, abLocked, () => setPointB(0)],
    [
      "포인트 C",
      pointC,
      setPointC,
      cLocked,
      () => setPointC(0),
    ],
  ];

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-3">
        {fields.map(([label, val, set, locked, reset]) => (
          <div key={label} className="space-y-1">
            <label className={cn("text-xs", locked ? "text-muted-foreground/40" : "text-muted-foreground")}>
              {label}
            </label>
            <div className="flex items-center gap-1">
              <select
                aria-label={label}
                value={val}
                onChange={(e) => set(Number(e.target.value))}
                disabled={disabled || locked}
                title={locked ? "다른 포인트를 초기화(X)해야 입력할 수 있습니다" : undefined}
                className={cn(
                  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm",
                  locked
                    ? "cursor-not-allowed bg-muted/60 text-muted-foreground/40"
                    : "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {POINTS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              {/* X 초기화 — 부분 액트에서만 노출. 해당 칸을 0 으로(잠금 해제 트리거) */}
              {isPartial && (
                <button
                  type="button"
                  aria-label={`${label} 초기화`}
                  title={`${label} 초기화`}
                  disabled={disabled || val === 0}
                  onClick={reset}
                  className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {isPartial && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] whitespace-pre-line text-amber-700">
          {cHasValue
            ? "현재 C 부여 상태입니다.\nC를 초기화(X)해야 포인트 A/B를 입력할 수 있습니다."
            : abHasValue
              ? "현재 A+B 부여 상태입니다.\nA·B를 모두 초기화(X)해야 포인트 C를 입력할 수 있습니다."
              : "부분 액트는 A+B 또는 C 중 한쪽만 부여합니다.\n한쪽을 입력하면 다른 쪽은 자동 잠깁니다."}
        </p>
      )}
    </div>
  );
}
