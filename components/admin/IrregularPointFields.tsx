"use client";

// 변동 액트 포인트 입력 UI — 액트 종류(전원/부분) × 포인트 방식(A+B 부여 / C 부여) 규칙 적용.
//   전원(all)    : 포인트 방식 UI 숨김 · A/B/C 모두 활성(해당자 A+B / 미해당자 C).
//   부분(partial): 포인트 방식 라디오 노출.
//        A+B 부여 → A/B 활성 · C 비활성(흐림·cursor-not-allowed) + 안내문.
//        C 부여   → C 활성 · A/B 비활성(흐림) + 안내문.
//   포인트 방식 변경 시 입력값이 있으면 확인 모달 후 초기화(취소/변경). 저장값 정규화는 서버 SoT 가 최종 강제.

import { useEffect } from "react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  IRREGULAR_POINT_MODES,
  IRREGULAR_POINT_MODE_LABEL,
  type IrregularCrewReaction,
  type IrregularPointMode,
} from "@/lib/adminProcessIrregularTypes";

const POINTS = Array.from({ length: 21 }, (_, i) => i); // 0~20

export function IrregularPointFields({
  crewReaction,
  pointMode,
  setPointMode,
  pointA,
  setPointA,
  pointB,
  setPointB,
  pointC,
  setPointC,
  disabled,
}: {
  crewReaction: IrregularCrewReaction;
  pointMode: IrregularPointMode;
  setPointMode: (m: IrregularPointMode) => void;
  pointA: number;
  setPointA: (n: number) => void;
  pointB: number;
  setPointB: (n: number) => void;
  pointC: number;
  setPointC: (n: number) => void;
  disabled?: boolean;
}) {
  const confirm = useConfirm();
  const isPartial = crewReaction === "partial";
  // 비활성 규칙 — 전원은 모두 활성. 부분은 방식에 따라 A/B 또는 C 비활성.
  const abLocked = isPartial && pointMode === "c";
  const cLocked = isPartial && pointMode === "ab";

  // 비활성 칸은 항상 0 으로 강제(표시·전송 일관성). 전원↔부분/방식 전환 시 자동 정리.
  useEffect(() => {
    if (!isPartial) return;
    if (pointMode === "ab") setPointC(0);
    else {
      setPointA(0);
      setPointB(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crewReaction, pointMode]);

  // 포인트 방식 변경 — 입력값이 있으면 확인 모달 후 초기화.
  const changeMode = async (next: IrregularPointMode) => {
    if (next === pointMode || disabled) return;
    const hasInput = pointA !== 0 || pointB !== 0 || pointC !== 0;
    if (hasInput) {
      const ok = await confirm({
        title: "포인트 방식 변경",
        description: "포인트 방식을 변경하면 현재 입력값이 초기화됩니다.\n계속하시겠습니까?",
        confirmLabel: "변경",
        cancelLabel: "취소",
        tone: "destructive",
      });
      if (!ok) return;
    }
    setPointA(0);
    setPointB(0);
    setPointC(0);
    setPointMode(next);
  };

  const fields = [
    ["포인트 A", pointA, setPointA, abLocked] as const,
    ["포인트 B", pointB, setPointB, abLocked] as const,
    ["포인트 C", pointC, setPointC, cLocked] as const,
  ];

  return (
    <div className="space-y-2">
      {isPartial && (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            포인트 방식 <span className="text-red-500">*</span>
          </label>
          <div className="flex gap-2">
            {IRREGULAR_POINT_MODES.map((m) => (
              <label
                key={m}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm",
                  disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                  pointMode === m ? "border-primary bg-primary/5 font-medium text-foreground" : "border-input",
                )}
              >
                <input
                  type="radio"
                  name="irregular-point-mode"
                  value={m}
                  checked={pointMode === m}
                  onChange={() => void changeMode(m)}
                  disabled={disabled}
                  className="accent-primary"
                />
                {IRREGULAR_POINT_MODE_LABEL[m]}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {fields.map(([label, val, set, locked]) => (
          <div key={label} className="space-y-1">
            <label className={cn("text-xs", locked ? "text-muted-foreground/40" : "text-muted-foreground")}>{label}</label>
            <select
              aria-label={label}
              value={val}
              onChange={(e) => set(Number(e.target.value))}
              disabled={disabled || locked}
              title={locked ? "현재 포인트 방식에서는 사용할 수 없습니다" : undefined}
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
          </div>
        ))}
      </div>

      {isPartial && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] whitespace-pre-line text-amber-700">
          {pointMode === "ab"
            ? "현재 A+B 부여 모드입니다.\n포인트 C는 사용할 수 없습니다."
            : "현재 C 부여 모드입니다.\n포인트 A/B는 사용할 수 없습니다."}
        </p>
      )}
    </div>
  );
}
