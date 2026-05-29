// Browser-safe helpers for cluster4 output_images (URL + caption) structure.
// Must not import server-only modules here.
//
// 배경: output image 를 URL-only(string[]) → URL + caption 구조로 확장.
//   - 신규 저장: output_images jsonb = [{ url, caption }]
//   - 레거시: output_images 가 string[] 인 기존 행도 그대로 읽을 수 있어야 한다.
//   - 읽기: 두 형태(string | {url, caption})를 모두 정규화한다.
//
// 프론트(고객 페이지)의 캡션 오버레이:
//   <div class="image-caption-overlay"><span class="caption-text"></span></div>
//   → outputImageCaptions[i] 를 caption-text 에 채운다 (없으면 빈 문자열).

export type Cluster4OutputImage = {
  url: string;
  caption: string | null;
};

function normalizeCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

// DB jsonb element(string | {url, caption}) → 정규화된 OutputImage[]. url 없으면 버린다.
export function normalizeOutputImages(raw: unknown): Cluster4OutputImage[] {
  if (!Array.isArray(raw)) return [];
  const out: Cluster4OutputImage[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const url = item.trim();
      if (url) out.push({ url, caption: null });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url.trim() : "";
      if (!url) continue;
      out.push({ url, caption: normalizeCaption(rec.caption) });
    }
  }
  return out;
}

// 읽기 보조: URL 목록만 (레거시 outputImages: string[] 호환).
export function outputImageUrls(raw: unknown): string[] {
  return normalizeOutputImages(raw).map((i) => i.url);
}

// 읽기 보조: caption 목록 (url 과 index 정렬 일치). 없으면 null.
export function outputImageCaptions(raw: unknown): (string | null)[] {
  return normalizeOutputImages(raw).map((i) => i.caption);
}

// 쓰기: 폼/페이로드 입력 → 저장용 [{url, caption}]. url 없으면 제외, caption 빈값은 null.
export function buildOutputImages(
  items: Array<{ url: string; caption?: string | null }>,
): Cluster4OutputImage[] {
  const out: Cluster4OutputImage[] = [];
  for (const it of items) {
    const url = (it.url ?? "").trim();
    if (!url) continue;
    out.push({ url, caption: normalizeCaption(it.caption) });
  }
  return out;
}

export type ParseOutputImagesResult =
  | { ok: true; value: Cluster4OutputImage[] }
  | { ok: false; error: string };

// 요청 body 의 `output_images` 파서. string[] 또는 [{url, caption?}] 둘 다 허용 (backward-compat).
// url 없는 항목은 버린다. 미지정(undefined/null)이면 빈 배열.
export function parseOutputImagesInput(raw: unknown): ParseOutputImagesResult {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "output_images must be an array" };
  }
  const out: Cluster4OutputImage[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const url = item.trim();
      if (url) out.push({ url, caption: null });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if (rec.url !== undefined && rec.url !== null && typeof rec.url !== "string") {
        return { ok: false, error: "output_images[].url must be a string" };
      }
      if (
        rec.caption !== undefined &&
        rec.caption !== null &&
        typeof rec.caption !== "string"
      ) {
        return { ok: false, error: "output_images[].caption must be a string or null" };
      }
      const url = typeof rec.url === "string" ? rec.url.trim() : "";
      if (!url) continue;
      out.push({ url, caption: normalizeCaption(rec.caption) });
      continue;
    }
    return {
      ok: false,
      error: "output_images items must be strings or {url, caption} objects",
    };
  }
  return { ok: true, value: out };
}
