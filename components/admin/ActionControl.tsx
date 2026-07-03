"use client";

// ActionControl — 프로젝트 전역 공용 "수동 실행" 버튼 쌍(⚡ 즉시 실행 / ↩ 실행 취소).
//
//   설계 원칙(요구사항):
//     · 버튼명·색상·위치·스타일을 전역에서 통일한다(이 컴포넌트가 유일한 출처).
//     · ⚡ 즉시 실행 = 자동 스케줄러와 "동일한 Action Service"를 호출하는 입구(핸들러 주입).
//     · ↩ 실행 취소 = 직전 단계 복원(step-back). 복원 후 snapshot 재계산은 서비스가 책임.
//     · 운영 모드(mode="operating")에서는 ↩ 전 확인 모달을 반드시 띄운다.
//     · QA 모드(mode="test")도 동일 로직을 쓰되 서버에서 scope 만 test 로 바뀐다.
//     · 복원 불가(irreversible) = ↩ 비활성 + 사유(tooltip). 대상 아님(not-applicable) = ↩ 미노출.
//
//   이 컴포넌트는 표시/입구일 뿐 — 자동 로직을 직접 구현하지 않는다(핸들러로 위임).

import { useCallback, useRef, useState } from "react";
import { Undo2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import type { ActionRollbackClass } from "@/lib/actionControl/registry";

// 전역 통일 라벨(요구사항: 프로젝트 전체에서 동일).
export const ACTION_INSTANT_LABEL = "즉시 실행";
export const ACTION_ROLLBACK_LABEL = "실행 취소";

export type ActionControlMode = "operating" | "test";

export type ActionControlProps = {
  /** ⚡ 실행 핸들러(자동과 동일한 Action Service 호출). hideInstant 면 생략 가능. */
  onInstant?: () => void | Promise<void>;
  /** ↩ 실행 취소 핸들러(직전 단계 복원). class 가 reversible/partial 일 때만 호출된다. */
  onRollback?: () => void | Promise<void>;

  /** 직전 단계 복원 분류(레지스트리에서 주입). */
  rollbackClass: ActionRollbackClass;
  /** 복원 불가/부분 사유(비활성 tooltip / 확인 문구 보조). */
  rollbackReason?: string | null;

  /** 상태 기반 ↩ 비활성(class 는 reversible 이지만 지금은 되돌릴 게 없을 때 — 예: 아직 실행 전). */
  rollbackDisabled?: boolean;
  /** rollbackDisabled 사유(비활성 tooltip). 예: "아직 실행되지 않았습니다." */
  rollbackDisabledReason?: string | null;

  /** 라벨 앞에 붙는 동작명 — "⚡ {actionLabel} 즉시 실행" / "↩ {actionLabel} 취소". 생략 시 기본 라벨만. */
  actionLabel?: string;

  /** 운영/테스트 모드 — operating 이면 ↩ 전 확인 모달 필수. */
  mode?: ActionControlMode;

  /** ⚡ 실행 전 확인 문구(주면 확인 모달을 띄움). 없으면 바로 실행. */
  instantConfirmDescription?: React.ReactNode;
  /** ↩ 실행 취소 확인 문구(운영 모드에서 기본 문구 대신 사용). */
  rollbackConfirmDescription?: React.ReactNode;

  /** 외부에서 busy 상태를 관리할 때. 미지정 시 내부에서 관리. */
  instantBusy?: boolean;
  rollbackBusy?: boolean;

  /** ⚡ 버튼만 숨김(같은 액션의 ↩ 만 렌더할 때 — 상태별로 ⚡/↩ 가 배타적인 표). */
  hideInstant?: boolean;
  /** ↩ 버튼만 숨김(⚡ 만 렌더). */
  hideRollback?: boolean;
  /** 상태 기반 ⚡ 비활성 + 사유(tooltip). */
  instantDisabled?: boolean;
  instantDisabledReason?: string | null;

  /** 버튼 크기(Button size 와 동일). */
  size?: "xs" | "sm" | "default" | "lg";
  /** 전체 비활성. */
  disabled?: boolean;
  /** 래퍼 className. */
  className?: string;
};

// 내부 busy 관리 훅 — 외부 busy 가 주어지면 그걸 우선한다(중복 클릭은 inFlight ref 로 이중 차단).
function useMaybeBusy(external?: boolean) {
  const [internal, setInternal] = useState(false);
  const inFlight = useRef(false);
  const busy = external ?? internal;

  const guard = useCallback(
    async (fn: () => void | Promise<void>) => {
      if (inFlight.current) return; // 상태 경합 방지
      inFlight.current = true;
      if (external === undefined) setInternal(true);
      try {
        await fn();
      } finally {
        inFlight.current = false;
        if (external === undefined) setInternal(false);
      }
    },
    [external],
  );

  return { busy, guard };
}

export function ActionControl({
  onInstant,
  onRollback,
  rollbackClass,
  rollbackReason,
  rollbackDisabled = false,
  rollbackDisabledReason,
  hideInstant = false,
  hideRollback = false,
  instantDisabled = false,
  instantDisabledReason,
  actionLabel,
  mode = "operating",
  instantConfirmDescription,
  rollbackConfirmDescription,
  instantBusy,
  rollbackBusy,
  size = "sm",
  disabled = false,
  className,
}: ActionControlProps) {
  const confirm = useConfirm();
  const instant = useMaybeBusy(instantBusy);
  const rollback = useMaybeBusy(rollbackBusy);

  const anyBusy = instant.busy || rollback.busy;

  const instantText = actionLabel ? `${actionLabel} ${ACTION_INSTANT_LABEL}` : ACTION_INSTANT_LABEL;
  const rollbackText = actionLabel ? `${actionLabel} ${ACTION_ROLLBACK_LABEL}` : ACTION_ROLLBACK_LABEL;

  const handleInstant = useCallback(() => {
    if (!onInstant) return;
    void instant.guard(async () => {
      if (instantConfirmDescription) {
        const ok = await confirm({
          title: instantText,
          description: instantConfirmDescription,
          confirmLabel: `⚡ ${ACTION_INSTANT_LABEL}`,
          cancelLabel: "취소",
        });
        if (!ok) return;
      }
      await onInstant();
    });
  }, [confirm, instant, instantConfirmDescription, instantText, onInstant]);

  const handleRollback = useCallback(() => {
    if (!onRollback) return;
    void rollback.guard(async () => {
      // 실행 취소 표준 확인 문구(전역 통일). 운영/테스트 공통 필수.
      //   partial(조건부 복원) Action 은 사유를 '주의:'로 덧붙인다.
      const ok = await confirm({
        title: rollbackText,
        description:
          rollbackConfirmDescription ??
          `이 작업을 실행하기 전 상태로 되돌립니다.\n\n이 작업으로 변경된 내용도 함께 이전 상태로 복원됩니다.${
            rollbackClass === "partial" && rollbackReason ? `\n\n주의: ${rollbackReason}` : ""
          }\n\n계속하시겠습니까?`,
        confirmLabel: `↩ ${ACTION_ROLLBACK_LABEL}`,
        cancelLabel: "취소",
        tone: "destructive",
      });
      if (!ok) return;
      await onRollback();
    });
  }, [
    confirm,
    rollback,
    onRollback,
    rollbackText,
    rollbackConfirmDescription,
    rollbackClass,
    rollbackReason,
  ]);

  // not-applicable → ↩ 미노출. hideRollback → ↩ 미노출. hideInstant → ⚡ 미노출.
  const showRollback = !hideRollback && rollbackClass !== "not-applicable";
  const showInstant = !hideInstant;
  // irreversible(정책) 또는 상태 기반(rollbackDisabled) → ↩ 비활성 + 사유.
  const rollbackDisabledByClass = rollbackClass === "irreversible";
  const rollbackIsDisabled = rollbackDisabledByClass || rollbackDisabled;
  const rollbackDisabledText = rollbackDisabledByClass
    ? rollbackReason
    : rollbackDisabled
      ? rollbackDisabledReason ?? null
      : null;

  return (
    <div className={cn("inline-flex items-center gap-2", className)} data-action-control data-mode={mode}>
      {/* ⚡ 즉시 실행 — variant=default(primary), 전역 통일. */}
      {showInstant && (
        <Button
          type="button"
          variant="default"
          size={size}
          loading={instant.busy}
          disabled={disabled || instantDisabled || anyBusy || !onInstant}
          onClick={handleInstant}
          title={instantDisabled ? instantDisabledReason ?? undefined : undefined}
          aria-disabled={instantDisabled || undefined}
        >
          {!instant.busy && <Zap aria-hidden />}
          {instantText}
        </Button>
      )}

      {/* ↩ 실행 취소 — variant=destructive(빨강), 전역 통일. */}
      {showRollback && (
        <Button
          type="button"
          variant="destructive"
          size={size}
          loading={rollback.busy}
          disabled={disabled || rollbackIsDisabled || anyBusy || !onRollback}
          onClick={handleRollback}
          title={rollbackIsDisabled ? rollbackDisabledText ?? "되돌릴 수 없는 작업입니다." : undefined}
          aria-disabled={rollbackIsDisabled || undefined}
        >
          {!rollback.busy && <Undo2 aria-hidden />}
          {rollbackText}
        </Button>
      )}

      {/* 비활성 사유 인라인 표시(irreversible 정책 사유만 — 상태 기반은 tooltip 으로 충분). */}
      {showRollback && rollbackDisabledByClass && rollbackReason && (
        <span className="max-w-[22rem] text-xs text-muted-foreground">{rollbackReason}</span>
      )}
    </div>
  );
}
