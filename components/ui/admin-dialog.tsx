"use client";

// 공통 커스텀 다이얼로그(adminDialog) — 브라우저 시스템 팝업(window.alert/confirm/prompt)과
//   페이지별 임시 확인 오버레이를 대체하는 어드민 전역 단일 인프라.
//
//   왜 필요한가: 시스템 팝업은 디자인/다크테마/접근성/모바일 대응이 불가능하고 동기 blocking이라
//   비동기 로딩 상태를 줄 수 없다. 페이지마다 useState+오버레이로 확인창을 재구현하면 접근성
//   (focus trap·포커스 복귀·스크롤 잠금)과 동작이 제각각이 된다. 이 파일 하나로 수렴한다.
//
//   구조(components/ui/toast.tsx 와 동일한 모듈 store + 포털 패턴):
//     - 모듈 레벨 store(pub/sub) — 어디서든 adminDialog.* 로 발행(React 트리 밖에서도 호출 가능).
//     - <AdminDialogViewport /> — createPortal 로 document.body 에 렌더. Layout 한 곳에만 마운트.
//     - adminDialog — 명령형 Promise API(사용자 예시 그대로):
//         await adminDialog.alert({ variant:"success", title:"저장 완료" });
//         const ok = await adminDialog.confirm({ variant:"danger", title:"삭제?", confirmLabel:"삭제" });
//         const v  = await adminDialog.prompt({ title:"사유", input:{ maxLength:50 } });   // 취소=null
//         const r  = await adminDialog.open({ variant:"custom", content:<X/> });           // 커스텀 주입
//
//   접근성(모든 variant 공통): focus trap · 최초 포커스 · ESC · role/aria-modal/labelledby ·
//   호출 버튼 포커스 복귀 · 배경 스크롤 잠금 · 중복 클릭 방지 · 비동기 로딩 스피너 ·
//   모바일 폭(modal-w-*=min(92vw,…)) · 긴 본문 스크롤.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button, type buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

export type AdminDialogVariant =
  | "default"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "form"
  | "custom";

export type AdminDialogWidth = "sm" | "md" | "lg" | "xl" | "2xl";

/** 커스텀 content 가 스스로 다이얼로그를 종료하고 값을 반환할 때 사용하는 핸들. */
export type AdminDialogApi<T = unknown> = {
  /** 값을 반환하고 닫는다(open() 의 Promise 가 이 값으로 resolve). */
  resolve: (value: T) => void;
  /** 취소로 닫는다(open() → undefined). */
  close: () => void;
};

type BaseOpts = {
  variant?: AdminDialogVariant;
  title?: string;
  /** 본문. 문자열/ReactNode 모두 가능(줄바꿈은 \n). */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 패널 폭(globals.css @utility modal-w-*). 미지정 시 variant 기본값. */
  width?: AdminDialogWidth;
  /** ESC·X 로 닫기 허용(기본 true). false 면 반드시 버튼으로만 종료. */
  dismissible?: boolean;
  /** 바깥(오버레이) 클릭으로 닫기(기본: variant 별 — danger/form/custom=false). */
  dismissOnOutside?: boolean;
  /** 우상단 X 버튼 노출(기본 true, dismissible=false 면 무시). */
  showClose?: boolean;
  /** 버튼 좌우 순서 뒤집기(기본 [취소, 확인]). */
  reverseButtons?: boolean;
  /** 확인 버튼 색 override(기본: variant 별 — danger=destructive, 그 외 default). */
  confirmVariant?: ButtonVariant;
  /** 헤더 아이콘 override(기본: variant 별). null 이면 아이콘 숨김. */
  icon?: LucideIcon | null;
  /**
   * 확인 클릭 시 실행할 비동기 작업. 주어지면 그동안 확인 버튼에 스피너 + 전체 버튼 disabled
   * (중복 제출 차단). 성공 resolve 후 닫힘, throw 시 열린 채 복구(에러 처리는 호출부).
   * prompt 의 경우 현재 입력값을 인자로 받는다.
   */
  onConfirm?: (value: string) => void | Promise<void>;
};

export type AlertOptions = Omit<BaseOpts, "reverseButtons">;
export type ConfirmOptions = BaseOpts;
export type PromptOptions = BaseOpts & {
  input?: {
    label?: string;
    placeholder?: string;
    defaultValue?: string;
    maxLength?: number;
    /** 여러 줄 입력(textarea). */
    multiline?: boolean;
    /** 빈 값이면 확인 비활성화. */
    required?: boolean;
  };
};
export type OpenOptions<T = unknown> = BaseOpts & {
  variant?: AdminDialogVariant;
  /** 완전 커스텀 본문. 함수형이면 { resolve, close } 를 받아 스스로 종료할 수 있다. */
  content: ReactNode | ((api: AdminDialogApi<T>) => ReactNode);
};

