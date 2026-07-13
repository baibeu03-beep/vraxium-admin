"use client";

import type { ReactNode } from "react";
import { FieldCell, type FieldDef } from "@/components/admin/fieldKit";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import TopCardsList from "@/components/admin/cluster3/TopCardsList";
import {
  TOP_CARD_LINK_SLOTS,
  TOP_CARD_METRIC_SLOTS,
  TOP_CARD_SUB_IMAGE_CAPTION_SLOTS,
  TOP_CARD_SUB_IMAGE_SLOTS,
  type TopCardSlot,
  type TopCardType,
} from "@/lib/adminCluster3Types";
import {
  PLATFORM_OPTIONS,
  ROLE_OPTIONS,
  TOOL_OPTIONS,
  getRoleLabel,
  getToolLabel,
  isCanonicalPlatform,
  isCanonicalRoleKey,
  isCanonicalToolKey,
  type Cluster3KeyLabel,
} from "@/lib/cluster3Options";

// portfolio_top_cards editable slot grid (Phase 3: output 만).
// Phase 4 에서 동일 컴포넌트를 detail (10 슬롯) 에도 재사용한다.
//
// card_index 와 card_type 은 server-side stamp. 클라이언트는 PATCH body 에
// 어느 쪽도 포함하지 않는다.

// FieldCell-driven 폼은 모든 값을 string 으로 다룬다 (FieldInput 이 input.value
// 를 string 으로 받기 때문). 저장 직전 buildPatchBody 가 number/string[] 으로 변환.
//
// roles / tools 는 multi-select 로 관리한다 — UI 는 label 을 보여주지만 폼 state
// 와 DB 에는 영문 key 만 보관한다 (front 와 동일 정책).
export type TopCardFormCard = {
  // text scalars (7)
  main_title: string;
  sub_title: string;
  role_description: string;
  report: string;
  insight: string;
  platform: string; // PLATFORM_OPTIONS 의 한글 label 또는 legacy 값
  main_image_caption: string;
  // url scalar
  main_image_url: string;
  // number scalars (7) — string 으로 저장. buildPatchBody 가 Number() 변환.
  contribution: string;
  period_start_year: string;
  period_start_month: string;
  period_start_day: string;
  period_end_year: string;
  period_end_month: string;
  period_end_day: string;
  // multi-select 결과 — ROLE_OPTIONS / TOOL_OPTIONS 의 key 배열 + legacy key.
  roles: string[];
  tools: string[];
  // fixed-slot text[]
  sub_image_urls: string[]; // length TOP_CARD_SUB_IMAGE_SLOTS
  sub_image_captions: string[]; // length TOP_CARD_SUB_IMAGE_CAPTION_SLOTS
  metrics: string[]; // length TOP_CARD_METRIC_SLOTS
  links: string[]; // length TOP_CARD_LINK_SLOTS
};

// FieldDef list — server 측 TOP_CARD_EDITABLE_TEXT_FIELDS 의 plain text 6개.
// platform 은 select 로 별도 렌더 (PLATFORM_OPTIONS + legacy fallback).
// main_image_caption 은 plain text 로 유지.
// 운영자 모드용 한글 라벨은 OPERATOR_LABELS 에서 lookup. 누락 시 dev label fallback.
const OPERATOR_LABELS: Record<string, string> = {
  main_title: "메인 타이틀",
  sub_title: "서브 타이틀",
  role_description: "역할 설명",
  report: "보고",
  insight: "인사이트",
  main_image_caption: "대표 이미지 캡션",
  contribution: "기여도",
  period_start_year: "시작 연도",
  period_start_month: "시작 월",
  period_start_day: "시작 일",
  period_end_year: "종료 연도",
  period_end_month: "종료 월",
  period_end_day: "종료 일",
  platform: "플랫폼",
};

function operatorizeFields(
  fields: readonly FieldDef[],
  devMode: boolean,
): readonly FieldDef[] {
  if (devMode) return fields;
  return fields.map((f) => ({
    ...f,
    label: OPERATOR_LABELS[f.key] ?? f.label,
  }));
}

