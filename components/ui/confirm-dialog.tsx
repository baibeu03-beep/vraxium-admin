"use client";

// 공통 확인(Confirm) — 하위호환 얇은 어댑터.
//
//   이 파일은 이제 자체 다이얼로그를 렌더하지 않는다. 실제 구현은 어드민 전역 단일 인프라
//   components/ui/admin-dialog.tsx(adminDialog store + <AdminDialogViewport/>)로 수렴했다.
//   기존 21개 파일이 쓰던 useConfirm()/CONFIRM/ConfirmOptions API 를 그대로 유지하기 위해
//   adminDialog.confirm 에 위임하는 shim 만 남긴다(tone → variant 매핑).
//
//   신규 코드는 adminDialog.{alert,confirm,prompt,open} 을 직접 사용하세요.
//   (이 shim 은 기존 호출부 무수정 유지를 위한 것.)

import { adminDialog } from "@/components/ui/admin-dialog";

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

/**
 * 버튼별 표준 안내 문구 프리셋.
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

/**
 * ConfirmProvider — 하위호환 passthrough. 실제 렌더는 <AdminDialogViewport/> 가 담당하므로
 * 여기서는 자식만 그대로 렌더한다(layout 의 기존 import/JSX 무수정 유지용).
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * 확인 다이얼로그를 띄우는 명령형 함수를 반환. resolve(true)=확인, resolve(false)=취소/ESC/바깥.
 * 내부적으로 adminDialog.confirm 에 위임한다(tone:"destructive" → variant:"danger").
 */
export function useConfirm(): ConfirmFn {
  return (opts: ConfirmOptions) =>
    adminDialog.confirm({
      variant: opts.tone === "destructive" ? "danger" : "default",
      title: opts.title,
      description: opts.description,
      confirmLabel: opts.confirmLabel,
      cancelLabel: opts.cancelLabel,
    });
}
