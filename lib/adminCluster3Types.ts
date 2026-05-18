// Browser-safe types and constants for the Cluster3 admin viewer.
// Must not import server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.
//
// ─────────────────────────────────────────────────────────────────────
// Canonical schema (확인 2026-05-15)
//
//   portfolio_channel_cards (1:N, unique(user_id, card_index))
//     id uuid NOT NULL
//     user_id uuid NOT NULL
//     card_index smallint NOT NULL                         -- 1~16
//     channel_name / platform / management / status text NULL
//     start_year / start_month / start_day text NULL
//     rating / link / insight / experience / metrics text NULL
//     image_urls text[] NULL
//     created_at / updated_at timestamptz NULL
//
//   portfolio_top_cards (1:N, unique(user_id, card_type, card_index))
//     id uuid NOT NULL
//     user_id uuid NOT NULL
//     card_type text NOT NULL                              -- 'output' | 'detail'
//     card_index smallint NOT NULL                         -- output 1~5, detail 1~10
//     main_title / sub_title / role_description / report / insight text NULL
//     platform / main_image_url / main_image_caption text NULL
//     contribution / period_*_year / period_*_month / period_*_day smallint NULL
//     roles / tools / sub_image_urls / sub_image_captions / metrics / links text[] NULL
//     created_at / updated_at timestamptz NULL
//
// 정책 (Phase 4):
//   - portfolio_detail_cards 테이블 가정 금지 — detail 은 portfolio_top_cards.card_type='detail'.
//   - slot_index / sort_order 컬럼 없음. 슬롯 식별자는 card_index.
//   - portfolio_channel_cards write 허용.
//   - portfolio_top_cards card_type='output' (1~5) write 허용.
//   - portfolio_top_cards card_type='detail' (1~10) write 허용 (Phase 4 신규).
//     output 과 동일한 row shape / sanitize / replace 흐름. card_type 만 다름.
// ─────────────────────────────────────────────────────────────────────

export const CHANNEL_CARD_SLOT_COUNT = 16;
export const OUTPUT_CARD_SLOT_COUNT = 5;
export const DETAIL_CARD_SLOT_COUNT = 10;

export type TopCardType = "output" | "detail";

// portfolio_channel_cards row — 17 confirmed columns
export type ChannelCardRow = {
  id: string;
  user_id: string;
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
  created_at: string | null;
  updated_at: string | null;
};

// portfolio_top_cards row — 27 confirmed columns. output / detail 공유.
export type TopCardRow = {
  id: string;
  user_id: string;
  card_type: TopCardType;
  card_index: number;
  main_title: string | null;
  sub_title: string | null;
  role_description: string | null;
  report: string | null;
  insight: string | null;
  platform: string | null;
  contribution: number | null;
  period_start_year: number | null;
  period_start_month: number | null;
  period_start_day: number | null;
  period_end_year: number | null;
  period_end_month: number | null;
  period_end_day: number | null;
  roles: string[] | null;
  tools: string[] | null;
  main_image_url: string | null;
  sub_image_urls: string[] | null;
  main_image_caption: string | null;
  sub_image_captions: string[] | null;
  metrics: string[] | null;
  links: string[] | null;
  created_at: string | null;
  updated_at: string | null;
};

// row 부재 슬롯도 자리는 유지. UI 가 16/5/10 카드를 항상 그릴 수 있게 한다.
export type ChannelCardSlot = {
  cardIndex: number;
  row: ChannelCardRow | null;
};

export type TopCardSlot = {
  cardIndex: number;
  row: TopCardRow | null;
};

export type Cluster3Bundle = {
  legacyUserId: string;
  userId: string | null;
  channelCards: ChannelCardSlot[]; // length CHANNEL_CARD_SLOT_COUNT (16)
  outputCards: TopCardSlot[]; // length OUTPUT_CARD_SLOT_COUNT (5)
  detailCards: TopCardSlot[]; // length DETAIL_CARD_SLOT_COUNT (10)
};

// ─────────────────────────────────────────────────────────────────────
// PATCH input types
//
//   - 클라이언트는 card_index 를 절대 전달하지 않는다. 서버가 배열 위치에서
//     1~slotCount 로 stamp 한다.
//   - card_type 도 클라이언트가 전달하지 않는다. 서버가 outputCards / detailCards
//     섹션 키에서 'output' / 'detail' 로 hardcoded stamp.
// ─────────────────────────────────────────────────────────────────────

// portfolio_channel_cards 의 admin editable text 컬럼 12개.
// 이 목록은 server-side `pickWritable` 화이트리스트 및 client form 양쪽에서 공유한다.
// id / user_id / card_index / image_urls / created_at / updated_at 는 제외.
export const CHANNEL_CARD_EDITABLE_TEXT_FIELDS = [
  "channel_name",
  "platform",
  "management",
  "start_year",
  "start_month",
  "start_day",
  "rating",
  "status",
  "link",
  "insight",
  "experience",
  "metrics",
] as const;

export type ChannelCardEditableTextField =
  (typeof CHANNEL_CARD_EDITABLE_TEXT_FIELDS)[number];

// UI 에서 노출하는 image_urls 입력 슬롯 개수. DB 컬럼은 text[] 라 길이 제한
// 자체는 없지만, admin editor 는 5 슬롯으로 제한해 일관된 폼을 제공한다.
// 빈/blob/data/file URL 은 server-side 에서 정규화되어 최종 array 에서 제외된다.
export const CHANNEL_CARD_IMAGE_URL_SLOTS = 5;

