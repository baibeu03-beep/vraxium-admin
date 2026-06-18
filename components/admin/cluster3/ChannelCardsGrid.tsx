"use client";

import { FieldCell, type FieldDef } from "@/components/admin/fieldKit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  CHANNEL_CARD_IMAGE_URL_SLOTS,
  type ChannelCardSlot,
} from "@/lib/adminCluster3Types";
import {
  MANAGEMENT_OPTIONS,
  PLATFORM_OPTIONS,
  STATUS_OPTIONS,
  isCanonicalManagement,
  isCanonicalPlatform,
  isCanonicalStatus,
} from "@/lib/cluster3Options";

// portfolio_channel_cards 16 슬롯 editable grid (Phase 2).
// card_index 1~16 은 슬롯 자리 고정. 클라이언트는 card_index 를 PATCH body 에
// 전달하지 않는다 — server 가 배열 위치에서 stamp 한다.
// 빈 카드는 server 에서 row 미작성 처리.

// form state 한 카드의 shape (Cluster3Editor 와 공유).
export type ChannelCardFormCard = {
  channel_name: string | null;
  platform: string | null;
  management: string | null;
  start_year: string | null;
  start_month: string | null;
  start_day: string | null;
  rating: string | null;
  status: string | null;
  link: string | null;
  image_urls: (string | null)[]; // 길이 CHANNEL_CARD_IMAGE_URL_SLOTS 고정 (UI 표준화)
  insight: string | null;
  experience: string | null;
  metrics: string | null;
};

// platform / management / status 는 select 로 별도 렌더 (canonical + legacy
// fallback). 나머지 9개는 plain text/url/textarea 필드.
const CHANNEL_CARD_OPERATOR_LABELS: Record<string, string> = {
  channel_name: "채널 이름",
  start_year: "시작 연도",
  start_month: "시작 월",
  start_day: "시작 일",
  rating: "평점",
  link: "링크",
  insight: "인사이트",
  experience: "경험",
  metrics: "성과 지표",
  platform: "플랫폼",
  management: "운영 방식",
  status: "상태",
};

function operatorizeFields(
  fields: readonly FieldDef[],
  devMode: boolean,
): readonly FieldDef[] {
  if (devMode) return fields;
  return fields.map((f) => ({
    ...f,
    label: CHANNEL_CARD_OPERATOR_LABELS[f.key] ?? f.label,
  }));
}

const CHANNEL_CARD_TEXT_FIELDS: readonly FieldDef[] = [
  { key: "channel_name", label: "channel_name", type: "text", full: true },
  { key: "start_year", label: "start_year", type: "text", placeholder: "YYYY" },
  { key: "start_month", label: "start_month", type: "text", placeholder: "MM" },
  { key: "start_day", label: "start_day", type: "text", placeholder: "DD" },
  { key: "rating", label: "rating", type: "text" },
  { key: "link", label: "link", type: "url", full: true },
  { key: "insight", label: "insight", type: "textarea", full: true },
  { key: "experience", label: "experience", type: "textarea", full: true },
  { key: "metrics", label: "metrics (text)", type: "textarea", full: true },
];

function isRenderableImageUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  return (
    v.startsWith("http://") || v.startsWith("https://") || v.startsWith("/")
  );
}

function isLocalPreviewUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  return (
    v.startsWith("blob:") || v.startsWith("data:") || v.startsWith("file:")
  );
}

