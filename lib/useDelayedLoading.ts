"use client";

import { useEffect, useState } from "react";

/**
 * 로딩 표시 타이밍 공통 정책(전역 단일 출처).
 *
 * - 300~500ms 이내 응답: 로딩 UI 를 띄우지 않는다(깜빡임 방지).
 * - 500ms 이상: `visible`=true → "불러오는 중..." 류 로딩 UI 노출.
 * - 10초 이상: `slow`=true → "응답이 지연되고 있습니다" 안내로 전환.
 *
 * @param active   현재 비동기 작업이 진행 중인지(fetch/네비게이션 등).
 * @returns visible(지연 후 노출 여부), slow(장시간 지연 여부)
 */
export function useDelayedLoading(
  active: boolean,
  opts?: { delayMs?: number; slowAfterMs?: number },
): { visible: boolean; slow: boolean } {
  const delayMs = opts?.delayMs ?? 500;
  const slowAfterMs = opts?.slowAfterMs ?? 10_000;

  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!active) {
      // 작업 종료 즉시 로딩 UI 제거.
      setVisible(false);
      setSlow(false);
      return;
    }

    const showTimer = window.setTimeout(() => setVisible(true), delayMs);
    const slowTimer = window.setTimeout(() => setSlow(true), slowAfterMs);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(slowTimer);
    };
  }, [active, delayMs, slowAfterMs]);

  return { visible, slow };
}
