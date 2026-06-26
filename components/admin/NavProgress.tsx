"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * 전역 네비게이션 진행 표시(NProgress 형태) — 단일 출처.
 *
 * 책임(요구사항 2·3·6):
 *  1) 상단 Progress Bar: 내부 링크 클릭/뒤로가기 즉시 시작 → 라우트 전환 완료 시 100% 후 사라짐.
 *  2) 클릭 피드백: 클릭된 링크에 data-nav-clicked 부여(globals.css 가 active/opacity 표현).
 *  3) cursor: progress: 전환 중 body[data-nav-pending] (globals.css).
 *
 * 완료 감지/정리 정책(절대 영구히 남지 않도록 3중 안전장치):
 *  A) navKey(경로+쿼리) 가 바뀌면 즉시 종료 — 일반/느린 전환을 정확히 추적.
 *  B) 진행 중 추가 클릭(연타)이 오면 짧은 settle 타이머를 건다 — 연타가 출발지로
 *     되돌아와 navKey 가 끝내 안 바뀌는 경우에도 마지막 클릭 후 곧 종료.
 *  C) 그 외 어떤 경우에도 장시간 후 강제 종료(backstop).
 */
export default function NavProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const navKey = `${pathname}?${searchParams.toString()}`;

  const [pending, setPending] = useState(false);
  const [width, setWidth] = useState(0);

  // 상태 미러 ref — 이벤트/효과에서 stale state 없이 현재 진행여부를 읽는다.
  const pendingRef = useRef(false);
  const startedKeyRef = useRef<string | null>(null);
  const clickedElRef = useRef<HTMLElement | null>(null);

  const tickRef = useRef<number | null>(null);
  const doneRef = useRef<number | null>(null);
  const settleRef = useRef<number | null>(null);
  const safetyRef = useRef<number | null>(null);

  function clearTimer(ref: React.MutableRefObject<number | null>) {
    if (ref.current !== null) {
      window.clearInterval(ref.current);
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  }
  function clearAllTimers() {
    clearTimer(tickRef);
    clearTimer(doneRef);
    clearTimer(settleRef);
    clearTimer(safetyRef);
  }

  // 전환 중 클릭 피드백(data-nav-clicked)을 전부 제거 — 연타로 생긴 고아 표식까지
  // 정리해 링크가 영구히 흐려진 채 남지 않게 한다.
  function clearClicked() {
    document
      .querySelectorAll<HTMLElement>("[data-nav-clicked]")
      .forEach((el) => el.removeAttribute("data-nav-clicked"));
    clickedElRef.current = null;
  }

  function start() {
    if (pendingRef.current) return; // 이미 진행 중이면 새로 시작하지 않음
    pendingRef.current = true;
    startedKeyRef.current = navKey;
    clearAllTimers();
    setPending(true);
    setWidth(12);
    document.body.dataset.navPending = "1";
    // 90% 까지 점근적으로 채운다(완료 전까지는 100% 가 되지 않음).
    tickRef.current = window.setInterval(() => {
      setWidth((w) => (w >= 90 ? w : w + Math.max(0.5, (90 - w) * 0.12)));
    }, 180);
    // (C) backstop: navKey 가 끝내 안 바뀌는 전환(취소 등)에서도 강제 종료.
    safetyRef.current = window.setTimeout(() => finish(), 8000);
  }

  // (B) 연타로 진행 중 추가 클릭이 올 때: 마지막 클릭 후 1.2s 안에 navKey 변화가
  // 없으면(출발지로 되돌아온 경우 등) 종료. navKey 가 바뀌면 효과가 먼저 종료시킨다.
  function armSettle() {
    clearTimer(settleRef);
    settleRef.current = window.setTimeout(() => finish(), 1200);
  }

  function finish() {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    startedKeyRef.current = null;
    clearAllTimers();
    setWidth(100);
    document.body.removeAttribute("data-nav-pending");
    clearClicked();
    doneRef.current = window.setTimeout(() => {
      setPending(false);
      setWidth(0);
    }, 220);
  }

  // ── 내부 링크 클릭 감지(캡처 단계) ───────────────────────────────
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      if (anchor.getAttribute("aria-disabled") === "true") return;

      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/")) return; // 내부 경로만(외부/해시/메일 제외)

      const dest = href.split("#")[0];
      const current = window.location.pathname + window.location.search;
      if (dest === current) return; // 같은 화면이면 진행 표시 생략

      // 클릭 즉시 "접수됨" 피드백 부여.
      anchor.setAttribute("data-nav-clicked", "1");
      clickedElRef.current = anchor;
      if (pendingRef.current) {
        // 연타(이미 진행 중) — 출발지로 되돌아와 navKey 가 안 바뀌는 경우 대비.
        armSettle();
      } else {
        start();
      }
    }

    function onPopState() {
      start();
    }

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
    };
    // 리스너는 1회만 등록(핸들러는 ref 로 현재 상태를 읽음).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── (A) 라우트 전환 완료 감지: navKey 가 시작 시점과 달라지면 종료 ────────
  useEffect(() => {
    if (
      pendingRef.current &&
      startedKeyRef.current !== null &&
      startedKeyRef.current !== navKey
    ) {
      finish();
    }
    // navKey 변화에만 반응(완료 신호). pending 등은 ref 로 읽어 stale 없음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKey]);

  // 언마운트 정리.
  useEffect(() => {
    return () => {
      clearAllTimers();
      document.body.removeAttribute("data-nav-pending");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!pending) return null;

  return (
    <div
      aria-hidden
      data-nav-progress=""
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5"
    >
      <div
        className="h-full bg-primary shadow-[0_0_8px_var(--primary)] transition-[width] duration-200 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