const TEXT_FIELDS: readonly FieldDef[] = [
  {
    key: "main_title",
    label: "main_title",
    type: "textarea",
    full: true,
    helpKey: "admin.crews.cluster3.topCard.field.mainTitle",
  },
  {
    key: "sub_title",
    label: "sub_title",
    type: "textarea",
    full: true,
    helpKey: "admin.crews.cluster3.topCard.field.subTitle",
  },
  {
    key: "role_description",
    label: "role_description",
    type: "textarea",
    full: true,
    helpKey: "admin.crews.cluster3.topCard.field.roleDescription",
  },
  {
    key: "report",
    label: "report",
    type: "textarea",
    full: true,
    helpKey: "admin.crews.cluster3.topCard.field.report",
  },
  {
    key: "insight",
    label: "insight",
    type: "textarea",
    full: true,
    helpKey: "admin.crews.cluster3.topCard.field.insight",
  },
  {
    key: "main_image_caption",
    label: "main_image_caption",
    type: "text",
    helpKey: "admin.crews.cluster3.topCard.field.mainImageCaption",
  },
];

const NUMBER_FIELDS: readonly FieldDef[] = [
  {
    key: "contribution",
    label: "contribution (smallint)",
    type: "number",
    helpKey: "admin.crews.cluster3.topCard.field.contribution",
  },
  {
    key: "period_start_year",
    label: "period_start_year (YYYY)",
    type: "number",
    helpKey: "admin.crews.cluster3.topCard.field.periodStartYear",
  },
  {
    key: "period_start_month",
    label: "period_start_month",
    type: "number",
    min: 1,
    max: 12,
    helpKey: "admin.crews.cluster3.topCard.field.periodStartMonth",
  },
  {
    key: "period_start_day",
    label: "period_start_day",
    type: "number",
    min: 1,
    max: 31,
    helpKey: "admin.crews.cluster3.topCard.field.periodStartDay",
  },
  {
    key: "period_end_year",
    label: "period_end_year (YYYY)",
    type: "number",
    helpKey: "admin.crews.cluster3.topCard.field.periodEndYear",
  },
  {
    key: "period_end_month",
    label: "period_end_month",
    type: "number",
    min: 1,
    max: 12,
    helpKey: "admin.crews.cluster3.topCard.field.periodEndMonth",
  },
  {
    key: "period_end_day",
    label: "period_end_day",
    type: "number",
    min: 1,
    max: 31,
    helpKey: "admin.crews.cluster3.topCard.field.periodEndDay",
  },
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

function ImagePreview({
  url,
  emptyLabel,
}: {
  url: string;
  emptyLabel: string;
}) {
  if (isRenderableImageUrl(url)) {
    return (
      <div className="flex h-16 items-center justify-center overflow-hidden rounded border bg-muted/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="h-full w-auto object-contain" />
      </div>
    );
  }
  if (isLocalPreviewUrl(url)) {
    return (
      <div className="flex h-16 flex-col items-center justify-center rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-center text-[9px] text-amber-900">
        <div className="font-medium">Local preview URL</div>
        <div>저장 시 null 로 정규화</div>
      </div>
    );
  }
  if (url) {
    return (
      <div className="flex h-16 flex-col items-center justify-center rounded border border-dashed bg-muted/10 text-[9px] text-muted-foreground">
        <div className="font-medium">No valid URL</div>
      </div>
    );
  }
  return (
    <div className="flex h-16 items-center justify-center rounded border border-dashed bg-muted/10 text-[9px] text-muted-foreground">
      {emptyLabel}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Multi-select chips — roles / tools 공용.
// canonical 옵션은 체크박스 그리드. DB 에서 옵션 목록에 없는 key 를 만나면
// 별도 amber 박스로 "기존 값" 표시 — 값을 유실하지 않도록.
// ─────────────────────────────────────────────────────────────────────
function MultiSelectChips({
  label,
  helpKey,
  options,
  selectedKeys,
  onChange,
  isCanonicalKey,
  disabled,
  devMode = false,
}: {
  label: string;
  helpKey?: string;
  options: readonly Cluster3KeyLabel[];
  selectedKeys: string[];
  onChange: (next: string[]) => void;
  isCanonicalKey: (key: unknown) => boolean;
  disabled?: boolean;
  devMode?: boolean;
}) {
  const legacy = selectedKeys.filter((k) => !isCanonicalKey(k));
  const toggle = (key: string, next: boolean) => {
    if (next) {
      if (selectedKeys.includes(key)) return;
      onChange([...selectedKeys, key]);
    } else {
      onChange(selectedKeys.filter((k) => k !== key));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="inline-flex items-center gap-1 text-xs">
        {label}
        {helpKey && (
          <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
        )}{" "}
        <span className="font-normal text-muted-foreground">
          {devMode
            ? `(selected ${selectedKeys.length})`
            : `(${selectedKeys.length}개 선택됨)`}
        </span>
      </Label>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
        {options.map((opt) => {
          const checked = selectedKeys.includes(opt.key);
          return (
            <label
              key={opt.key}
              className={cn(
                "flex items-center gap-1.5 rounded border px-2 py-1 text-[11px]",
                checked
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : "border-input bg-background",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => toggle(opt.key, e.target.checked)}
                disabled={disabled}
              />
              <span className="flex-1">{opt.label}</span>
              {devMode && (
                <code className="text-[9px] text-muted-foreground">{opt.key}</code>
              )}
            </label>
          );
        })}
      </div>
      {legacy.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-900">
          <div className="mb-1 font-medium">
            기존 값 ({legacy.length}) — canonical 옵션 목록에 없습니다. 체크 해제
            시 저장에서 제거됩니다.
          </div>
          <div className="flex flex-wrap gap-1">
            {legacy.map((k) => (
              <label
                key={k}
                className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-100 px-2 py-0.5"
              >
                <input
                  type="checkbox"
                  checked={true}
                  onChange={(e) => toggle(k, e.target.checked)}
                  disabled={disabled}
                />
                <code className="font-mono">{k}</code>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SlotInputRow({
  label,
  helpKey,
  values,
  onChange,
  inputType,
  showImagePreview,
  disabled,
}: {
  label: string;
  helpKey?: string;
  values: string[];
  onChange: (index: number, next: string) => void;
  inputType: "text" | "url";
  showImagePreview?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="inline-flex items-center gap-1 text-xs">
        <span>
          {label} (length {values.length})
        </span>
        {helpKey && (
          <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
        )}
      </Label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {values.map((v, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Label className="text-[10px]">[{i}]</Label>
            <Input
              type={inputType}
              value={v}
              onChange={(e) => onChange(i, e.target.value)}
              placeholder={inputType === "url" ? "https://..." : ""}
              disabled={disabled}
            />
            {showImagePreview && <ImagePreview url={v} emptyLabel="empty" />}
          </div>
        ))}
      </div>
    </div>
  );
}

function TopCardSlotEditor({
  cardIndex,
  cardType,
  meta,
  card,
  onChange,
  disabled,
  devMode = false,
}: {
  cardIndex: number;
  cardType: TopCardType;
  meta: TopCardSlot;
  card: TopCardFormCard;
  onChange: (next: TopCardFormCard) => void;
  disabled?: boolean;
  devMode?: boolean;
}) {
  const row = meta.row;
  const typeMismatch = row !== null && row.card_type !== cardType;

  // 빈 카드 판정 — UI 표시용. server-side isTopCardEmpty 와 동일한 규칙.
  const allTextEmpty =
    !card.main_title.trim() &&
    !card.sub_title.trim() &&
    !card.role_description.trim() &&
    !card.report.trim() &&
    !card.insight.trim() &&
    !card.platform.trim() &&
    !card.main_image_caption.trim() &&
    !card.main_image_url.trim();
  const allNumberEmpty =
    !card.contribution.trim() &&
    !card.period_start_year.trim() &&
    !card.period_start_month.trim() &&
    !card.period_start_day.trim() &&
    !card.period_end_year.trim() &&
    !card.period_end_month.trim() &&
    !card.period_end_day.trim();
  const allArrayEmpty =
    card.roles.length === 0 &&
    card.tools.length === 0 &&
    card.sub_image_urls.every((s) => !s.trim()) &&
    card.sub_image_captions.every((s) => !s.trim()) &&
    card.metrics.every((s) => !s.trim()) &&
    card.links.every((s) => !s.trim());
  const cardIsEmpty = allTextEmpty && allNumberEmpty && allArrayEmpty;

  // platform — canonical 옵션 + legacy fallback (Cluster2 slogan tag 와 동일 패턴).
  const platformValue = card.platform.trim();
  const platformIsLegacy =
    platformValue.length > 0 && !isCanonicalPlatform(platformValue);
  const platformLabel = devMode ? "platform" : OPERATOR_LABELS.platform;
  const platformField: FieldDef = platformIsLegacy
    ? {
        key: "platform",
        label: platformLabel,
        type: "select",
        options: [...PLATFORM_OPTIONS, platformValue],
        helpKey: "admin.crews.cluster3.topCard.field.platform",
      }
    : {
        key: "platform",
        label: platformLabel,
        type: "select",
        options: PLATFORM_OPTIONS,
        helpKey: "admin.crews.cluster3.topCard.field.platform",
      };

  const setField = (key: keyof TopCardFormCard, value: unknown) => {
    onChange({ ...card, [key]: value as never });
  };

  const setArraySlot = (
    key: "sub_image_urls" | "sub_image_captions" | "metrics" | "links",
    index: number,
    next: string,
  ) => {
    const list = [...card[key]];
    list[index] = next;
    onChange({ ...card, [key]: list });
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-md border p-3 text-xs",
        cardIsEmpty ? "border-dashed bg-muted/10" : "bg-background",
        typeMismatch && "border-amber-300 bg-amber-50",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold">
          {devMode
            ? `${cardType === "output" ? "Output" : "Detail"} #${cardIndex}`
            : `${cardType === "output" ? "대표 카드" : "상세 카드"} ${cardIndex}`}
          {devMode && (
            <span className="ml-1 font-normal text-muted-foreground">
              (card_type={cardType}, server-stamped)
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

      {typeMismatch && row && (
        <div className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900">
          card_type 불일치: 기대 {cardType} / 실제 {row.card_type}
        </div>
      )}

      {cardIsEmpty && (
        <div className="rounded border border-dashed bg-muted/20 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {devMode
            ? "모든 필드가 비어있어 저장 시 DB row 를 생성하지 않습니다. 기존 row 가 있었다면 같은 (card_type, card_index) 의 row 가 삭제됩니다."
            : "모든 항목이 비어 있어 저장하지 않습니다. 이전에 저장된 내용이 있다면 이 카드 자리는 비워집니다."}
        </div>
      )}

      {/* text scalars */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {operatorizeFields(TEXT_FIELDS, devMode).map((field) => (
          <FieldCell
            key={field.key}
            field={field}
            value={(card as Record<string, unknown>)[field.key]}
            onChange={(v) => setField(field.key as keyof TopCardFormCard, v)}
            disabled={disabled}
          />
        ))}
        {/* platform — canonical select + legacy fallback option */}
        <div className="flex flex-col gap-1">
          <FieldCell
            field={platformField}
            value={card.platform}
            onChange={(v) => setField("platform", v)}
            disabled={disabled}
          />
          {platformIsLegacy && (
            <p className="text-[10px] text-amber-700">
              기존 값{" "}
              <code className="font-mono">{platformValue}</code> 은 canonical
              옵션에 없습니다. 다른 옵션을 고르면 덮어쓰입니다.
            </p>
          )}
        </div>
      </div>

      {/* main_image_url + preview (URL sanitize 대상) */}
      <div className="flex flex-col gap-1.5">
        <Label className="inline-flex items-center gap-1 text-xs">
          {devMode
            ? "main_image_url (URL — blob:/data:/file: 정규화)"
            : "대표 이미지 URL"}
          <AdminHelpIconButton
            helpKey="admin.crews.cluster3.topCard.field.mainImageUrl"
            title="대표 이미지 URL"
            size="xs"
          />
        </Label>
        <Input
          type="url"
          value={card.main_image_url}
          onChange={(e) => setField("main_image_url", e.target.value)}
          placeholder="https://..."
          disabled={disabled}
        />
        <ImagePreview url={card.main_image_url} emptyLabel="no image" />
      </div>

      {/* number scalars */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-4">
        {operatorizeFields(NUMBER_FIELDS, devMode).map((field) => (
          <FieldCell
            key={field.key}
            field={field}
            value={(card as Record<string, unknown>)[field.key]}
            onChange={(v) => setField(field.key as keyof TopCardFormCard, v)}
            disabled={disabled}
          />
        ))}
      </div>

      {/* roles / tools — multi-select (DB 저장은 ROLE_OPTIONS / TOOL_OPTIONS 의 key) */}
      <MultiSelectChips
        label={devMode ? "roles (multi-select · ROLE_OPTIONS key)" : "역할"}
        helpKey="admin.crews.cluster3.topCard.field.roles"
        options={ROLE_OPTIONS}
        selectedKeys={card.roles}
        onChange={(next) => setField("roles", next)}
        isCanonicalKey={isCanonicalRoleKey}
        disabled={disabled}
        devMode={devMode}
      />
      <MultiSelectChips
        label={devMode ? "tools (multi-select · TOOL_OPTIONS key)" : "사용 도구"}
        helpKey="admin.crews.cluster3.topCard.field.tools"
        options={TOOL_OPTIONS}
        selectedKeys={card.tools}
        onChange={(next) => setField("tools", next)}
        isCanonicalKey={isCanonicalToolKey}
        disabled={disabled}
        devMode={devMode}
      />
      {/* 선택된 key → label 미리보기 (front Cluster3 에서 보이는 모습 검증용) */}
      <div className="rounded border bg-muted/30 px-2 py-1.5 text-[10px] text-muted-foreground">
        <div>
          {devMode ? "roles 표시: " : "역할 표시: "}
          {card.roles.length === 0
            ? "—"
            : card.roles.map((k) => getRoleLabel(k)).join(", ")}
        </div>
        <div>
          {devMode ? "tools 표시: " : "사용 도구 표시: "}
          {card.tools.length === 0
            ? "—"
            : card.tools.map((k) => getToolLabel(k)).join(", ")}
        </div>
      </div>

      {/* sub_image_urls (URL, sanitize) */}
      <SlotInputRow
        label={
          devMode
            ? `sub_image_urls (text[]) · 최대 ${TOP_CARD_SUB_IMAGE_SLOTS} 슬롯 · blob:/data:/file: 정규화`
            : `추가 이미지 URL · 최대 ${TOP_CARD_SUB_IMAGE_SLOTS} 개`
        }
        helpKey="admin.crews.cluster3.topCard.field.subImageUrls"
        values={card.sub_image_urls}
        onChange={(i, next) => setArraySlot("sub_image_urls", i, next)}
        inputType="url"
        showImagePreview
        disabled={disabled}
      />

      {/* sub_image_captions */}
      <SlotInputRow
        label={
          devMode
            ? `sub_image_captions (text[]) · 최대 ${TOP_CARD_SUB_IMAGE_CAPTION_SLOTS} 슬롯`
            : `추가 이미지 설명 · 최대 ${TOP_CARD_SUB_IMAGE_CAPTION_SLOTS} 개`
        }
        helpKey="admin.crews.cluster3.topCard.field.subImageCaptions"
        values={card.sub_image_captions}
        onChange={(i, next) => setArraySlot("sub_image_captions", i, next)}
        inputType="text"
        disabled={disabled}
      />

      {/* metrics */}
      <SlotInputRow
        label={
          devMode
            ? `metrics (text[]) · 최대 ${TOP_CARD_METRIC_SLOTS} 슬롯`
            : `성과 지표 · 최대 ${TOP_CARD_METRIC_SLOTS} 개`
        }
        helpKey="admin.crews.cluster3.topCard.field.metrics"
        values={card.metrics}
        onChange={(i, next) => setArraySlot("metrics", i, next)}
        inputType="text"
        disabled={disabled}
      />

      {/* links */}
      <SlotInputRow
        label={
          devMode
            ? `links (text[]) · 최대 ${TOP_CARD_LINK_SLOTS} 슬롯`
            : `링크 · 최대 ${TOP_CARD_LINK_SLOTS} 개`
        }
        helpKey="admin.crews.cluster3.topCard.field.links"
        values={card.links}
        onChange={(i, next) => setArraySlot("links", i, next)}
        inputType="url"
        disabled={disabled}
      />

      {/* readonly DB meta — dev only */}
      {devMode && (
        <div className="border-t pt-1.5 text-[10px] text-muted-foreground">
          {row ? (
            <>
              id <code className="font-mono">{row.id}</code> · card_type{" "}
              <code className="font-mono">{row.card_type}</code> · created{" "}
              <code className="font-mono">{row.created_at ?? "—"}</code> ·
              updated{" "}
              <code className="font-mono">{row.updated_at ?? "—"}</code>
            </>
          ) : (
            <>
              portfolio_top_cards row 없음 (card_type=&apos;{cardType}&apos;,
              card_index={cardIndex})
            </>
          )}
        </div>
      )}
    </div>
  );
}

// editable=true  → form grid (formCards / onChangeCard 필수)
// editable=false → TopCardsList readonly viewer 로 위임. Phase 4 전까지 detail
// 섹션이 이 경로를 사용. PATCH body 에는 어떠한 영향도 주지 않는다.
export default function TopCardsEditor({
  slots,
  cardType,
  formCards,
  onChangeCard,
  disabled,
  editable = true,
  title,
  titleHelpKey,
  slotCount,
  headerExtras,
  devMode = false,
}: {
  slots: TopCardSlot[];
  cardType: TopCardType;
  formCards?: TopCardFormCard[];
  onChangeCard?: (index: number, next: TopCardFormCard) => void;
  disabled?: boolean;
  editable?: boolean;
  title?: string;
  // 선택: 섹션 제목(title) 옆에 요소별 돋보기 도움말을 붙일 helpKey.
  titleHelpKey?: string;
  slotCount?: number;
  // 섹션 헤더 우측 영역에 끼워 넣을 추가 액션 (예: "작성 기간 관리" 버튼).
  // title 이 있을 때만 렌더된다 (header 가 렌더되는 조건).
  headerExtras?: ReactNode;
  devMode?: boolean;
}) {
  const slotMismatch =
    typeof slotCount === "number" && slots.length !== slotCount;
  const filled = slots.filter((s) => s.row !== null).length;
  const cardLabel = cardType === "output" ? "Output" : "Detail";

  if (editable && (!formCards || !onChangeCard)) {
    // 회귀 가드: editable 인데 형식이 비어있다면 시각 표시.
    return (
      <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
        TopCardsEditor: editable=true 인데 formCards / onChangeCard 가 없습니다.
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4 shadow-sm">
      {title && (
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <h2 className="inline-flex items-center gap-1.5 text-base font-semibold">
              {title}
              {titleHelpKey && (
                <AdminHelpIconButton
                  helpKey={titleHelpKey}
                  title={title}
                  size="sm"
                />
              )}
            </h2>
            {devMode ? (
              <p className="text-xs text-muted-foreground">
                portfolio_top_cards · card_type=&apos;{cardType}&apos; ·
                card_index 1~{slots.length} · {cardLabel} #1 ~ {cardLabel} #
                {slots.length}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {cardLabel} #1 ~ {cardLabel} #{slots.length}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-md border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
              {filled} / {slots.length} {devMode ? "filled" : "장 입력됨"}
            </span>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                editable
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-300 bg-amber-50 text-amber-900",
              )}
            >
              {editable
                ? devMode
                  ? "editable"
                  : "편집 가능"
                : devMode
                  ? "read-only (Phase 4)"
                  : "읽기 전용"}
            </span>
            {headerExtras}
          </div>
        </header>
      )}

      {devMode && slotMismatch && (
        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">
          slot 길이 {slots.length} ≠ 기대 {slotCount} (cardType={cardType})
        </div>
      )}

      {editable ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {slots.map((slot, i) => (
            <TopCardSlotEditor
              key={`${cardType}-${slot.cardIndex}`}
              cardIndex={slot.cardIndex}
              cardType={cardType}
              meta={slot}
              card={formCards![i]}
              onChange={(next) => onChangeCard!(i, next)}
              disabled={disabled}
              devMode={devMode}
            />
          ))}
        </div>
      ) : (
        <TopCardsList slots={slots} cardType={cardType} />
      )}
    </section>
  );
}