type DialogKind = "alert" | "confirm" | "prompt" | "custom";

type DialogRequest = BaseOpts & {
  id: string;
  kind: DialogKind;
  input?: PromptOptions["input"];
  content?: OpenOptions["content"];
  resolve: (value: unknown) => void;
  /** 열릴 때 포커스를 갖고 있던 요소(닫힌 뒤 포커스 복귀 대상). */
  trigger: HTMLElement | null;
};

// ── 모듈 레벨 store ────────────────────────────────────────────────────────
let stack: DialogRequest[] = [];
const listeners = new Set<() => void>();
let counter = 0;

function emit() {
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function getSnapshot() {
  return stack;
}
const EMPTY: DialogRequest[] = [];
function getServerSnapshot() {
  return EMPTY;
}

function captureTrigger(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const el = document.activeElement;
  return el instanceof HTMLElement ? el : null;
}

function pushRequest(req: DialogRequest) {
  stack = [...stack, req];
  emit();
}

/** 다이얼로그를 종료하고 결과로 resolve. 포커스 복귀는 패널 unmount 시 처리. */
function settle(id: string, result: unknown) {
  const req = stack.find((r) => r.id === id);
  if (!req) return;
  req.resolve(result);
  stack = stack.filter((r) => r.id !== id);
  emit();
}

// ── 명령형 API ─────────────────────────────────────────────────────────────
export const adminDialog = {
  /** 단순 안내(확인 버튼 1개). variant 로 성격 표현. */
  alert(opts: AlertOptions): Promise<void> {
    return new Promise<void>((resolve) => {
      pushRequest({
        id: `dlg${++counter}`,
        kind: "alert",
        trigger: captureTrigger(),
        resolve: () => resolve(),
        ...opts,
      });
    });
  },
  /** 확인/취소. 확인=true, 취소·ESC·바깥·X=false. */
  confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      pushRequest({
        id: `dlg${++counter}`,
        kind: "confirm",
        trigger: captureTrigger(),
        resolve: (v) => resolve(v === true),
        ...opts,
      });
    });
  },
  /** 입력. 확인=문자열, 취소·ESC·바깥·X=null. */
  prompt(opts: PromptOptions): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      pushRequest({
        id: `dlg${++counter}`,
        kind: "prompt",
        trigger: captureTrigger(),
        resolve: (v) => resolve(typeof v === "string" ? v : null),
        variant: opts.variant ?? "form",
        ...opts,
      });
    });
  },
  /** 완전 커스텀 content 주입. content 가 api.resolve(value) 로 값 반환. */
  open<T = unknown>(opts: OpenOptions<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      pushRequest({
        id: `dlg${++counter}`,
        kind: "custom",
        trigger: captureTrigger(),
        resolve: (v) => resolve(v as T | undefined),
        variant: opts.variant ?? "custom",
        ...opts,
      });
    });
  },
};

// ── variant 스펙 ────────────────────────────────────────────────────────────
type VariantConfig = {
  icon: LucideIcon | null;
  /** 아이콘 원형 배경/글자색. */
  accent: string;
  confirmVariant: ButtonVariant;
  width: AdminDialogWidth;
  dismissOnOutside: boolean;
};

const VARIANTS: Record<AdminDialogVariant, VariantConfig> = {
  default: { icon: null, accent: "", confirmVariant: "default", width: "sm", dismissOnOutside: true },
  info: {
    icon: Info,
    accent: "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400",
    confirmVariant: "default",
    width: "sm",
    dismissOnOutside: true,
  },
  success: {
    icon: CheckCircle2,
    accent: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
    confirmVariant: "default",
    width: "sm",
    dismissOnOutside: true,
  },
  warning: {
    icon: TriangleAlert,
    accent: "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
    confirmVariant: "default",
    width: "sm",
    dismissOnOutside: true,
  },
  danger: {
    icon: AlertCircle,
    accent: "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400",
    confirmVariant: "destructive",
    width: "sm",
    dismissOnOutside: false,
  },
  form: { icon: null, accent: "", confirmVariant: "default", width: "md", dismissOnOutside: false },
  custom: { icon: null, accent: "", confirmVariant: "default", width: "md", dismissOnOutside: false },
};

