// Browser-safe helpers for the cluster4 output_links (URL + label) structure.
// Must not import server-only modules here.
//
// 배경: output link 를 URL-only(output_link_1~5) → URL + label 구조로 이원화.
//   - 신규 저장: output_links jsonb = [{ url, label }]
//   - 레거시 컬럼(output_link_1~5)은 backward compatibility 로 유지(병행 mirror).
//   - 읽기: output_links 가 있으면 우선, 없으면 레거시 컬럼으로 fallback.

export type Cluster4OutputLink = {
  url: string;
  label: string | null;
};

// 정책: 아웃풋 링크 설명(label) 최대 글자수. 프론트 maxLength / 백엔드 검증 공용 SoT.
export const OUTPUT_LINK_LABEL_MAX_LENGTH = 30;

function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

// DB jsonb(또는 임의의 unknown) → 정제된 OutputLink[]. url 이 없는 항목은 버린다.
export function normalizeOutputLinks(raw: unknown): Cluster4OutputLink[] {
  if (!Array.isArray(raw)) return [];
  const out: Cluster4OutputLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!url) continue;
    out.push({ url, label: normalizeLabel(rec.label) });
  }
  return out;
}

// 레거시 URL 컬럼 → OutputLink[] (label = null). 빈 값/null 은 건너뛰고 순서를 보존한다.
export function outputLinksFromLegacy(
  urls: Array<string | null | undefined>,
): Cluster4OutputLink[] {
  const out: Cluster4OutputLink[] = [];
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    const url = raw.trim();
    if (!url) continue;
    out.push({ url, label: null });
  }
  return out;
}

// 읽기 해석: output_links jsonb 가 비어있지 않으면 우선, 아니면 레거시 컬럼으로 fallback.
export function resolveOutputLinks(
  rawOutputLinks: unknown,
  legacyUrls: Array<string | null | undefined>,
): Cluster4OutputLink[] {
  const fromJson = normalizeOutputLinks(rawOutputLinks);
  if (fromJson.length > 0) return fromJson;
  return outputLinksFromLegacy(legacyUrls);
}

// OutputLink[] → N 개의 레거시 URL 슬롯(url 만). 부족분은 null 로 채운다.
// 레거시 컬럼 backward-compat mirror 작성용.
export function outputLinksToLegacySlots(
  links: Cluster4OutputLink[],
  slotCount: number,
): (string | null)[] {
  const slots: (string | null)[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    slots.push(links[i]?.url ?? null);
  }
  return slots;
}

// 어드민 UI 입력 placeholder (URL / 설명).
export const OUTPUT_LINK_URL_PLACEHOLDER = "https://...";
export const OUTPUT_LINK_LABEL_PLACEHOLDER = "예) 결과물 링크, 참고 자료, Github, 발표 자료";

export type OutputLinkFormSlot = { url: string; label: string };

export type BuildOutputLinksResult =
  | { ok: true; value: Cluster4OutputLink[] }
  | { ok: false; error: string };

// 어드민 폼 슬롯(URL + 설명) → output_links 배열로 변환 + 정책 검증.
//   - URL 이 비어 있으면 해당 슬롯 제외 (label 도 비어야 함).
//   - label 만 있고 URL 이 없으면 에러 (정책: 경고).
//   - URL 순서 보존, label 은 trim 후 빈 값이면 null.
export function buildOutputLinksFromForm(
  slots: OutputLinkFormSlot[],
): BuildOutputLinksResult {
  const out: Cluster4OutputLink[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    const url = (slots[i].url ?? "").trim();
    const label = (slots[i].label ?? "").trim();
    if (!url) {
      if (label) {
        return {
          ok: false,
          error: `Link ${i + 1}: 설명만 입력되었습니다. URL을 입력하거나 설명을 비워주세요.`,
        };
      }
      continue;
    }
    if (label.length > OUTPUT_LINK_LABEL_MAX_LENGTH) {
      return {
        ok: false,
        error: `Link ${i + 1}: 설명은 최대 ${OUTPUT_LINK_LABEL_MAX_LENGTH}자까지 입력 가능합니다 (현재 ${label.length}자).`,
      };
    }
    out.push({ url, label: label || null });
  }
  return { ok: true, value: out };
}

export type ParseOutputLinksResult =
  | { ok: true; value: Cluster4OutputLink[] }
  | { ok: false; error: string };

// 요청 body 의 `output_links` 필드 파서. [{ url, label? }] 배열을 받는다.
// url 이 빈 항목은 버린다. maxLinks 초과 시 에러. 미지정(undefined/null)이면 빈 배열.
export function parseOutputLinksInput(
  raw: unknown,
  { maxLinks = 5 }: { maxLinks?: number } = {},
): ParseOutputLinksResult {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "output_links must be an array" };
  }
  const out: Cluster4OutputLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "output_links items must be objects with url/label" };
    }
    const rec = item as Record<string, unknown>;
    if (rec.url !== undefined && rec.url !== null && typeof rec.url !== "string") {
      return { ok: false, error: "output_links[].url must be a string" };
    }
    if (rec.label !== undefined && rec.label !== null && typeof rec.label !== "string") {
      return { ok: false, error: "output_links[].label must be a string or null" };
    }
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!url) continue; // url 없는 항목은 무시
    const label = normalizeLabel(rec.label);
    if (label && label.length > OUTPUT_LINK_LABEL_MAX_LENGTH) {
      return {
        ok: false,
        error: `링크 설명은 최대 ${OUTPUT_LINK_LABEL_MAX_LENGTH}자까지 입력 가능합니다 (현재 ${label.length}자)`,
      };
    }
    out.push({ url, label });
  }
  if (out.length > maxLinks) {
    return { ok: false, error: `output_links 는 최대 ${maxLinks}개까지 입력 가능합니다` };
  }
  return { ok: true, value: out };
}
