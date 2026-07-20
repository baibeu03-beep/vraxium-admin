"use client";

// 공통 토스트(Toast) 인프라 — 작업 결과 안내 문구를 "문서 흐름 안의 상단 배너"가 아니라
//   화면 최상위 레이어의 "하단 고정 토스트"로 띄우기 위한 재사용 인프라.
//
//   왜 필요한가: 페이지 아래쪽에서 작업(예: 액트 삭제)한 뒤 안내가 페이지 상단에 뜨면
//   스크롤을 올려야만 확인할 수 있어 불편하다. 토스트는 스크롤 위치와 무관하게 항상
//   현재 화면(viewport) 우측 하단에 즉시 보인다.
//
//   구조:
//     - 모듈 레벨 store(pub/sub) — 어느 컴포넌트에서든 pushToast()로 발행 가능.
//     - <ToastViewport /> — createPortal 로 document.body 에 렌더 → 부모의 overflow/
//       transform/z-index/stacking context 에 갇히지 않는다. Layout 한 곳에만 마운트.
//     - useToast() — 컴포넌트에서 토스트를 띄우는 훅. { toast, dismiss } 반환.
//
//   사용법:
//     const { toast } = useToast();
//     toast("success", "액트가 삭제되었습니다 (…)");
//
//   기존 inline 배너(setBanner)를 이 인프라로 옮길 때는 얇은 shim 으로 감싸면
//   호출부를 바꾸지 않고 그대로 재사용할 수 있다(ProcessUnifiedManager 참고).

import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/admin/sidebarContext";

export type ToastKind = "success" | "error" | "warning" | "info";

export type ToastItem = {
  id: string;
  kind: ToastKind;
  message: string;
  /** 자동 닫힘까지의 시간(ms). 0/음수면 자동 닫힘 없음(수동 닫기). */
  duration: number;
  /**
   * 로딩 토스트 여부 — 장시간 작업(검수/실행 취소 등)의 "진행 중" 상태를 성공·실패 토스트와
   * 같은 영역(화면 하단 고정)에 지속적으로 표시하기 위한 플래그. loading=true 면:
   *   · 스피너를 표시하고 자동 닫힘 없이(duration=0) 요청이 끝날 때까지 유지된다.
   *   · 닫기(X) 버튼을 두지 않는다 — 사용자가 실수로 닫아 진행 상태가 사라지지 않도록.
   *     (실제 요청 상태는 호출부의 finally 에서 dismissToast(id) 로만 정리한다.)
   */
  loading?: boolean;
};

// 화면에 동시에 쌓이는 토스트 최대 개수(초과 시 오래된 것부터 제거).
const MAX_TOASTS = 4;

// 기존 toast duration 정책이 없으므로 성격별 표준 시간 정의.
//   성공/정보: 4.5s, 경고: 6s, 오류: 7.5s(수동 닫기 우선이라 넉넉히).
const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4500,
  info: 4500,
  warning: 6000,
  error: 7500,
};

// ── 모듈 레벨 store ────────────────────────────────────────────────────────
let items: ToastItem[] = [];
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
  return items;
}

// 서버 렌더 시에는 항상 빈 목록(토스트는 클라이언트 전용).
function getServerSnapshot() {
  return EMPTY as ToastItem[];
}
const EMPTY: ToastItem[] = [];

/**
 * 토스트 발행. 반환값은 토스트 id(수동 dismiss 용).
 *
 * 중복 합치기: 직전(가장 최근) 토스트와 kind+message 가 동일하면 새로 쌓지 않고
 * 마지막 토스트를 갱신(타이머 리셋)한다 — 같은 동작을 빠르게 반복해도 화면이
 * 같은 문구로 도배되지 않는다.
 */
export function pushToast(
  kind: ToastKind,
  message: string,
  duration?: number,
): string {
  const dur = duration ?? DEFAULT_DURATION[kind];
  const last = items[items.length - 1];
  if (last && last.kind === kind && last.message === message) {
    // 동일 메시지 → 마지막 토스트를 새 id로 교체(타이머·표시 갱신).
    const refreshed: ToastItem = { id: `t${++counter}`, kind, message, duration: dur };
    items = [...items.slice(0, -1), refreshed];
    emit();
    return refreshed.id;
  }
  const next: ToastItem = { id: `t${++counter}`, kind, message, duration: dur };
  items = [...items, next];
  if (items.length > MAX_TOASTS) items = items.slice(items.length - MAX_TOASTS);
  emit();
  return next.id;
}

