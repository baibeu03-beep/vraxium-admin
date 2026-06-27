"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * 전역 로딩 배너 상태(단일 출처).
 *
 * 화면 곳곳의 데이터 조회 컴포넌트가 자신의 loading 을 이 컨텍스트로 "보고"하면,
 * 레이아웃 상단(헤더 바로 아래)의 공통 배너(GlobalLoadingBanner)가 한 곳에서 표시된다.
 * - 페이지마다 따로 배너를 만들지 않는다(요구사항: 전역 공통 컴포넌트 1개).
 * - 동시에 여러 조회가 진행돼도 카운터로 합산 → 모두 끝나야 배너가 사라진다.
 */
type LoadingBannerValue = {
  /** 현재 진행 중인 조회가 1건 이상인지. */
  active: boolean;
  increment: () => void;
  decrement: () => void;
};

const LoadingBannerContext = createContext<LoadingBannerValue | null>(null);

export function LoadingBannerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // 동시 진행 중인 조회 수. 0 보다 크면 배너 노출.
  const [count, setCount] = useState(0);

  const increment = useCallback(() => setCount((c) => c + 1), []);
  const decrement = useCallback(() => setCount((c) => Math.max(0, c - 1)), []);

  const value = useMemo<LoadingBannerValue>(
    () => ({ active: count > 0, increment, decrement }),
    [count, increment, decrement],
  );

  return (
    <LoadingBannerContext.Provider value={value}>
      {children}
    </LoadingBannerContext.Provider>
  );
}

/** 배너 UI 가 읽는 전역 로딩 상태. Provider 밖이면 false. */
export function useLoadingBannerActive(): boolean {
  return useContext(LoadingBannerContext)?.active ?? false;
}

/**
 * 데이터 조회 컴포넌트가 자신의 loading 을 전역 배너에 보고한다.
 *
 *   const [loading, setLoading] = useState(true);
 *   useReportLoading(loading);   // ← 이 한 줄이면 끝
 *
 * - active=true 가 되면 카운트 +1, false 가 되거나 언마운트되면 -1.
 * - Provider 밖에서 호출돼도(테스트/단독 렌더) 무해하게 no-op.
 */
export function useReportLoading(active: boolean): void {
  const ctx = useContext(LoadingBannerContext);

  useEffect(() => {
    if (!ctx || !active) return;
    ctx.increment();
    // active=false 전환 또는 언마운트 시 자동 정리 → 배너가 영구히 남지 않는다.
    return () => ctx.decrement();
  }, [ctx, active]);
}
