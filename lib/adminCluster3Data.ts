import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  CHANNEL_CARD_EDITABLE_TEXT_FIELDS,
  CHANNEL_CARD_IMAGE_URL_SLOTS,
  CHANNEL_CARD_SLOT_COUNT,
  DETAIL_CARD_SLOT_COUNT,
  OUTPUT_CARD_SLOT_COUNT,
  TOP_CARD_EDITABLE_INT_FIELDS,
  TOP_CARD_EDITABLE_TEXT_FIELDS,
  TOP_CARD_LINK_SLOTS,
  TOP_CARD_METRIC_SLOTS,
  TOP_CARD_SUB_IMAGE_CAPTION_SLOTS,
  TOP_CARD_SUB_IMAGE_SLOTS,
  type ChannelCardEditableTextField,
  type ChannelCardInput,
  type ChannelCardRow,
  type ChannelCardSlot,
  type Cluster3ApplySummary,
  type Cluster3Bundle,
  type Cluster3PatchBody,
  type TopCardEditableIntField,
  type TopCardEditableTextField,
  type TopCardInput,
  type TopCardRow,
  type TopCardSlot,
  type TopCardType,
} from "@/lib/adminCluster3Types";

// ─────────────────────────────────────────────────────────────────────
// Cluster3 admin
//
// Canonical:
//   portfolio_channel_cards     → channel 16
//   portfolio_top_cards         → card_type='output' (5) + card_type='detail' (10)
//
// 정책 (Phase 4):
//   - GET: 두 테이블 read.
//   - PATCH:
//       (a) portfolio_channel_cards 모두 write 허용.
//       (b) portfolio_top_cards.card_type='output' write 허용.
//       (c) portfolio_top_cards.card_type='detail' write 허용 (Phase 4 신규).
//           output 과 동일한 sanitize / replace 흐름을 사용한다.
//   - portfolio_top_cards 의 모든 write (delete/upsert) 는 반드시 .eq("card_type", ...)
//     scope 를 포함한다. 한 종류 write 가 다른 종류 row 를 건드려선 안 된다.
//     output 호출은 detail row 를 mutate 하지 않고, detail 호출은 output row 를
//     mutate 하지 않는다.
//   - routeParam = user_profiles.user_id (UUID) 만 사용. legacy_user_id (bigint) 사용 금지.
//   - user_profiles 매칭 실패 시 GET 은 readonly bundle, PATCH 은 409 거절.
//   - card_index / card_type 는 server-side stamp. 클라이언트가 보낸 값은 무시한다.
//   - 존재하지 않는 컬럼 select/update 금지. 컬럼 추정 금지.
//   - Admin route 는 requireAdmin 으로 보호되므로 user_edit_windows
//     (사용자-facing 작성 기간) 와 무관하게 저장한다.
// ─────────────────────────────────────────────────────────────────────

export class Cluster3Error extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "Cluster3Error";
  }
}

// 실제 schema 확인 (2026-05-15) — portfolio_channel_cards 17 컬럼 전부 select.
const CHANNEL_CARD_SELECT = [
  "id",
  "user_id",
  "card_index",
  "channel_name",
  "platform",
  "management",
  "start_year",
  "start_month",
  "start_day",
  "rating",
  "status",
  "link",
  "image_urls",
  "insight",
  "experience",
  "metrics",
  "created_at",
  "updated_at",
].join(",");

// 실제 schema 확인 (2026-05-15) — portfolio_top_cards 27 컬럼 전부 select.
// output/detail 모두 같은 row shape 으로 들어오며 card_type 으로만 갈린다.
const TOP_CARD_SELECT = [
  "id",
  "user_id",
  "card_type",
  "card_index",
  "main_title",
  "sub_title",
  "role_description",
  "report",
  "insight",
  "platform",
  "contribution",
  "period_start_year",
  "period_start_month",
  "period_start_day",
  "period_end_year",
  "period_end_month",
  "period_end_day",
  "roles",
  "tools",
  "main_image_url",
  "sub_image_urls",
  "main_image_caption",
  "sub_image_captions",
  "metrics",
  "links",
  "created_at",
  "updated_at",
].join(",");