export function dismissToast(id: string) {
  const before = items.length;
  items = items.filter((t) => t.id !== id);
  if (items.length !== before) emit();
}

export function dismissAllToasts() {
  if (items.length === 0) return;
  items = [];
  emit();
}

/**
 * 로딩(진행 중) 토스트 발행. 반환값(id)을 요청 완료 시 dismissToast(id) 로 정리한다.
 *
 * 자동 닫힘 없음(duration=0)·스피너·닫기 버튼 없음 → 요청이 resolve 될 때까지 화면 하단에
 * 그대로 유지된다. 재렌더/데이터 갱신/router.refresh 와 무관(모듈 레벨 store).
 * 중복 합치기(merge)를 적용하지 않아 성공/실패 토스트와 섞이지 않는다.
 */
export function pushLoadingToast(message: string): string {
  const next: ToastItem = { id: `t${++counter}`, kind: "info", message, duration: 0, loading: true };
  items = [...items, next];
  if (items.length > MAX_TOASTS) items = items.slice(items.length - MAX_TOASTS);
  emit();
  return next.id;
}

/** 이미 떠 있는 토스트의 문구를 갱신(로딩 단계 안내 전환용). 없거나 동일 문구면 no-op. */
export function updateToastMessage(id: string, message: string) {
  const idx = items.findIndex((t) => t.id === id);
  if (idx === -1 || items[idx].message === message) return;
  items = items.map((t) => (t.id === id ? { ...t, message } : t));
  emit();
}

/**
 * 컴포넌트에서 토스트를 띄우는 훅.
 *   const { toast } = useToast();
 *   toast("success", "저장되었습니다");
 */
export function useToast() {
  const toast = useCallback(
    (kind: ToastKind, message: string, duration?: number) =>
      pushToast(kind, message, duration),
    [],
  );
  // 진행 중(로딩) 토스트를 띄운다. 반환한 id 를 요청 finally 에서 dismiss(id) 로 정리한다.
  const loading = useCallback((message: string) => pushLoadingToast(message), []);
  // 진행 중 토스트의 문구를 갱신(단계 안내 전환).
  const update = useCallback((id: string, message: string) => updateToastMessage(id, message), []);
  const dismiss = useCallback((id: string) => dismissToast(id), []);
  return { toast, loading, update, dismiss, dismissAll: dismissAllToasts };
}

// ── 개별 토스트 ────────────────────────────────────────────────────────────
const KIND_STYLES: Record<ToastKind, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-rose-200 bg-rose-50 text-rose-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};
// 로딩(진행 중) 토스트 색 — 성공/실패와 구분되는 중립 톤(슬레이트).
const LOADING_STYLE = "border-slate-200 bg-slate-50 text-slate-700";