function ImageUrlSlot({
  index,
  value,
  onChange,
  disabled,
  devMode = false,
}: {
  index: number;
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  devMode?: boolean;
}) {
  const current = value ?? "";
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[10px]">
        {devMode ? `image_urls[${index}]` : `이미지 ${index + 1}`}
      </Label>
      <Input
        type="url"
        value={current}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === "" ? null : raw);
        }}
        placeholder="https://..."
        disabled={disabled}
      />
      {isRenderableImageUrl(current) ? (
        <div className="flex h-16 items-center justify-center overflow-hidden rounded border bg-muted/30">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current}
            alt={`image_urls[${index}]`}
            className="h-full w-auto object-contain"
          />
        </div>
      ) : isLocalPreviewUrl(current) ? (
        <div className="flex h-16 flex-col items-center justify-center rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-center text-[9px] text-amber-900">
          <div className="font-medium">Local preview URL</div>
          <div>저장 시 null 로 정규화</div>
        </div>
      ) : current ? (
        <div className="flex h-16 flex-col items-center justify-center rounded border border-dashed bg-muted/10 text-[9px] text-muted-foreground">
          <div className="font-medium">No valid URL</div>
        </div>
      ) : (
        <div className="flex h-16 items-center justify-center rounded border border-dashed bg-muted/10 text-[9px] text-muted-foreground">
          empty
        </div>
      )}
    </div>
  );
}

