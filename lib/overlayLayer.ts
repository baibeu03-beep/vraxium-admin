// 어드민 전역 오버레이 레이어 헬퍼 — z-index 순서의 단일 출처는 app/globals.css 의
// `--z-*` 토큰이고, 이 파일은 "지금 어느 레이어에 떠야 하는가"를 런타임에 고르는 로직만 갖는다.
//
//   왜 런타임 판정이 필요한가:
//     툴팁·드롭다운·Select 는 document.body 포털이라 항상 같은 z 로 뜬다. 그런데 같은
//     컴포넌트가 (a) 페이지 위에서 열릴 때는 모달 backdrop "아래"에 있어야 하고,
//     (b) 모달 안에서 열릴 때는 모달 패널 "위"에 있어야 한다. 고정 z 로는 둘 중 하나가
//     반드시 깨진다(실제로 모달 안 Select 가 패널 뒤로 깔리고, 페이지 툴팁이 모달 위로
//     떠 있었다). → 열리는 순간 "열려 있는 모달"이 있는지 보고 레이어를 고른다.
//
//   모달 오버레이 컨테이너는 반드시 `data-admin-overlay` 를 갖는다(= 이 판정의 표식).
//   중첩 모달(모달 위의 모달)도 같은 표식을 쓰므로, 가장 높은 z 를 기준으로 그 위에 뜬다.

/** 모달 오버레이 컨테이너 표식 — 이 속성이 붙은 요소가 하나라도 있으면 "모달 열림". */
export const OVERLAY_MARKER_ATTR = "data-admin-overlay";

/** 모달 오버레이 컨테이너에 스프레드하는 표식 props. `<div {...overlayMarkerProps}>` */
export const overlayMarkerProps = { [OVERLAY_MARKER_ATTR]: "" } as Record<string, string>;

function cssVarNumber(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 현재 열려 있는 모달 오버레이 중 가장 높은 z-index. 없으면 0. */
export function topmostOverlayZIndex(): number {
  if (typeof document === "undefined") return 0;
  let top = 0;
  for (const el of document.querySelectorAll(`[${OVERLAY_MARKER_ATTR}]`)) {
    const z = Number.parseInt(getComputedStyle(el).zIndex, 10);
    if (Number.isFinite(z)) top = Math.max(top, z);
  }
  return top;
}

/**
 * 포털 팝오버(툴팁·드롭다운·Select)가 지금 써야 할 z-index.
 *   - 모달이 없으면 페이지 레이어(--z-page-popover, 표 sticky corner 위 / 모달 아래).
 *   - 모달이 열려 있으면 그 위(--z-modal-popover 이상, 중첩 모달도 넘어서게 +1 보정).
 * 열리는 시점에 한 번 계산해 고정한다(열려 있는 동안 모달이 새로 뜨는 경우는
 * 모달 트리거 클릭이 팝오버를 먼저 닫으므로 실무상 발생하지 않는다).
 */
export function popoverZIndex(): number {
  const page = cssVarNumber("--z-page-popover", 50);
  const top = topmostOverlayZIndex();
  if (top <= 0) return page;
  return Math.max(top + 1, cssVarNumber("--z-modal-popover", 100));
}