export type ChannelCardInput = {
  [K in ChannelCardEditableTextField]: string | null;
} & {
  // 클라이언트 보낼 때 길이 0~CHANNEL_CARD_IMAGE_URL_SLOTS. null 항목은 server 가 제외.
  image_urls: (string | null)[];
};

// ─────────────────────────────────────────────────────────────────────
// portfolio_top_cards array column 의 admin UI 슬롯 수
//
//   sub_image_urls       : 2 슬롯  (사용자 명세 sub_image_urls[0~1])
//   sub_image_captions   : 2 슬롯  (sub_image_captions[0~1])
//   metrics              : 6 슬롯  (metrics[0~5])
//   links                : 3 슬롯  (links[0~2])
//
// roles / tools 는 사용자 명세에 길이 제한이 없으므로 UI 에서 textarea 한 줄당
// 한 항목으로 입력받는다. 별도 슬롯 상수 없음.
//
// DB 컬럼은 모두 text[] NULL — 길이 제한 자체는 DB 가 강제하지 않는다. 위 UI
// 상수는 admin 입력폼의 표준 슬롯 수일 뿐이며, server-side sanitize 가 같은
// 상수로 길이를 cap 한다. DB row 의 기존 더 긴 배열은 cap 만큼만 form 에 노출되며,
// 저장 시 cap 이후 항목은 잘려나간다 (의도된 정책 — admin editor 가 길이 표준화).
// ─────────────────────────────────────────────────────────────────────
export const TOP_CARD_SUB_IMAGE_SLOTS = 2;
export const TOP_CARD_SUB_IMAGE_CAPTION_SLOTS = 2;
export const TOP_CARD_METRIC_SLOTS = 6;
export const TOP_CARD_LINK_SLOTS = 3;

// portfolio_top_cards 의 admin editable text scalar 8개.
export const TOP_CARD_EDITABLE_TEXT_FIELDS = [
  "main_title",
  "sub_title",
  "role_description",
  "report",
  "insight",
  "platform",
  "main_image_caption",
] as const;

// main_image_url 은 별도 sanitize (blob:/data:/file: 제외) 처리 — 위 list 와 분리.
// portfolio_top_cards 의 admin editable smallint scalar 7개.
export const TOP_CARD_EDITABLE_INT_FIELDS = [
  "contribution",
  "period_start_year",
  "period_start_month",
  "period_start_day",
  "period_end_year",
  "period_end_month",
  "period_end_day",
] as const;

export type TopCardEditableTextField =
  (typeof TOP_CARD_EDITABLE_TEXT_FIELDS)[number];

export type TopCardEditableIntField =
  (typeof TOP_CARD_EDITABLE_INT_FIELDS)[number];

// portfolio_top_cards 한 row 의 PATCH input shape.
// card_type / card_index 는 절대 포함하지 않는다 — server 가 stamp 한다.
// id / user_id / created_at / updated_at 도 클라이언트 입력 대상 아님.
export type TopCardInput = {
  // text scalars (7)
  main_title: string | null;
  sub_title: string | null;
  role_description: string | null;
  report: string | null;
  insight: string | null;
  platform: string | null;
  main_image_caption: string | null;
  // url scalar (1, blob:/data:/file: 정규화 대상)
  main_image_url: string | null;
  // number scalars (7)
  contribution: number | null;
  period_start_year: number | null;
  period_start_month: number | null;
  period_start_day: number | null;
  period_end_year: number | null;
  period_end_month: number | null;
  period_end_day: number | null;
  // dynamic text[] — server filters empty/null. 길이 제한 없음.
  roles: (string | null)[];
  tools: (string | null)[];
  // fixed-slot text[] — server caps to TOP_CARD_* 상수 길이.
  // null/blob URL 은 정규화 후 제외.
  sub_image_urls: (string | null)[];
  sub_image_captions: (string | null)[];
  metrics: (string | null)[];
  links: (string | null)[];
};

export type Cluster3PatchBody = {
  // 길이 CHANNEL_CARD_SLOT_COUNT(16) 강제. 서버에서 검증.
  channelCards?: ChannelCardInput[];
  // 길이 OUTPUT_CARD_SLOT_COUNT(5) 강제. server 가 card_type='output' stamp.
  outputCards?: TopCardInput[];
  // 길이 DETAIL_CARD_SLOT_COUNT(10) 강제. server 가 card_type='detail' stamp.
  detailCards?: TopCardInput[];
};

// PATCH 응답의 applied 필드 — 클라이언트 DebugSection 에 표시.
// "어느 슬롯이 upsert 되었고 어느 슬롯이 비어서 delete 되었는가" 를
// indices 까지 노출해 회귀 진단을 돕는다.
//
// topCards 객체는 어떤 card_type 이 건드려졌는지 명시한다. output / detail 은
// 각자의 키에만 등장 — output 호출이 detail 키를 생성하거나 그 반대가 일어나선 안 됨.
export type Cluster3ApplySummary = {
  channelCards?: {
    upserted: number;
    deleted: number;
    upsertedIndices: number[];
    deletedIndices: number[];
  };
  topCards?: {
    output?: {
      upserted: number;
      deleted: number;
      upsertedIndices: number[]; // 1~5
      deletedIndices: number[];
    };
    detail?: {
      upserted: number;
      deleted: number;
      upsertedIndices: number[]; // 1~10
      deletedIndices: number[];
    };
  };
};