function ChannelSlotCard({
  cardIndex,
  meta,
  card,
  onChange,
  disabled,
  devMode = false,
}: {
  cardIndex: number;
  meta: ChannelCardSlot;
  card: ChannelCardFormCard;
  onChange: (next: ChannelCardFormCard) => void;
  disabled?: boolean;
  devMode?: boolean;
}) {
  const row = meta.row;
  const isEmptyStr = (v: unknown) =>
    v == null || (typeof v === "string" && v.trim() === "");
  const everyTextEmpty =
    CHANNEL_CARD_TEXT_FIELDS.every((f) =>
      isEmptyStr((card as Record<string, unknown>)[f.key]),
    ) &&
    isEmptyStr(card.platform) &&
    isEmptyStr(card.management) &&
    isEmptyStr(card.status);
  const everyImageEmpty = card.image_urls.every((u) => !u || u.trim() === "");
  const cardIsEmpty = everyTextEmpty && everyImageEmpty;

  const setField = (key: string, value: unknown) => {
    onChange({
      ...card,
      [key]: value as string | null,
    });
  };

  const setImageUrl = (slotIdx: number, next: string | null) => {
    const list = [...card.image_urls];
    list[slotIdx] = next;
    onChange({ ...card, image_urls: list });
  };

  // Canonical + legacy fallback FieldDef 생성기 — Cluster2 slogan tag 패턴.
  const buildSelectField = (
    key: "platform" | "management" | "status",
    label: string,
    options: readonly string[],
    isCanonical: (v: unknown) => boolean,
  ): { field: FieldDef; isLegacy: boolean; legacyValue: string } => {
    const raw = card[key];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    const isLegacy = trimmed.length > 0 && !isCanonical(trimmed);
    const field: FieldDef = {
      key,
      label,
      type: "select",
      options: isLegacy ? [...options, trimmed] : options,
    };
    return { field, isLegacy, legacyValue: trimmed };
  };

  const platformSel = buildSelectField(
    "platform",
    "platform",
    PLATFORM_OPTIONS,
    isCanonicalPlatform,
  );
  const managementSel = buildSelectField(
    "management",
    "management",
    MANAGEMENT_OPTIONS,
    isCanonicalManagement,
  );
  const statusSel = buildSelectField(
    "status",
    "status",
    STATUS_OPTIONS,
    isCanonicalStatus,
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border p-3 text-xs",
        cardIsEmpty ? "border-dashed bg-muted/10" : "bg-background",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold">
          {devMode ? `card_index ${cardIndex}` : `채널 카드 ${cardIndex}`}
          {devMode && (
            <span className="ml-1 font-normal text-muted-foreground">
              (server-stamped)
            </span>
          )}
        </div>
        <span
          className={cn(
            "rounded-full border px-1.5 py-0.5 text-[10px]",
            cardIsEmpty
              ? "border-border bg-muted text-muted-foreground"
              : row
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-sky-200 bg-sky-50 text-sky-700",
          )}
        >
          {cardIsEmpty
            ? devMode
              ? "empty (no DB row)"
              : "비어 있음"
            : row
              ? devMode
                ? "DB row"
                : "저장됨"
              : devMode
                ? "신규 (저장 시 insert)"
                : "신규 (저장 시 등록)"}
        </span>
      </div>

      {cardIsEmpty && (
        <div className="rounded border border-dashed bg-muted/20 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {devMode
            ? "모든 필드가 비어있어 저장 시 DB row 를 생성하지 않습니다. 기존 row 가 있었다면 해당 card_index 의 row 가 삭제됩니다."
            : "모든 항목이 비어 있어 저장하지 않습니다. 이전에 저장된 내용이 있다면 이 카드 자리는 비워집니다."}
        </div>
      )}

      {/* text/url fields */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {operatorizeFields(CHANNEL_CARD_TEXT_FIELDS, devMode).map((field) => (
          <FieldCell
            key={field.key}
            field={field}
            value={(card as Record<string, unknown>)[field.key]}
            onChange={(v) => setField(field.key, v)}
            disabled={disabled}
          />
        ))}
        {/* platform / management / status — canonical select + legacy fallback */}
        {operatorizeFields(
          [platformSel.field, managementSel.field, statusSel.field],
          devMode,
        ).map((field, i) => {
          const sel = [platformSel, managementSel, statusSel][i];
          return (
          <div key={field.key} className="flex flex-col gap-1">
            <FieldCell
              field={field}
              value={(card as Record<string, unknown>)[field.key]}
              onChange={(v) => setField(field.key, v)}
              disabled={disabled}
            />
            {sel.isLegacy && (
              <p className="text-[10px] text-amber-700">
                기존 값{" "}
                <code className="font-mono">{sel.legacyValue}</code> 은 canonical
                옵션에 없습니다. 다른 옵션을 고르면 덮어쓰입니다.
              </p>
            )}
          </div>
          );
        })}
      </div>

      {/* image_urls slots */}
      <div className="mt-1">
        <div className="mb-1 text-[10px] font-medium text-muted-foreground">
          {devMode
            ? `image_urls (text[]) · 최대 ${CHANNEL_CARD_IMAGE_URL_SLOTS} 슬롯`
            : `채널 이미지 · 최대 ${CHANNEL_CARD_IMAGE_URL_SLOTS}개`}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {card.image_urls.map((url, i) => (
            <ImageUrlSlot
              key={i}
              index={i}
              value={url}
              onChange={(next) => setImageUrl(i, next)}
              disabled={disabled}
              devMode={devMode}
            />
          ))}
        </div>
      </div>

      {/* readonly DB meta — dev only */}
      {devMode && (
        <div className="mt-1 border-t pt-1.5 text-[10px] text-muted-foreground">
          {row ? (
            <>
              id <code className="font-mono">{row.id}</code> · created{" "}
              <code className="font-mono">{row.created_at ?? "—"}</code> ·
              updated{" "}
              <code className="font-mono">{row.updated_at ?? "—"}</code>
            </>
          ) : (
            <>portfolio_channel_cards row 없음 (card_index={cardIndex})</>
          )}
        </div>
      )}
    </div>
  );
}

export default function ChannelCardsGrid({
  slots,
  formCards,
  onChangeCard,
  disabled,
  devMode = false,
}: {
  slots: ChannelCardSlot[]; // server-side meta (id/timestamps)
  formCards: ChannelCardFormCard[]; // editable form state
  onChangeCard: (index: number, next: ChannelCardFormCard) => void;
  disabled?: boolean;
  devMode?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      {slots.map((slot, i) => (
        <ChannelSlotCard
          key={slot.cardIndex}
          cardIndex={slot.cardIndex}
          meta={slot}
          card={formCards[i]}
          onChange={(next) => onChangeCard(i, next)}
          disabled={disabled}
          devMode={devMode}
        />
      ))}
    </div>
  );
}