async function resolveUserId(routeParam: string): Promise<string | null> {
  const id = String(routeParam).trim();
  if (!id) return null;

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", id)
    .maybeSingle();

  if (error) {
    console.error("[cluster3] query failed (user_profiles lookup)", {
      routeParam: id,
      message: error.message,
    });
    throw new Cluster3Error(500, error.message);
  }

  const userId = (data as { user_id?: string } | null)?.user_id ?? null;
  if (!userId) {
    console.warn("[cluster3] user_profiles missing", { routeParam: id });
  }
  return userId;
}

function buildChannelSlots(rows: ChannelCardRow[]): ChannelCardSlot[] {
  const byIndex = new Map<number, ChannelCardRow>();
  for (const row of rows) {
    if (typeof row.card_index === "number") {
      byIndex.set(row.card_index, row);
    }
  }
  const out: ChannelCardSlot[] = [];
  for (let i = 1; i <= CHANNEL_CARD_SLOT_COUNT; i++) {
    out.push({ cardIndex: i, row: byIndex.get(i) ?? null });
  }
  return out;
}

// portfolio_top_cards 에서 받은 row 전체에서 cardType 으로 필터한 뒤 슬롯을 채운다.
// output 호출이 detail row 를 누락시키거나 그 반대 누락이 일어나지 않도록
// 두 호출이 같은 rows 배열을 공유한다.
function buildTopSlots(
  rows: TopCardRow[],
  cardType: TopCardType,
  slotCount: number,
): TopCardSlot[] {
  const byIndex = new Map<number, TopCardRow>();
  for (const row of rows) {
    if (row.card_type !== cardType) continue;
    if (typeof row.card_index === "number") {
      byIndex.set(row.card_index, row);
    }
  }
  const out: TopCardSlot[] = [];
  for (let i = 1; i <= slotCount; i++) {
    out.push({ cardIndex: i, row: byIndex.get(i) ?? null });
  }
  return out;
}

export async function getCluster3ForCrew(
  legacyUserId: string,
): Promise<Cluster3Bundle> {
  const userId = await resolveUserId(legacyUserId);

  if (!userId) {
    return {
      legacyUserId,
      userId: null,
      channelCards: buildChannelSlots([]),
      outputCards: buildTopSlots([], "output", OUTPUT_CARD_SLOT_COUNT),
      detailCards: buildTopSlots([], "detail", DETAIL_CARD_SLOT_COUNT),
    };
  }

  // 두 테이블 병렬 fetch. portfolio_top_cards 는 한 번만 select 하고
  // output / detail 두 섹션을 같은 rows 에서 분기 — 누락 위험 차단.
  const [channelRes, topRes] = await Promise.all([
    supabaseAdmin
      .from("portfolio_channel_cards")
      .select(CHANNEL_CARD_SELECT)
      .eq("user_id", userId)
      .order("card_index", { ascending: true }),
    supabaseAdmin
      .from("portfolio_top_cards")
      .select(TOP_CARD_SELECT)
      .eq("user_id", userId)
      .order("card_type", { ascending: true })
      .order("card_index", { ascending: true }),
  ]);

  for (const res of [channelRes, topRes]) {
    if (res.error) {
      console.error("[cluster3] query failed (GET bundle)", {
        userId,
        message: res.error.message,
      });
      throw new Cluster3Error(500, res.error.message);
    }
  }

  const channelRows = (channelRes.data ?? []) as unknown as ChannelCardRow[];
  const topRows = (topRes.data ?? []) as unknown as TopCardRow[];

  return {
    legacyUserId,
    userId,
    channelCards: buildChannelSlots(channelRows),
    outputCards: buildTopSlots(topRows, "output", OUTPUT_CARD_SLOT_COUNT),
    detailCards: buildTopSlots(topRows, "detail", DETAIL_CARD_SLOT_COUNT),
  };
}

// ─────────────────────────────────────────────────────────────────────
// PATCH (Phase 2) — portfolio_channel_cards 만 write
// ─────────────────────────────────────────────────────────────────────