const WIDTH_CLASS: Record<AdminDialogWidth, string> = {
  sm: "modal-w-sm",
  md: "modal-w-md",
  lg: "modal-w-lg",
  xl: "modal-w-xl",
  "2xl": "modal-w-2xl",
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// ── 개별 다이얼로그 패널 ─────────────────────────────────────────────────────
function DialogPanel({ req, isTop }: { req: DialogRequest; isTop: boolean }) {
  const cfg = VARIANTS[req.variant ?? "default"];
  const Icon = req.icon === undefined ? cfg.icon : req.icon;
  const confirmVariant = req.confirmVariant ?? cfg.confirmVariant;
  const width = req.width ?? cfg.width;
  const dismissible = req.dismissible ?? true;
  const dismissOnOutside = req.dismissOnOutside ?? cfg.dismissOnOutside;
  const showClose = (req.showClose ?? true) && dismissible;

  const isCustom = req.kind === "custom";
  const isPrompt = req.kind === "prompt";
  const hasCancel = req.kind === "confirm" || isPrompt;

  const panelRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [value, setValue] = useState(req.input?.defaultValue ?? "");

  const titleId = useId();
  const descId = useId();

  // 종료(취소값)로 닫기 — dismiss(ESC/바깥/X/취소). kind 별 기본 취소값.
  const cancel = useCallback(() => {
    if (submitting) return;
    settle(req.id, req.kind === "confirm" ? false : req.kind === "prompt" ? null : undefined);
  }, [req.id, req.kind, submitting]);

  // 확인 클릭 — onConfirm 있으면 비동기 로딩 후 종료.
  const confirm = useCallback(async () => {
    if (submitting) return;
    const result: unknown =
      req.kind === "confirm" ? true : req.kind === "prompt" ? value : undefined;
    if (req.onConfirm) {
      setSubmitting(true);
      try {
        await req.onConfirm(value);
      } catch {
        setSubmitting(false); // 열린 채 복구 — 에러 처리는 호출부(finally/catch)
        return;
      }
    }
    settle(req.id, result);
  }, [req.id, req.kind, req.onConfirm, submitting, value]);

  // 커스텀 content 핸들.
  const api: AdminDialogApi = {
    resolve: (v) => {
      if (!submitting) settle(req.id, v);
    },
    close: () => cancel(),
  };

  // 최초 포커스: prompt=입력, danger=취소, 그 외=확인([data-initial-focus] 마킹 요소).
  useEffect(() => {
    if (!isTop) return;
    const t = window.setTimeout(() => {
      const target =
        panelRef.current?.querySelector<HTMLElement>("[data-initial-focus]") ??
        panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        panelRef.current;
      target?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [isTop]);

  // 키보드: ESC(닫기 허용 시) + Tab focus trap. 최상단 다이얼로그에만.
  useEffect(() => {
    if (!isTop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible && !submitting) {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === "Tab") {
        const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!nodes || nodes.length === 0) {
          e.preventDefault();
          return;
        }
        const list = Array.from(nodes).filter((n) => n.offsetParent !== null || n === document.activeElement);
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !panelRef.current?.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isTop, dismissible, submitting, cancel]);

  // 닫힌 뒤(패널 unmount) 호출 버튼으로 포커스 복귀.
  useEffect(() => {
    const trigger = req.trigger;
    return () => {
      // 다른 다이얼로그가 이미 포커스를 가져갔을 수 있으므로 document.body 일 때만 복귀.
      if (trigger && document.body.contains(trigger)) {
        window.setTimeout(() => trigger.focus(), 0);
      }
    };
  }, [req.trigger]);

  const confirmDisabled = submitting || (isPrompt && req.input?.required === true && value.trim() === "");

  // danger=취소에 최초 포커스(오조작 방지), prompt=입력, 그 외=확인 버튼.
  const focusCancel = hasCancel && req.variant === "danger";
  const focusConfirm = !isCustom && !isPrompt && !focusCancel;

  const cancelBtn = hasCancel ? (
    <Button
      key="cancel"
      type="button"
      variant="outline"
      size="sm"
      disabled={submitting}
      onClick={cancel}
      data-admin-dialog-cancel=""
      {...(focusCancel ? { "data-initial-focus": "" } : {})}
    >
      {req.cancelLabel ?? "취소"}
    </Button>
  ) : null;

  const confirmBtn = !isCustom ? (
    <Button
      key="confirm"
      type="button"
      variant={confirmVariant}
      size="sm"
      loading={submitting}
      disabled={confirmDisabled}
      onClick={confirm}
      data-admin-dialog-confirm=""
      {...(focusConfirm ? { "data-initial-focus": "" } : {})}
    >
      {req.confirmLabel ?? "확인"}
    </Button>
  ) : null;

  const buttons = req.reverseButtons ? [confirmBtn, cancelBtn] : [cancelBtn, confirmBtn];

  const renderedContent =
    typeof req.content === "function" ? req.content(api) : req.content;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4",
        !isTop && "pointer-events-none",
      )}
      aria-hidden={!isTop || undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissOnOutside && dismissible && !submitting) cancel();
      }}
    >
      <div
        ref={panelRef}
        data-admin-dialog=""
        data-variant={req.variant ?? "default"}
        role={isCustom || req.kind === "prompt" ? "dialog" : "alertdialog"}
        aria-modal="true"
        aria-labelledby={req.title ? titleId : undefined}
        aria-describedby={req.description ? descId : undefined}
        aria-label={!req.title ? "알림" : undefined}
        className={cn(
          "relative flex max-h-[85vh] flex-col rounded-xl bg-card text-card-foreground shadow-xl ring-1 ring-foreground/10",
          WIDTH_CLASS[width],
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {showClose && (
          <button
            type="button"
            aria-label="닫기"
            data-admin-dialog-close=""
            onClick={cancel}
            disabled={submitting}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-70 transition hover:bg-muted hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {isCustom ? (
          // 커스텀: 헤더/본문/버튼을 content 가 전적으로 렌더(스크롤만 공통 보장).
          <div className="min-h-0 flex-1 overflow-y-auto">{renderedContent}</div>
        ) : (
          <>
            {/* 헤더: 아이콘 + 제목 */}
            <div className="flex items-start gap-3 px-5 pt-5 pr-12">
              {Icon && (
                <span
                  className={cn(
                    "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                    cfg.accent,
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
              )}
              <div className="min-w-0 flex-1">
                {req.title && (
                  <h2 id={titleId} className="text-base font-semibold text-foreground">
                    {req.title}
                  </h2>
                )}
                {req.description != null && req.description !== "" && (
                  <div
                    id={descId}
                    className={cn(
                      "text-sm whitespace-pre-line text-muted-foreground",
                      req.title ? "mt-1.5" : "",
                    )}
                  >
                    {req.description}
                  </div>
                )}
              </div>
            </div>

            {/* 본문(스크롤 영역) — prompt 입력 + 커스텀 content(있을 때) */}
            {(isPrompt || renderedContent) && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4">
                {renderedContent}
                {isPrompt && (
                  <label className="block">
                    {req.input?.label && (
                      <span className="mb-1.5 block text-sm font-medium text-foreground">
                        {req.input.label}
                      </span>
                    )}
                    {req.input?.multiline ? (
                      <textarea
                        data-initial-focus=""
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={req.input?.placeholder}
                        maxLength={req.input?.maxLength}
                        rows={4}
                        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                      />
                    ) : (
                      <input
                        data-initial-focus=""
                        type="text"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !confirmDisabled) {
                            e.preventDefault();
                            void confirm();
                          }
                        }}
                        placeholder={req.input?.placeholder}
                        maxLength={req.input?.maxLength}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                      />
                    )}
                    {typeof req.input?.maxLength === "number" && (
                      <span className="mt-1 block text-right text-xs text-muted-foreground">
                        {value.length}/{req.input.maxLength}
                      </span>
                    )}
                  </label>
                )}
              </div>
            )}

            {/* 버튼 영역 */}
            <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-5">
              {buttons}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── 뷰포트(포털) ───────────────────────────────────────────────────────────
const noopSubscribe = () => () => {};
const isClientSnapshot = () => true;
const isServerSnapshot = () => false;

/**
 * 다이얼로그 컨테이너. Layout 한 곳에만 마운트한다(store 싱글턴 — 중복 마운트 금지).
 * document.body 포털이라 어느 카드/overflow/transform 안에도 갇히지 않는다.
 */
export function AdminDialogViewport() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isClient = useSyncExternalStore(noopSubscribe, isClientSnapshot, isServerSnapshot);

  // 배경 스크롤 잠금 — 다이얼로그가 하나라도 있으면 body 스크롤 차단.
  useEffect(() => {
    if (list.length === 0) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [list.length]);

  if (!isClient || list.length === 0) return null;

  return createPortal(
    <>
      {list.map((req, i) => (
        <DialogPanel key={req.id} req={req} isTop={i === list.length - 1} />
      ))}
    </>,
    document.body,
  );
}
