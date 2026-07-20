// 라인 개설 폼 "필수 입력 누락" 강조/스크롤 공용 SoT.
//   practical-info 폼(PracticalInfoOpeningForm)에서 확립한 UX 를 그대로 공통화한 것으로,
//   practical-experience 등 다른 개설 폼이 **동일한** 강조/스크롤/포커스 로직을 재사용한다.
//
//   UX 계약(3단계):
//     (1) 첫 누락 필드 wrapper 를 붉은 ring + 연한 배경 + 깜빡임(animate-pulse)으로 잠시 강조,
//     (2) 팝업 확인 후 그 필드로 부드럽게 스크롤 + 포커스,
//     (3) 약 1.6s 뒤 강조 해제(무한 깜빡임 금지).
//   browser-safe: 서버 전용 모듈을 import 하지 않는다.

// 누락 필드 wrapper 임시 강조 클래스 — ring(레이아웃 시프트 없는 빨간 테두리) + 연한 배경 + 깜빡임.
//   prefers-reduced-motion 이면 motion-reduce:animate-none 으로 깜빡임 없이 테두리 강조만 남긴다.
export const OPENING_INVALID_HIGHLIGHT =
  "rounded-md bg-red-50 ring-2 ring-red-400 animate-pulse motion-reduce:animate-none dark:bg-red-950/30";

// 강조 유지 시간(ms) — 이 시간 뒤 강조를 해제해 무한 깜빡임을 막는다.
export const OPENING_INVALID_HIGHLIGHT_MS = 1600;

// 대상 필드로 스크롤 + 포커스. wrap = 스크롤/강조 대상(필드 wrapper), target = 포커스 대상 요소.
//   focus 는 preventScroll(포커스가 스크롤을 가로채지 않게) 후 wrapper 를 화면 중앙으로 스크롤한다.
//   admin 셸에서 main 이 유일 스크롤 컨테이너라 scrollIntoView 가 그것을 스크롤한다.
//   prefers-reduced-motion 이면 즉시 이동(smooth 없음).
export function scrollFocusInvalidTarget(
  wrap: HTMLElement | null,
  target: HTMLElement | null,
): void {
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  target?.focus({ preventScroll: true });
  (wrap ?? target)?.scrollIntoView({
    behavior: reduce ? "auto" : "smooth",
    block: "center",
  });
}