function sanitizeText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = typeof value === "string" ? value : String(value);
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}

// link 및 image_urls 항목에서 blob:/data:/file: prefix 는 storage 가 보관할 수 없는
// local preview URL 이므로 null 로 정규화한다.
function sanitizeUrl(value: unknown): string | null {
  const v = sanitizeText(value);
  if (!v) return null;
  if (v.startsWith("blob:") || v.startsWith("data:") || v.startsWith("file:")) {
    return null;
  }
  return v;
}

function isLocalPreviewUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return (
    v.startsWith("blob:") || v.startsWith("data:") || v.startsWith("file:")
  );
}

// portfolio_channel_cards 한 카드 입력을 sanitize 한 결과.
// card_index 는 server-side 에서 배열 위치 + 1 로 stamp 한다.
type SanitizedChannelCard = {
  card_index: number;
  channel_name: string | null;
  platform: string | null;
  management: string | null;
  start_year: string | null;
  start_month: string | null;
  start_day: string | null;
  rating: string | null;
  status: string | null;
  link: string | null;
  image_urls: string[] | null;
  insight: string | null;
  experience: string | null;
  metrics: string | null;
};

function sanitizeChannelCard(
  raw: unknown,
  cardIndex: number,
): {
  card: SanitizedChannelCard;
  strippedLink: boolean;
  strippedImageCount: number;
} {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;

  const text: Record<ChannelCardEditableTextField, string | null> = {
    channel_name: null,
    platform: null,
    management: null,
    start_year: null,
    start_month: null,
    start_day: null,
    rating: null,
    status: null,
    link: null,
    insight: null,
    experience: null,
    metrics: null,
  };

  let strippedLink = false;
  for (const key of CHANNEL_CARD_EDITABLE_TEXT_FIELDS) {
    if (key === "link") {
      if (isLocalPreviewUrl(src.link)) strippedLink = true;
      text.link = sanitizeUrl(src.link);
    } else {
      text[key] = sanitizeText(src[key]);
    }
  }

  // image_urls — 최대 CHANNEL_CARD_IMAGE_URL_SLOTS 슬롯까지만 검사.
  // null / blob: / data: / file: 항목 제외. 결과가 빈 array 면 null 저장.
  let strippedImageCount = 0;
  const rawImages = Array.isArray(src.image_urls) ? src.image_urls : [];
  const limited = rawImages.slice(0, CHANNEL_CARD_IMAGE_URL_SLOTS);
  const cleaned: string[] = [];
  for (const u of limited) {
    if (isLocalPreviewUrl(u)) strippedImageCount += 1;
    const sanitized = sanitizeUrl(u);
    if (sanitized) cleaned.push(sanitized);
  }

  return {
    card: {
      card_index: cardIndex,
      ...text,
      image_urls: cleaned.length > 0 ? cleaned : null,
    },
    strippedLink,
    strippedImageCount,
  };
}

function isCardEmpty(card: SanitizedChannelCard): boolean {
  if (card.image_urls && card.image_urls.length > 0) return false;
  for (const key of CHANNEL_CARD_EDITABLE_TEXT_FIELDS) {
    if (card[key] !== null) return false;
  }
  return true;
}