function Toast({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const [paused, setPaused] = useState(false);

  // 자동 닫힘 — hover/focus 중에는 일시정지(paused). duration<=0(로딩 포함)이면 자동 닫힘 없음.
  useEffect(() => {
    if (paused || item.duration <= 0) return;
    const timer = window.setTimeout(onClose, item.duration);
    return () => window.clearTimeout(timer);
  }, [paused, item.duration, onClose]);

  // 오류는 assertive(즉시 읽기), 나머지(로딩 포함)는 polite.
  const assertive = item.kind === "error";

  return (
    <div
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      aria-busy={item.loading || undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      className={cn(
        // pointer-events-auto: 컨테이너는 클릭 통과(none)지만 토스트 자체는 클릭 가능.
        // 넉넉한 내부 여백(px-4 py-3.5) + min-h-[52px] + text-base(프로젝트 @theme=23.5px,
        // line-height 32px 내장 — leading 별도 지정 금지) 로 한 줄/여러 줄 모두 답답하지 않게.
        // 폭은 컨테이너(콘텐츠 영역 전체 폭)가 잡는다 → w-full 로 그 폭을 그대로 채운다
        //   (max-w-* / w-auto 없음). 메시지=좌측·닫기 버튼=우측 끝(justify-between).
        "pointer-events-auto flex w-full min-h-[52px] items-start justify-between gap-3 rounded-lg border px-4 py-3.5 text-base shadow-lg",
        item.loading ? LOADING_STYLE : KIND_STYLES[item.kind],
      )}
    >
      <span className="flex min-w-0 items-start gap-2.5">
        {/* 로딩 토스트 — 스피너로 "진행 중"을 명확히 표시. shrink-0 로 여러 줄에서도 유지. */}
        {item.loading ? (
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-slate-500" aria-hidden />
        ) : null}
        {/* min-w-0 + break: 긴 문구/공백없는 특수문자 문자열도 말줄임 없이 자연 줄바꿈. */}
        <span className="min-w-0 whitespace-pre-line break-words [overflow-wrap:anywhere]">
          {item.message}
        </span>
      </span>
      {/* 로딩 토스트는 닫기 버튼을 두지 않는다(진행 상태를 실수로 닫지 못하게 — 요청 완료 시
          호출부 finally 에서만 제거). 일반 토스트만 닫기(36×36) 노출. */}
      {item.loading ? null : (
        <button
          type="button"
          aria-label="알림 닫기"
          onClick={onClose}
          className="-mr-1.5 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md opacity-60 transition hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
        >
          <X className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}

// ── 뷰포트(포털) ───────────────────────────────────────────────────────────
// 클라이언트 여부 감지(서버=false, 클라=true). useSyncExternalStore 로 처리하면
//   setState-in-effect 없이 SSR/hydration 정합을 지킨다(서버는 null → 클라에서 포털).
const noopSubscribe = () => () => {};
const isClientSnapshot = () => true;
const isServerSnapshot = () => false;

/**
 * 토스트 컨테이너. Layout 한 곳에만 마운트한다(중복 마운트 금지 — store 가 싱글턴).
 * document.body 포털이라 어느 페이지의 카드/overflow/transform 안에도 갇히지 않는다.
 */
export function ToastViewport() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isClient = useSyncExternalStore(noopSubscribe, isClientSnapshot, isServerSnapshot);
  // 하단 토스트 영역을 어드민 "콘텐츠 영역 전체 폭"에 정렬한다(짧은 카드 X). 포털은 viewport
  //   기준이라 콘텐츠 좌우 경계를 직접 계산해야 한다. 사이드바 폭은 하드코딩하지 않고 Sidebar 와
  //   공유하는 CSS 변수(--admin-sidebar-width-*)를 사용한다:
  //     · 좌측 시작점 = 사이드바 폭 + 콘텐츠 좌측 padding(--admin-content-padding, main p-6)
  //     · 우측 끝점  = 콘텐츠 우측 padding(--admin-content-padding)
  //   사이드바 토글 시 --toast-left 가 바뀌며 transition 으로 함께 움직인다.
  const { open } = useSidebar();
  const sidebarWidthVar = open
    ? "var(--admin-sidebar-width-open)"
    : "var(--admin-sidebar-width-collapsed)";

  if (!isClient) return null;

  return createPortal(
    <div
      // fixed + bottom 고정 → 스크롤 위치와 무관하게 항상 화면 하단(콘텐츠 영역 폭).
      // 모바일: 좌우 16px 여백(사이드바 오프셋 없음). 데스크톱(sm+): 왼쪽=사이드바+콘텐츠 padding,
      //   오른쪽=콘텐츠 padding → 어드민 콘텐츠 영역의 좌우 경계와 정확히 정렬(별도 max-w 없음).
      // pointer-events-none: 컨테이너가 뒤쪽 UI(테이블·버튼·pagination) 클릭을 막지 않음.
      //   개별 토스트만 pointer-events-auto.
      // flex-col + bottom 고정: 새 토스트는 아래(앵커 근처)에, 오래된 것은 위로 밀려 쌓인다.
      style={{
        ["--toast-left"]: `calc(${sidebarWidthVar} + var(--admin-content-padding))`,
      } as CSSProperties}
      className="pointer-events-none fixed bottom-6 left-4 right-4 z-[100] flex flex-col gap-3 transition-[left,right] duration-200 sm:left-[var(--toast-left)] sm:right-[var(--admin-content-padding)]"
      aria-live="polite"
    >
      {list.map((item) => (
        <Toast key={item.id} item={item} onClose={() => dismissToast(item.id)} />
      ))}
    </div>,
    document.body,
  );
}
