// Help Key(돋보기, AdminHelpIconButton) hover 툴팁용 "미리보기 텍스트" 공통 유틸.
//   · SoT 는 저장된 도움말 본문(admin_page_help_contents.content) 그대로 — 여기선 표시만 정리한다.
//   · 저장 API/DTO/조회 로직/권한/snapshot/mode=test 분기는 건드리지 않는다(표시 전용).
//   · org/mode 로 갈라지지 않는 순수 함수 — 어떤 Help Key 든 같은 규칙으로 툴팁을 만든다.
//
// 규칙(요구사항):
//   1) 내용이 있으면: 태그/Markdown 을 제거한 "일반 텍스트" 앞부분을 보여주고, 길면 말줄임표(…)로 자른다.
//      권장 최대 길이는 한글 기준 약 40~60자(기본 50자).
//   2) 내용이 없으면(null/undefined/빈문자열/공백만): 빈 문자열을 돌려주고, 호출부가 기존 fallback 을 쓴다.
//   3) HTML/Markdown/줄바꿈이 그대로 노출되지 않게 정리하고, 연속 공백·줄바꿈은 한 칸으로 정규화한다.

/** 툴팁 미리보기 최대 길이(문자 수, 한글 기준). 40~60 권장 범위의 중앙값. */
export const HELP_TOOLTIP_PREVIEW_MAX = 50;

// 자주 쓰이는 HTML 엔티티만 최소한으로 복원(툴팁은 일반 텍스트여야 하므로 "&amp;" 같은 게 보이면 안 됨).
const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * 도움말 본문(HTML/Markdown/줄바꿈 포함 가능)을 툴팁용 "일반 텍스트 한 줄"로 평탄화한다.
 * 잘라내기는 하지 않는다(정규화만). 내용이 사실상 없으면 "" 를 돌려준다.
 */
export function normalizeHelpToPlainText(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  let s = raw;

  // 1) 코드펜스(```), 인라인 코드(`) 마커 제거 — 내부 텍스트는 남긴다.
  s = s.replace(/```+/g, " ").replace(/`+/g, "");

  // 2) HTML 태그 제거(<b>, <br/>, <div> 등).
  s = s.replace(/<[^>]*>/g, " ");

  // 3) HTML 엔티티 최소 복원.
  s = s.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (m) => HTML_ENTITIES[m] ?? m);

  // 4) Markdown 이미지/링크 → 표시 텍스트만 남긴다. ![alt](url) → alt, [text](url) → text
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 5) 라인 앞 Markdown 마커 제거: 제목(#), 인용(>), 목록(-, *, +, 1.).
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "");

  // 6) 강조 마커 제거: **bold**, __bold__, *it*, _it_, ~~strike~~.
  s = s.replace(/(\*\*|__|~~|[*_])/g, "");

  // 7) 연속 공백·줄바꿈·탭을 한 칸으로 정규화 후 trim.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

/**
 * 도움말 본문을 툴팁 미리보기 문자열로 만든다.
 *   · 내용 없음(null/undefined/빈/공백만/정리 후 빈) → "" 반환(호출부가 fallback 사용).
 *   · maxLen(문자 수) 초과 시 잘라서 말줄임표(…) 부착. 서로게이트 쌍/이모지 안전(Array.from).
 */
export function buildHelpTooltipPreview(
  raw: string | null | undefined,
  maxLen: number = HELP_TOOLTIP_PREVIEW_MAX,
): string {
  const plain = normalizeHelpToPlainText(raw);
  if (plain.length === 0) return "";

  const chars = Array.from(plain); // 코드포인트 단위(이모지/한글 안전)
  if (chars.length <= maxLen) return plain;
  return chars.slice(0, maxLen).join("").trimEnd() + "…";
}

/**
 * hover 툴팁에 넣을 최종 문자열.
 *   · 저장된 내용이 있으면 미리보기, 없으면 fallback(기존 "이 항목 도움말").
 */
export function resolveHelpTooltip(
  raw: string | null | undefined,
  fallback: string,
  maxLen: number = HELP_TOOLTIP_PREVIEW_MAX,
): string {
  return buildHelpTooltipPreview(raw, maxLen) || fallback;
}