export async function patchCluster3ForCrew(
  legacyUserId: string,
  body: Cluster3PatchBody,
): Promise<{
  bundle: Cluster3Bundle;
  warnings: string[];
  applied: Cluster3ApplySummary;
}> {
  if (!body || typeof body !== "object") {
    throw new Cluster3Error(400, "Invalid body");
  }

  // Phase 4 정책:
  //   - channelCards / outputCards / detailCards 중 한 섹션 이상이 와야 함.
  //   - 각 섹션은 정해진 슬롯 길이를 강제. 길이가 어긋나면 400.
  if (
    body.channelCards === undefined &&
    body.outputCards === undefined &&
    body.detailCards === undefined
  ) {
    throw new Cluster3Error(400, "No updatable sections in body");
  }

  if (body.channelCards !== undefined) {
    if (!Array.isArray(body.channelCards)) {
      throw new Cluster3Error(400, "channelCards must be an array");
    }
    if (body.channelCards.length !== CHANNEL_CARD_SLOT_COUNT) {
      throw new Cluster3Error(
        400,
        `channelCards must have length ${CHANNEL_CARD_SLOT_COUNT} (got ${body.channelCards.length})`,
      );
    }
  }

  if (body.outputCards !== undefined) {
    if (!Array.isArray(body.outputCards)) {
      throw new Cluster3Error(400, "outputCards must be an array");
    }
    if (body.outputCards.length !== OUTPUT_CARD_SLOT_COUNT) {
      throw new Cluster3Error(
        400,
        `outputCards must have length ${OUTPUT_CARD_SLOT_COUNT} (got ${body.outputCards.length})`,
      );
    }
  }

  if (body.detailCards !== undefined) {
    if (!Array.isArray(body.detailCards)) {
      throw new Cluster3Error(400, "detailCards must be an array");
    }
    if (body.detailCards.length !== DETAIL_CARD_SLOT_COUNT) {
      throw new Cluster3Error(
        400,
        `detailCards must have length ${DETAIL_CARD_SLOT_COUNT} (got ${body.detailCards.length})`,
      );
    }
  }

  const userId = await resolveUserId(legacyUserId);
  if (!userId) {
    throw new Cluster3Error(
      409,
      "user_profiles 매칭 행이 없어 cluster3 데이터를 수정할 수 없습니다.",
    );
  }

  const warnings: string[] = [];
  const applied: Cluster3ApplySummary = {};
  const nowIso = new Date().toISOString();

  // ─────────────────────────────────────────────────────────────────
  // Section A: channelCards → portfolio_channel_cards
  // ─────────────────────────────────────────────────────────────────
  if (body.channelCards !== undefined) {
    // 16 카드 전부 sanitize. card_index 는 배열 위치 기반 server-side stamp.
    // 클라이언트가 보낸 card_index 필드는 무시된다.
    const sanitized: SanitizedChannelCard[] = [];
    let totalStrippedLink = 0;
    let totalStrippedImage = 0;
    for (let i = 0; i < CHANNEL_CARD_SLOT_COUNT; i++) {
      const { card, strippedLink, strippedImageCount } = sanitizeChannelCard(
        body.channelCards[i],
        i + 1,
      );
      sanitized.push(card);
      if (strippedLink) totalStrippedLink += 1;
      totalStrippedImage += strippedImageCount;
    }

    if (totalStrippedLink > 0) {
      warnings.push(
        `[channel] link blob:/data:/file: ${totalStrippedLink}개 슬롯에서 발견되어 null 로 저장했습니다.`,
      );
    }
    if (totalStrippedImage > 0) {
      warnings.push(
        `[channel] image_urls blob:/data:/file: ${totalStrippedImage}개를 제외했습니다.`,
      );
    }

    // 빈 카드 정책:
    //   - 모든 text 필드가 null 이고 image_urls 도 빈 array → DB row 만들지 않음
    //   - 기존 row 가 있다면 같은 card_index 로 delete
    const nonEmpty = sanitized.filter((c) => !isCardEmpty(c));
    const empty = sanitized.filter((c) => isCardEmpty(c));
    const upsertedIndices = nonEmpty.map((c) => c.card_index);
    const deletedIndices = empty.map((c) => c.card_index);

    if (deletedIndices.length > 0) {
      const { error: delErr } = await supabaseAdmin
        .from("portfolio_channel_cards")
        .delete()
        .eq("user_id", userId)
        .in("card_index", deletedIndices);
      if (delErr) {
        console.error(
          "[cluster3] query failed (delete portfolio_channel_cards)",
          { userId, message: delErr.message },
        );
        throw new Cluster3Error(500, delErr.message);
      }
    }

    if (nonEmpty.length > 0) {
      const records = nonEmpty.map((c) => ({
        user_id: userId,
        card_index: c.card_index,
        channel_name: c.channel_name,
        platform: c.platform,
        management: c.management,
        start_year: c.start_year,
        start_month: c.start_month,
        start_day: c.start_day,
        rating: c.rating,
        status: c.status,
        link: c.link,
        image_urls: c.image_urls,
        insight: c.insight,
        experience: c.experience,
        metrics: c.metrics,
        updated_at: nowIso,
      }));

      const { error: upErr } = await supabaseAdmin
        .from("portfolio_channel_cards")
        .upsert(records, { onConflict: "user_id,card_index" });
      if (upErr) {
        console.error(
          "[cluster3] query failed (upsert portfolio_channel_cards)",
          { userId, message: upErr.message },
        );
        throw new Cluster3Error(500, upErr.message);
      }
    }

    applied.channelCards = {
      upserted: nonEmpty.length,
      deleted: deletedIndices.length,
      upsertedIndices,
      deletedIndices,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Section B/C: portfolio_top_cards WHERE card_type='output' | 'detail'
  //
  // output / detail 은 같은 테이블·같은 row shape 이며 card_type 만 다르다.
  // 한 헬퍼로 처리하되, 호출마다 반드시 다음을 강제한다:
  //   1. card_type 은 server-side hardcoded stamp. 클라이언트 입력은 무시.
  //   2. 모든 supabase 호출에 .eq("card_type", cardType) scope 포함 —
  //      output 호출이 detail row 를 mutate 하거나 그 반대가 일어나선 안 됨.
  //   3. onConflict 키는 (user_id, card_type, card_index) — 같은 card_index 의
  //      다른 card_type row 와 충돌하지 않도록 card_type 까지 포함.
  // ─────────────────────────────────────────────────────────────────
  if (body.outputCards !== undefined) {
    await applyTopCardsSection({
      userId,
      cardType: "output",
      slotCount: OUTPUT_CARD_SLOT_COUNT,
      payload: body.outputCards,
      nowIso,
      warnings,
      applied,
    });
  }

  if (body.detailCards !== undefined) {
    await applyTopCardsSection({
      userId,
      cardType: "detail",
      slotCount: DETAIL_CARD_SLOT_COUNT,
      payload: body.detailCards as unknown[],
      nowIso,
      warnings,
      applied,
    });
  }

  const bundle = await getCluster3ForCrew(legacyUserId);
  return { bundle, warnings, applied };
}

// ─────────────────────────────────────────────────────────────────────
// portfolio_top_cards sanitize 헬퍼
//
// Phase 3 는 output 만 호출. Phase 4 에서 동일 헬퍼를 detail 에도 재사용한다.
// card_type 은 호출자가 hardcoded 로 stamp 하기 때문에 여기서는 받지 않는다.
// ─────────────────────────────────────────────────────────────────────

type SanitizedTopCard = {
  card_index: number;
  // text scalars
  main_title: string | null;
  sub_title: string | null;
  role_description: string | null;
  report: string | null;
  insight: string | null;
  platform: string | null;
  main_image_caption: string | null;
  // url scalar
  main_image_url: string | null;
  // number scalars
  contribution: number | null;
  period_start_year: number | null;
  period_start_month: number | null;
  period_start_day: number | null;
  period_end_year: number | null;
  period_end_month: number | null;
  period_end_day: number | null;
  // arrays
  roles: string[] | null;
  tools: string[] | null;
  sub_image_urls: string[] | null;
  sub_image_captions: string[] | null;
  metrics: string[] | null;
  links: string[] | null;
};

function sanitizeInt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

// 일반 text[] 입력을 sanitize 한다.
//   - 항목별 trim + null/empty 제거
//   - sanitizeFn 으로 각 항목 후가공 (URL 정규화 등)
//   - cap 까지만 slice
//   - 결과가 빈 array 면 null 반환 (DB 가 빈 배열 대신 NULL 을 저장하도록)
function sanitizeStringArray(
  raw: unknown,
  options: {
    cap?: number;
    sanitizeFn?: (value: unknown) => string | null;
    onStripped?: () => void;
  } = {},
): string[] | null {
  if (!Array.isArray(raw)) return null;
  const sanitize = options.sanitizeFn ?? sanitizeText;
  const limited = typeof options.cap === "number" ? raw.slice(0, options.cap) : raw;
  const out: string[] = [];
  for (const item of limited) {
    if (options.onStripped && isLocalPreviewUrl(item)) options.onStripped();
    const v = sanitize(item);
    if (v) out.push(v);
  }
  return out.length > 0 ? out : null;
}

function sanitizeTopCard(
  raw: unknown,
  cardIndex: number,
): {
  card: SanitizedTopCard;
  strippedMainImage: boolean;
  strippedSubImageCount: number;
} {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;

  // text scalars
  const text: Record<TopCardEditableTextField, string | null> = {
    main_title: null,
    sub_title: null,
    role_description: null,
    report: null,
    insight: null,
    platform: null,
    main_image_caption: null,
  };
  for (const key of TOP_CARD_EDITABLE_TEXT_FIELDS) {
    text[key] = sanitizeText(src[key]);
  }

  // url scalar
  const strippedMainImage = isLocalPreviewUrl(src.main_image_url);
  const main_image_url = sanitizeUrl(src.main_image_url);

  // number scalars
  const ints: Record<TopCardEditableIntField, number | null> = {
    contribution: null,
    period_start_year: null,
    period_start_month: null,
    period_start_day: null,
    period_end_year: null,
    period_end_month: null,
    period_end_day: null,
  };
  for (const key of TOP_CARD_EDITABLE_INT_FIELDS) {
    ints[key] = sanitizeInt(src[key]);
  }

  // dynamic arrays
  const roles = sanitizeStringArray(src.roles);
  const tools = sanitizeStringArray(src.tools);

  // fixed-slot arrays
  let strippedSubImageCount = 0;
  const sub_image_urls = sanitizeStringArray(src.sub_image_urls, {
    cap: TOP_CARD_SUB_IMAGE_SLOTS,
    sanitizeFn: sanitizeUrl,
    onStripped: () => {
      strippedSubImageCount += 1;
    },
  });
  const sub_image_captions = sanitizeStringArray(src.sub_image_captions, {
    cap: TOP_CARD_SUB_IMAGE_CAPTION_SLOTS,
  });
  const metrics = sanitizeStringArray(src.metrics, { cap: TOP_CARD_METRIC_SLOTS });
  const links = sanitizeStringArray(src.links, { cap: TOP_CARD_LINK_SLOTS });

  return {
    card: {
      card_index: cardIndex,
      ...text,
      main_image_url,
      ...ints,
      roles,
      tools,
      sub_image_urls,
      sub_image_captions,
      metrics,
      links,
    },
    strippedMainImage,
    strippedSubImageCount,
  };
}

function isTopCardEmpty(card: SanitizedTopCard): boolean {
  for (const key of TOP_CARD_EDITABLE_TEXT_FIELDS) {
    if (card[key] !== null) return false;
  }
  if (card.main_image_url !== null) return false;
  for (const key of TOP_CARD_EDITABLE_INT_FIELDS) {
    if (card[key] !== null) return false;
  }
  if (card.roles && card.roles.length > 0) return false;
  if (card.tools && card.tools.length > 0) return false;
  if (card.sub_image_urls && card.sub_image_urls.length > 0) return false;
  if (card.sub_image_captions && card.sub_image_captions.length > 0)
    return false;
  if (card.metrics && card.metrics.length > 0) return false;
  if (card.links && card.links.length > 0) return false;
  return true;
}

// portfolio_top_cards 한 card_type 의 모든 슬롯을 sanitize → empty 삭제 + non-empty
// upsert 흐름으로 replace 한다. output / detail 공용.
//
// 회귀 보호:
//   - delete / upsert 모두 .eq("card_type", cardType) scope 강제.
//   - card_index 는 배열 위치 + 1 로 server stamp. 클라이언트 값은 무시.
//   - duplicate card_index 는 발생 불가 (배열 위치로만 stamp 되기 때문).
async function applyTopCardsSection(args: {
  userId: string;
  cardType: TopCardType;
  slotCount: number;
  payload: ReadonlyArray<unknown>;
  nowIso: string;
  warnings: string[];
  applied: Cluster3ApplySummary;
}): Promise<void> {
  const { userId, cardType, slotCount, payload, nowIso, warnings, applied } =
    args;

  const sanitized: SanitizedTopCard[] = [];
  let totalStrippedMainImage = 0;
  let totalStrippedSubImage = 0;
  for (let i = 0; i < slotCount; i++) {
    const { card, strippedMainImage, strippedSubImageCount } = sanitizeTopCard(
      payload[i],
      i + 1,
    );
    sanitized.push(card);
    if (strippedMainImage) totalStrippedMainImage += 1;
    totalStrippedSubImage += strippedSubImageCount;
  }

  if (totalStrippedMainImage > 0) {
    warnings.push(
      `[${cardType}] main_image_url blob:/data:/file: ${totalStrippedMainImage}개 슬롯에서 null 로 정규화했습니다.`,
    );
  }
  if (totalStrippedSubImage > 0) {
    warnings.push(
      `[${cardType}] sub_image_urls blob:/data:/file: ${totalStrippedSubImage}개를 제외했습니다.`,
    );
  }

  const nonEmpty = sanitized.filter((c) => !isTopCardEmpty(c));
  const empty = sanitized.filter((c) => isTopCardEmpty(c));
  const upsertedIndices = nonEmpty.map((c) => c.card_index);
  const deletedIndices = empty.map((c) => c.card_index);

  // (1) 빈 슬롯 row 삭제 — 반드시 card_type scope 포함 (다른 card_type row 보호)
  if (deletedIndices.length > 0) {
    const { error: delErr } = await supabaseAdmin
      .from("portfolio_top_cards")
      .delete()
      .eq("user_id", userId)
      .eq("card_type", cardType)
      .in("card_index", deletedIndices);
    if (delErr) {
      console.error(
        `[cluster3] query failed (delete portfolio_top_cards ${cardType})`,
        { userId, message: delErr.message },
      );
      throw new Cluster3Error(500, delErr.message);
    }
  }

  // (2) 비어있지 않은 슬롯 upsert — card_type 은 server stamp.
  //     id 는 supply 하지 않음 (기존 row 는 onConflict update, 신규 row 는 DB default).
  if (nonEmpty.length > 0) {
    const records = nonEmpty.map((c) =>
      buildTopCardRecord(userId, cardType, c, nowIso),
    );

    const { error: upErr } = await supabaseAdmin
      .from("portfolio_top_cards")
      .upsert(records, { onConflict: "user_id,card_type,card_index" });
    if (upErr) {
      console.error(
        `[cluster3] query failed (upsert portfolio_top_cards ${cardType})`,
        { userId, message: upErr.message },
      );
      throw new Cluster3Error(500, upErr.message);
    }
  }

  applied.topCards = {
    ...(applied.topCards ?? {}),
    [cardType]: {
      upserted: nonEmpty.length,
      deleted: deletedIndices.length,
      upsertedIndices,
      deletedIndices,
    },
  };
}

// upsert 용 DB row 변환. card_type 은 호출자가 hardcoded 로 stamp.
function buildTopCardRecord(
  userId: string,
  cardType: TopCardType,
  c: SanitizedTopCard,
  nowIso: string,
): Record<string, unknown> {
  return {
    user_id: userId,
    card_type: cardType,
    card_index: c.card_index,
    main_title: c.main_title,
    sub_title: c.sub_title,
    role_description: c.role_description,
    report: c.report,
    insight: c.insight,
    platform: c.platform,
    main_image_caption: c.main_image_caption,
    main_image_url: c.main_image_url,
    contribution: c.contribution,
    period_start_year: c.period_start_year,
    period_start_month: c.period_start_month,
    period_start_day: c.period_start_day,
    period_end_year: c.period_end_year,
    period_end_month: c.period_end_month,
    period_end_day: c.period_end_day,
    roles: c.roles,
    tools: c.tools,
    sub_image_urls: c.sub_image_urls,
    sub_image_captions: c.sub_image_captions,
    metrics: c.metrics,
    links: c.links,
    updated_at: nowIso,
  };
}

// 명시적 re-export 으로 client 측에서 helper 타입을 가져갈 수 있게 한다.
export type { ChannelCardInput, TopCardInput };
