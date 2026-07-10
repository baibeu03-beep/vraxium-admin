"use client";

// 공통 확인(Confirm) UI — 데이터가 바뀌는 의사결정 버튼(초기화/저장/완료/삭제/닫기 등)에
//   "한 번 더 확인" 단계를 붙이기 위한 재사용 인프라.
//
//   사용법(명령형 Promise API — 기존 onClick 핸들러에 그대로 끼워넣기 좋음):
//     const confirm = useConfirm();
//     const ok = await confirm(CONFIRM.reset);     // 또는 직접 { title, description, ... }
//     if (!ok) return;                              // 취소 → 입력값 그대로 유지
//     await actuallyDoTheThing();                   // 확인 → 실제 동작
//
//   - window.confirm() 직접 호출을 대체합니다.
//   - 확인 다이얼로그는 기존 모달(z-50) 위에 떠야 하므로 z-[60].
//   - 단순 조회/열기 버튼에는 쓰지 마세요. 실제 데이터가 바뀌는 버튼에만.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Button } from "@/components/ui/button";

export type ConfirmTone = "default" | "destructive";

export type ConfirmOptions = {
  /** 제목(선택). 생략 시 본문만 표시 */
  title?: string;
  /** 본문 안내 문구(필수). 줄바꿈은 \n 으로 */
  description: React.ReactNode;
  /** 확인 버튼 라벨(기본 "확인") */
  confirmLabel?: string;
  /** 취소 버튼 라벨(기본 "취소") */
  cancelLabel?: string;
  /** destructive = 빨강 강조(삭제/초기화 등 되돌릴 수 없는 동작) */
  tone?: ConfirmTone;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

type Pending = ConfirmOptions & { resolve: (result: boolean) => void };

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * 버튼별 표준 안내 문구 프리셋.
 * 동작 라벨이 바뀌어야 하면 confirmLabel/title 을 spread 로 덮어쓰면 됩니다.
 *   await confirm({ ...CONFIRM.complete, confirmLabel: "검수 신청 완료" })
 */
export const CONFIRM = {
  reset: {
    title: "초기화",
    description: "입력한 내용이 초기화됩니다. 초기화하시겠습니까?",
    confirmLabel: "초기화",
    tone: "destructive",
  },
  save: {
    title: "저장",
    description: "입력한 내용을 저장하시겠습니까?",
    confirmLabel: "저장",
  },
  complete: {
    title: "완료",
    description: "완료 처리합니다. 진행하시겠습니까?",
    confirmLabel: "완료",
  },
  checkComplete: {
    title: "체크 완료",
    description: "체크를 완료 처리합니다. 진행하시겠습니까?",
    confirmLabel: "체크 완료",
  },
  delete: {
    title: "삭제",
    description: "삭제한 내용은 되돌릴 수 없습니다. 삭제하시겠습니까?",
    confirmLabel: "삭제",
    tone: "destructive",
  },
  /** 입력값이 있을 때만 띄우세요(없으면 그냥 닫기). */
  close: {
    title: "닫기",
    description: "입력한 내용이 저장되지 않습니다. 닫으시겠습니까?",
    confirmLabel: "닫기",
    tone: "destructive",
  },
} satisfies Record<string, ConfirmOptions>;

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    setPending((cur) => {
      cur?.resolve(result);
      return null;
    });
  }, []);

  // 키보드: Esc = 취소, Enter = 확인.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        settle(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(false);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.title ?? "확인"}
            className="modal-w-sm rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10"
          >
            {pending.title && (
              <h2 className="text-base font-semibold">{pending.title}</h2>
            )}
            <div className="mt-1.5 text-sm whitespace-pre-line text-muted-foreground">
              {pending.description}
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => settle(false)}
              >
                {pending.cancelLabel ?? "취소"}
              </Button>
              <Button
                type="button"
                variant={pending.tone === "destructive" ? "destructive" : "default"}
                size="sm"
                autoFocus
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? "확인"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * 확인 다이얼로그를 띄우는 명령형 함수를 반환.
 * resolve(true) = 확인, resolve(false) = 취소/바깥클릭/Esc.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return ctx;
}
