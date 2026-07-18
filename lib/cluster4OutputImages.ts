// Browser-safe helpers for cluster4 output_images (URL + caption) structure.
// Must not import server-only modules here.
//
// 배경: output image 를 URL-only(string[]) → URL + caption 구조로 확장.
//   - 신규 저장: output_images jsonb = [{ url, caption }]
//   - 레거시: output_images 가 string[] 인 기존 행도 그대로 읽을 수 있어야 한다.
//   - 읽기: 두 형태(string | {url, caption})를 모두 정규화한다.
//
// 프론트(크루 페이지)의 캡션 오버레이:
//   <div class="image-caption-overlay"><span class="caption-text"></span></div>
//   → outputImageCaptions[i] 를 caption-text 에 채운다 (없으면 빈 문자열).

export type Cluster4OutputImage = {
  url: string;
  caption: string | null;
};

// 정책: 아웃풋 이미지 설명(caption) 최대 글자수. 프론트 maxLength / 백엔드 검증 공용 SoT.
export const OUTPUT_IMAGE_CAPTION_MAX_LENGTH = 20;

// ─────────────────────────────────────────────────────────────────────
// 예약 슬롯 모델(2026-07-18 확정 · admin/vraxium 공용 SoT).
//   4허브(work_info/ability/exp/career) 라인 아웃풋 이미지는 **고정 4슬롯**이며 슬롯 역할이 예약돼 있다:
//     · 슬롯 0(1번)              = 운영진(라인 레벨) 이미지. 최대 1개(cluster4_lines.output_images).
//     · 슬롯 1..3(2~4번)         = 크루(제출) 이미지. 최대 3개(cluster4_line_submissions.output_images).
//   운영진 슬롯 수(RESERVED_ADMIN_IMAGE_SLOTS)는 **고정 예약**이다 — 운영진 이미지가 비어 있어도 크루
//   이미지는 절대 슬롯 0 으로 당겨지지 않는다("2번 슬롯부터" 규칙). 크루 이미지는 자기 구간(1..3) 안에서
//   연속(contiguous)으로 채운다(고객 렌더가 연속을 가정) — 운영진/크루 경계는 넘지 않는다.
//   저장 구조는 admin/crew 이미지를 **별도 배열**로 유지한다(top-level outputImages = 운영진,
//   submission.outputImages = 크루). 이 헬퍼는 두 배열 ↔ 고정 4슬롯 배열을 무손실 변환한다:
//   filter(Boolean)/compact 로 슬롯 정보를 잃지 않는다.
export const IMAGE_SLOT_COUNT = 4;
export const RESERVED_ADMIN_IMAGE_SLOTS = 1; // = ADMIN_OUTPUT_IMAGE_MAX (vraxium clamp 정책과 동일)
export const CREW_IMAGE_SLOT_COUNT = IMAGE_SLOT_COUNT - RESERVED_ADMIN_IMAGE_SLOTS; // 3

// 슬롯 = 이미지 또는 빈 슬롯(null). 빈 슬롯은 url 없는 자리(운영진/크루 경계 유지용).
export type Cluster4ImageSlot = Cluster4OutputImage | null;

// (운영진 이미지≤1, 크루 이미지[]) → 고정 길이 4 슬롯 배열. 슬롯 0=운영진, 슬롯 1..3=크루(연속).
export function buildImageSlots(
  adminImages: Cluster4OutputImage[],
  crewImages: Cluster4OutputImage[],
): Cluster4ImageSlot[] {
  const slots: Cluster4ImageSlot[] = new Array(IMAGE_SLOT_COUNT).fill(null);
  adminImages.slice(0, RESERVED_ADMIN_IMAGE_SLOTS).forEach((im, i) => {
    slots[i] = im;
  });
  crewImages.slice(0, CREW_IMAGE_SLOT_COUNT).forEach((im, i) => {
    slots[RESERVED_ADMIN_IMAGE_SLOTS + i] = im;
  });
  return slots;
}

// 고정 4슬롯 배열 → { adminImages(≤1), crewImages(연속) }.
//   · 운영진 슬롯(앞 RESERVED_ADMIN_IMAGE_SLOTS) 과 크루 슬롯(뒤)을 경계로 분리한다.
//   · 각 구간 안에서 url 있는 항목만 순서대로 모은다(구간 경계는 넘지 않음 — 크루 이미지가 운영진 슬롯을
//     침범하거나 그 반대가 되지 않는다). 크루 구간 내부는 연속 저장(고객 렌더 계약과 동일).
export function splitImageSlots(slots: Cluster4ImageSlot[]): {
  adminImages: Cluster4OutputImage[];
  crewImages: Cluster4OutputImage[];
} {
  const norm = (s: Cluster4ImageSlot): Cluster4OutputImage | null => {
    const url = (s?.url ?? "").trim();
    if (!url) return null;
    return { url, caption: normalizeCaption(s?.caption) };
  };
  const adminImages: Cluster4OutputImage[] = [];
  for (let i = 0; i < RESERVED_ADMIN_IMAGE_SLOTS; i++) {
    const im = norm(slots[i] ?? null);
    if (im) adminImages.push(im);
  }
  const crewImages: Cluster4OutputImage[] = [];
  for (let i = RESERVED_ADMIN_IMAGE_SLOTS; i < IMAGE_SLOT_COUNT; i++) {
    const im = norm(slots[i] ?? null);
    if (im) crewImages.push(im);
  }
  return { adminImages, crewImages };
}

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
    const caption = normalizeCaption(it.caption);
    if (caption && caption.length > OUTPUT_IMAGE_CAPTION_MAX_LENGTH) {
      throw new Error(
        `이미지 설명은 최대 ${OUTPUT_IMAGE_CAPTION_MAX_LENGTH}자까지 입력 가능합니다 (현재 ${caption.length}자)`,
      );
    }
    out.push({ url, caption });
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
      const caption = normalizeCaption(rec.caption);
      if (caption && caption.length > OUTPUT_IMAGE_CAPTION_MAX_LENGTH) {
        return {
          ok: false,
          error: `이미지 설명은 최대 ${OUTPUT_IMAGE_CAPTION_MAX_LENGTH}자까지 입력 가능합니다 (현재 ${caption.length}자)`,
        };
      }
      out.push({ url, caption });
      continue;
    }
    return {
      ok: false,
      error: "output_images items must be strings or {url, caption} objects",
    };
  }
  return { ok: true, value: out };
}
