"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { CalendarClock, RefreshCw, Save } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useActionToast } from "@/lib/actionToast";
import { pointColorClass } from "@/components/ui/point-value";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import {
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";
import { DebugSection } from "@/components/admin/fieldKit";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import {
  useAdminDevMode,
  useWithDevQuery,
} from "@/components/admin/useAdminDevMode";
import ChannelCardsGrid, {
  type ChannelCardFormCard,
} from "@/components/admin/cluster3/ChannelCardsGrid";
import TopCardsEditor, {
  type TopCardFormCard,
} from "@/components/admin/cluster3/TopCardsEditor";
import {
  CHANNEL_CARD_IMAGE_URL_SLOTS,
  CHANNEL_CARD_SLOT_COUNT,
  DETAIL_CARD_SLOT_COUNT,
  OUTPUT_CARD_SLOT_COUNT,
  TOP_CARD_LINK_SLOTS,
  TOP_CARD_METRIC_SLOTS,
  TOP_CARD_SUB_IMAGE_CAPTION_SLOTS,
  TOP_CARD_SUB_IMAGE_SLOTS,
  type ChannelCardInput,
  type ChannelCardSlot,
  type Cluster3ApplySummary,
  type Cluster3Bundle,
  type TopCardInput,
  type TopCardSlot,
} from "@/lib/adminCluster3Types";
import type { GrowthIndicatorsDto, ClubRankDto } from "@/lib/cluster3GrowthTypes";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

// Cluster3 admin editor — Phase 4.
//   Section 3 Channel Cards: editable (portfolio_channel_cards write)
//   Section 4 Output Cards:   editable (portfolio_top_cards WHERE card_type='output')
//   Section 5 Detail Cards:   editable (portfolio_top_cards WHERE card_type='detail')
//
// 저장 흐름:
//   GET bundle → syncFormFromBundle(bundle) → form state hydrate
//   Save All → buildPatchBody(form) → PATCH /api/admin/crews/:id/cluster3
//   응답: { success, data, warnings?, applied } → bundle/form 재 resync.
//
// 회귀 핵심:
//   - card_type / card_index 는 서버 stamp. 클라이언트는 어느 쪽도 전송하지 않는다.
//   - output 호출은 card_type='detail' row 를 mutate 하지 않고, detail 호출도
//     card_type='output' row 를 mutate 하지 않는다 (server-side scope).
//   - Admin route 는 requireAdmin 으로 보호되므로 user_edit_windows 작성 기간과
//     무관하게 저장 가능하다. (사용자-facing 권한과 혼동 금지)

type FormState = {
  channelCards: ChannelCardFormCard[]; // length CHANNEL_CARD_SLOT_COUNT (16)
  outputCards: TopCardFormCard[]; // length OUTPUT_CARD_SLOT_COUNT (5)
  detailCards: TopCardFormCard[]; // length DETAIL_CARD_SLOT_COUNT (10)
};

// ─────────────────────────────────────────────────────────────────────
// Hydrate helpers
// ─────────────────────────────────────────────────────────────────────

function padImageUrls(arr: string[] | null | undefined): (string | null)[] {
  const list = Array.isArray(arr)
    ? arr.slice(0, CHANNEL_CARD_IMAGE_URL_SLOTS).map((u) =>
        typeof u === "string" ? u : null,
      )
    : [];
  while (list.length < CHANNEL_CARD_IMAGE_URL_SLOTS) list.push(null);
  return list;
}

function slotToFormCard(slot: ChannelCardSlot): ChannelCardFormCard {
  const r = slot.row;
  return {
    channel_name: r?.channel_name ?? null,
    platform: r?.platform ?? null,
    management: r?.management ?? null,
    start_year: r?.start_year ?? null,
    start_month: r?.start_month ?? null,
    start_day: r?.start_day ?? null,
    rating: r?.rating ?? null,
    status: r?.status ?? null,
    link: r?.link ?? null,
    image_urls: padImageUrls(r?.image_urls ?? null),
    insight: r?.insight ?? null,
    experience: r?.experience ?? null,
    metrics: r?.metrics ?? null,
  };
}

function emptyChannelFormCard(): ChannelCardFormCard {
  return slotToFormCard({ cardIndex: 0, row: null });
}

// ─────────────────────────────────────────────────────────────────────
// portfolio_top_cards row → form card (Phase 3 / 4 공용)
//
// 모든 값은 string 으로 저장. number 컬럼은 String(n) 로 변환해 input 에
// 그대로 표시 가능하게 한다. 빈 슬롯에서는 모든 값이 "" 또는 빈 array.
// ─────────────────────────────────────────────────────────────────────
function intToStr(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return String(value);
}

function padStrSlots(
  arr: string[] | null | undefined,
  size: number,
): string[] {
  const list = Array.isArray(arr)
    ? arr.slice(0, size).map((v) => (typeof v === "string" ? v : ""))
    : [];
  while (list.length < size) list.push("");
  return list;
}

function topSlotToFormCard(slot: TopCardSlot): TopCardFormCard {
  const r = slot.row;
  return {
    main_title: r?.main_title ?? "",
    sub_title: r?.sub_title ?? "",
    role_description: r?.role_description ?? "",
    report: r?.report ?? "",
    insight: r?.insight ?? "",
    platform: r?.platform ?? "",
    main_image_caption: r?.main_image_caption ?? "",
    main_image_url: r?.main_image_url ?? "",
    contribution: intToStr(r?.contribution),
    period_start_year: intToStr(r?.period_start_year),
    period_start_month: intToStr(r?.period_start_month),
    period_start_day: intToStr(r?.period_start_day),
    period_end_year: intToStr(r?.period_end_year),
    period_end_month: intToStr(r?.period_end_month),
    period_end_day: intToStr(r?.period_end_day),
    roles: (r?.roles ?? []).filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    ),
    tools: (r?.tools ?? []).filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    ),
    sub_image_urls: padStrSlots(r?.sub_image_urls, TOP_CARD_SUB_IMAGE_SLOTS),
    sub_image_captions: padStrSlots(
      r?.sub_image_captions,
      TOP_CARD_SUB_IMAGE_CAPTION_SLOTS,
    ),
    metrics: padStrSlots(r?.metrics, TOP_CARD_METRIC_SLOTS),
    links: padStrSlots(r?.links, TOP_CARD_LINK_SLOTS),
  };
}

function emptyTopFormCard(): TopCardFormCard {
  return topSlotToFormCard({ cardIndex: 0, row: null });
}

function emptyForm(): FormState {
  return {
    channelCards: Array.from({ length: CHANNEL_CARD_SLOT_COUNT }, () =>
      emptyChannelFormCard(),
    ),
    outputCards: Array.from({ length: OUTPUT_CARD_SLOT_COUNT }, () =>
      emptyTopFormCard(),
    ),
    detailCards: Array.from({ length: DETAIL_CARD_SLOT_COUNT }, () =>
      emptyTopFormCard(),
    ),
  };
}

function syncFormFromBundle(bundle: Cluster3Bundle): FormState {
  // bundle.channelCards / outputCards / detailCards 는 각각 16 / 5 / 10 길이 보장.
  // server-side buildChannelSlots / buildTopSlots 가 빈 슬롯도 wrapper 로 채움.
  return {
    channelCards: bundle.channelCards.map(slotToFormCard),
    outputCards: bundle.outputCards.map(topSlotToFormCard),
    detailCards: bundle.detailCards.map(topSlotToFormCard),
  };
}

function buildEmptyBundle(legacyUserId: string): Cluster3Bundle {
  return {
    legacyUserId,
    userId: null,
    channelCards: Array.from({ length: CHANNEL_CARD_SLOT_COUNT }, (_, i) => ({
      cardIndex: i + 1,
      row: null,
    })),
    outputCards: Array.from({ length: OUTPUT_CARD_SLOT_COUNT }, (_, i) => ({
      cardIndex: i + 1,
      row: null,
    })),
    detailCards: Array.from({ length: DETAIL_CARD_SLOT_COUNT }, (_, i) => ({
      cardIndex: i + 1,
      row: null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// PATCH body 생성
//   - card_index 는 절대 포함하지 않음 (server-stamped).
//   - 각 필드 trim + blob:/data:/file: URL 정규화. 서버에서 한 번 더 sanitize 됨.
// ─────────────────────────────────────────────────────────────────────

function normalizeStr(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = typeof value === "string" ? value : String(value);
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}

function sanitizeStorageUrl(value: unknown): string | null {
  const v = normalizeStr(value);
  if (!v) return null;
  if (v.startsWith("blob:") || v.startsWith("data:") || v.startsWith("file:")) {
    return null;
  }
  return v;
}

function parseIntOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function buildTopCardInput(card: TopCardFormCard): TopCardInput {
  return {
    main_title: normalizeStr(card.main_title),
    sub_title: normalizeStr(card.sub_title),
    role_description: normalizeStr(card.role_description),
    report: normalizeStr(card.report),
    insight: normalizeStr(card.insight),
    platform: normalizeStr(card.platform),
    main_image_caption: normalizeStr(card.main_image_caption),
    main_image_url: sanitizeStorageUrl(card.main_image_url),
    contribution: parseIntOrNull(card.contribution),
    period_start_year: parseIntOrNull(card.period_start_year),
    period_start_month: parseIntOrNull(card.period_start_month),
    period_start_day: parseIntOrNull(card.period_start_day),
    period_end_year: parseIntOrNull(card.period_end_year),
    period_end_month: parseIntOrNull(card.period_end_month),
    period_end_day: parseIntOrNull(card.period_end_day),
    // roles / tools 는 multi-select 의 key 배열을 그대로 전달.
    // server 의 sanitizeStringArray 가 한 번 더 null/empty trim 처리.
    roles: card.roles,
    tools: card.tools,
    sub_image_urls: card.sub_image_urls.map((u) => sanitizeStorageUrl(u)),
    sub_image_captions: card.sub_image_captions.map((u) => normalizeStr(u)),
    metrics: card.metrics.map((u) => normalizeStr(u)),
    links: card.links.map((u) => normalizeStr(u)),
  };
}

// portfolio_top_cards 슬롯 묶음의 "현재 DB 상태 snapshot" 을 만든다.
//   - count        : row 가 존재하는 슬롯 수 (filled count)
//   - latestUpdatedAt : 슬롯 전체 중 max(updated_at) — 회귀 검증의 핵심 지표.
//                       detail snapshot 의 latestUpdatedAt 이 output 저장 전후로
//                       동일하면, 어떤 detail row 도 mutate 되지 않았다는 강한 증거.
//   - rows         : per-row (cardIndex, id, updated_at) — 한 row 라도 updated_at
//                       이 흔들리면 즉시 발견 가능.
// 본 헬퍼는 read-only — bundle 을 변경하지 않으며 PATCH 와 무관하다.
function topCardsSnapshot(slots: TopCardSlot[]): {
  count: number;
  slotCount: number;
  latestUpdatedAt: string | null;
  rows: Array<{
    cardIndex: number;
    id: string | null;
    updated_at: string | null;
  }>;
} {
  const rows = slots.map((s) => ({
    cardIndex: s.cardIndex,
    id: s.row?.id ?? null,
    updated_at: s.row?.updated_at ?? null,
  }));
  const count = slots.filter((s) => s.row !== null).length;
  const stamps = rows
    .map((r) => r.updated_at)
    .filter((v): v is string => typeof v === "string");
  const latestUpdatedAt =
    stamps.length > 0 ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
  return { count, slotCount: slots.length, latestUpdatedAt, rows };
}

function buildPatchBody(form: FormState): {
  channelCards: ChannelCardInput[];
  outputCards: TopCardInput[];
  detailCards: TopCardInput[];
} {
  const channelCards: ChannelCardInput[] = form.channelCards.map((card) => ({
    channel_name: normalizeStr(card.channel_name),
    platform: normalizeStr(card.platform),
    management: normalizeStr(card.management),
    start_year: normalizeStr(card.start_year),
    start_month: normalizeStr(card.start_month),
    start_day: normalizeStr(card.start_day),
    rating: normalizeStr(card.rating),
    status: normalizeStr(card.status),
    link: sanitizeStorageUrl(card.link),
    insight: normalizeStr(card.insight),
    experience: normalizeStr(card.experience),
    metrics: normalizeStr(card.metrics),
    image_urls: card.image_urls.map((u) => sanitizeStorageUrl(u)),
  }));
  const outputCards: TopCardInput[] = form.outputCards.map(buildTopCardInput);
  const detailCards: TopCardInput[] = form.detailCards.map(buildTopCardInput);
  return { channelCards, outputCards, detailCards };
}

// ─────────────────────────────────────────────────────────────────────
// 요소별 돋보기 도움말 라벨 — 지표/통계 라벨 옆에 AdminHelpIconButton(형제) 배치.
//   블록 라벨을 inline-flex 로만 바꿔 아이콘을 형제로 두고, 값 블록은 그대로 아래로 흐른다.
// ─────────────────────────────────────────────────────────────────────
function MetricLabelHelp({
  helpKey,
  title,
  className,
  children,
}: {
  helpKey: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("inline-flex items-center gap-1", className)}>
      {children}
      <AdminHelpIconButton helpKey={helpKey} title={title} size="xs" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────

export default function Cluster3Editor({
  organization,
  legacyUserId,
  memberDisplayName,
}: {
  organization: OrganizationSlug;
  legacyUserId: string;
  memberDisplayName?: string | null;
}) {
  const devMode = useAdminDevMode();
  const withDev = useWithDevQuery();
  const t = useActionToast();
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [saving, setSaving] = useState(false);
  const [bundle, setBundle] = useState<Cluster3Bundle>(() =>
    buildEmptyBundle(legacyUserId),
  );
  const [form, setForm] = useState<FormState>(emptyForm);
  const [banner, setBanner] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [growth, setGrowth] = useState<GrowthIndicatorsDto | null>(null);
  const [growthError, setGrowthError] = useState<string | null>(null);
  const [clubRank, setClubRank] = useState<ClubRankDto | null>(null);
  const [clubRankError, setClubRankError] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<Cluster3ApplySummary | null>(
    null,
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const encodedId = encodeURIComponent(legacyUserId);
      const [res, growthRes, rankRes] = await Promise.all([
        fetch(`/api/admin/crews/${encodedId}/cluster3`, { cache: "no-store" }),
        fetch(`/api/admin/crews/${encodedId}/cluster3/growth`, { cache: "no-store" }),
        fetch(`/api/admin/crews/${encodedId}/cluster3/growth/rank`, { cache: "no-store" }),
      ]);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "클러스터3 정보를 불러오지 못했습니다.");
      }
      const b = json.data as Cluster3Bundle;
      setBundle(b);
      setForm(syncFormFromBundle(b));
      setLastLoadedAt(new Date().toISOString());
      setBanner(null);

      const growthJson = await growthRes.json();
      if (growthRes.ok && growthJson.success) {
        setGrowth(growthJson.data as GrowthIndicatorsDto);
        setGrowthError(null);
      } else {
        setGrowth(null);
        setGrowthError(growthJson?.error ?? "Failed to load growth indicators.");
      }

      const rankJson = await rankRes.json();
      if (rankRes.ok && rankJson.success) {
        setClubRank(rankJson.data as ClubRankDto);
        setClubRankError(null);
      } else {
        setClubRank(null);
        setClubRankError(rankJson?.error ?? "Failed to load club rank.");
      }
    } catch (err) {
      setBanner({
        kind: "error",
        message: getApiErrorMessage(err, "불러오지 못했습니다."),
      });
    } finally {
      setLoading(false);
    }
  }, [legacyUserId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadAll();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadAll]);

  const handleSave = async () => {
    if (saving || !bundle.userId) return;
    setSaving(true);
    setWarnings([]);
    try {
      const body = buildPatchBody(form);
      const res = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster3`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "저장에 실패했습니다.");
      }
      const next = json.data as Cluster3Bundle;
      setBundle(next);
      setForm(syncFormFromBundle(next));
      setWarnings(Array.isArray(json.warnings) ? json.warnings : []);
      setLastApplied(
        (json.applied ?? null) as Cluster3ApplySummary | null,
      );
      setLastSavedAt(new Date().toISOString());
      t.success("save");
    } catch (err) {
      console.error("[Cluster3Editor] save failed", err);
      t.apiError("save", err, "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const isReadOnlyFallback = !bundle.userId;
  const inputsDisabled = loading || saving || isReadOnlyFallback;

  // 회귀 진단: bundle 의 슬롯 길이가 기대값과 일치하는지 확인. mismatch 시 경고.
  const slotShape = useMemo(
    () => ({
      channel: bundle.channelCards.length,
      output: bundle.outputCards.length,
      detail: bundle.detailCards.length,
    }),
    [bundle],
  );
  const shapeWarnings: string[] = [];
  if (slotShape.channel !== CHANNEL_CARD_SLOT_COUNT) {
    shapeWarnings.push(
      `channelCards 길이 ${slotShape.channel} ≠ ${CHANNEL_CARD_SLOT_COUNT}`,
    );
  }
  if (slotShape.output !== OUTPUT_CARD_SLOT_COUNT) {
    shapeWarnings.push(
      `outputCards 길이 ${slotShape.output} ≠ ${OUTPUT_CARD_SLOT_COUNT}`,
    );
  }
  if (slotShape.detail !== DETAIL_CARD_SLOT_COUNT) {
    shapeWarnings.push(
      `detailCards 길이 ${slotShape.detail} ≠ ${DETAIL_CARD_SLOT_COUNT}`,
    );
  }

  const channelFilled = bundle.channelCards.filter((s) => s.row !== null).length;
  const outputFilled = bundle.outputCards.filter((s) => s.row !== null).length;
  const detailFilled = bundle.detailCards.filter((s) => s.row !== null).length;

  const nextPatchPayload = useMemo(() => buildPatchBody(form), [form]);

  // Phase 3 회귀 게이트용 snapshot.
  //   output snapshot : Save All 후 갱신되어야 정상 (해당 슬롯의 updated_at 진행).
  //   detail snapshot : output 저장 전후로 동일해야 정상. 한 row 라도 흔들리면 회귀.
  const outputSnapshot = useMemo(
    () => topCardsSnapshot(bundle.outputCards),
    [bundle.outputCards],
  );
  const detailSnapshot = useMemo(
    () => topCardsSnapshot(bundle.detailCards),
    [bundle.detailCards],
  );

  const setChannelCard = (index: number, next: ChannelCardFormCard) =>
    setForm((cur) => {
      const list = [...cur.channelCards];
      list[index] = next;
      return { ...cur, channelCards: list };
    });

  const setOutputCard = (index: number, next: TopCardFormCard) =>
    setForm((cur) => {
      const list = [...cur.outputCards];
      list[index] = next;
      return { ...cur, outputCards: list };
    });

  const setDetailCard = (index: number, next: TopCardFormCard) =>
    setForm((cur) => {
      const list = [...cur.detailCards];
      list[index] = next;
      return { ...cur, detailCards: list };
    });

  // ───────────────────────────────────────────────────────────────────
  // Tabs + unsaved 표시
  //
  //   - 한 화면에 16/5/10 슬롯을 모두 펼치면 스크롤 압박이 크므로 section tab 으로 분리.
  //   - dirty 판정: bundle 기준 "마지막 서버 저장 상태" 와 현재 form 의 deep compare.
  //     bundle 은 PATCH 응답 후 setBundle(next) 로 갱신되므로 저장 직후엔 자동으로
  //     clean 상태로 돌아간다.
  // ───────────────────────────────────────────────────────────────────
  type TabKey = "channel" | "output" | "detail" | "debug";
  const [activeTab, setActiveTab] = useState<TabKey>("channel");

  const savedForm = useMemo(() => syncFormFromBundle(bundle), [bundle]);
  const channelDirty = useMemo(
    () =>
      JSON.stringify(form.channelCards) !==
      JSON.stringify(savedForm.channelCards),
    [form.channelCards, savedForm.channelCards],
  );
  const outputDirty = useMemo(
    () =>
      JSON.stringify(form.outputCards) !==
      JSON.stringify(savedForm.outputCards),
    [form.outputCards, savedForm.outputCards],
  );
  const detailDirty = useMemo(
    () =>
      JSON.stringify(form.detailCards) !==
      JSON.stringify(savedForm.detailCards),
    [form.detailCards, savedForm.detailCards],
  );
  const anyDirty = channelDirty || outputDirty || detailDirty;

  // 인바디 탭(콘텐츠 모드 전환) — 화면 내부 탭이라 요소별 돋보기 도움말 대상(디버그 탭 제외).
  const TABS: { key: TabKey; label: string; dirty: boolean; helpKey?: string }[] = [
    { key: "channel", label: devMode ? "Channel Cards" : "채널 카드", dirty: channelDirty, helpKey: "admin.crews.cluster3.tab.channel" },
    { key: "output", label: devMode ? "Top 5" : "대표 카드 (5장)", dirty: outputDirty, helpKey: "admin.crews.cluster3.tab.output" },
    { key: "detail", label: devMode ? "Detail 10" : "상세 카드 (10장)", dirty: detailDirty, helpKey: "admin.crews.cluster3.tab.detail" },
    ...(devMode
      ? [
          {
            key: "debug" as TabKey,
            label: "Preview / Debug",
            dirty: false,
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* top bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold">
            {devMode ? "Cluster 3 Editor" : "포트폴리오 편집"}{" "}
            {devMode && (
              <span className="text-xs font-normal text-muted-foreground">
                (Phase 4 · Channel + Output + Detail editable)
              </span>
            )}
          </h1>
          <div className="text-xs text-muted-foreground">
            {organizationLabelKo(organization)} ·{" "}
            <span className="font-medium text-foreground">
              {memberDisplayName ?? (devMode ? legacyUserId : "이름 미등록")}
            </span>
            {devMode && (
              <>
                {" "}
                · crew id: <code className="font-mono">{legacyUserId}</code>
              </>
            )}
            {devMode && bundle.userId && (
              <>
                {" "}
                · user_id: <code className="font-mono">{bundle.userId}</code>
              </>
            )}
            {devMode && lastLoadedAt && (
              <>
                {" "}
                · last loaded:{" "}
                <code className="font-mono">
                  {formatAdminDateTime(lastLoadedAt)}
                </code>
              </>
            )}
            {lastSavedAt && (
              <>
                {" "}
                · {devMode ? "last saved" : "최근 저장"}:{" "}
                <code className="font-mono">
                  {formatAdminDateTime(lastSavedAt)}
                </code>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadAll()}
            disabled={loading || saving}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            {devMode ? "Reload" : "새로고침"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            loading={saving}
            disabled={inputsDisabled}
          >
            {!saving && <Save className="h-4 w-4" />}
            {devMode
              ? anyDirty
                ? "Save All *"
                : "Save All"
              : anyDirty
                ? "전체 저장 *"
                : "전체 저장"}
          </Button>
        </div>
      </div>

      {/* read-only notice */}
      {isReadOnlyFallback && !loading && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {devMode ? (
            <>
              이 crew 는 user_profiles 매칭 행이 없어{" "}
              <strong>읽기 전용</strong>입니다. crew id{" "}
              <code className="font-mono">{legacyUserId}</code> 의 인증 가입
              후 다시 시도하세요.
            </>
          ) : (
            <>
              이 회원은 아직 가입 전이라 <strong>읽기 전용</strong>입니다.
              회원 가입 완료 후 다시 시도하세요.
            </>
          )}
        </div>
      )}

      {devMode && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Phase 4 — Channel Cards (portfolio_channel_cards), Output Cards
          (portfolio_top_cards card_type=&apos;output&apos;, 1~5), Detail Cards
          (card_type=&apos;detail&apos;, 1~10) 모두 편집 가능. card_type /
          card_index 는 서버 stamp 이며 한 card_type write 가 다른 card_type
          row 를 mutate 하지 않습니다. Admin route 는 requireAdmin 보호이므로
          user_edit_windows 작성 기간과 무관하게 저장됩니다.
        </div>
      )}

      {/* 성장 지표 요약 — process + period + point */}
      {growthError && !loading && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          성장 지표 로드 실패: {growthError}
        </div>
      )}
      {growth && (
        <div className="rounded-md border bg-background">
          <div className="border-b px-3 py-2">
            <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              성장 지표 · Growth Indicators
              <AdminHelpIconButton
                helpKey="admin.crews.cluster3.section.growth"
                title="성장 지표"
                size="sm"
              />
            </div>
          </div>
          {/* 오버라이드 ≠ 자동 계산 경고.
              예외(경고 생략): graduated←(graduating/extra_growth)=정상 졸업 경로,
              graduated←official_rest=공식휴식 주차의 일시 상태(다음 주 자동 해소). */}
          {growth.process.manualOverrideStatus &&
            growth.process.overrideMismatch &&
            !(
              growth.process.manualOverrideStatus === "graduated" &&
              (growth.process.autoGrowthStatusKey === "graduating" ||
                growth.process.autoGrowthStatusKey === "extra_growth" ||
                growth.process.autoGrowthStatusKey === "official_rest")
            ) && (
              <div className="border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                ⚠ 수동 오버라이드(
                {growth.process.manualOverrideStatus})가 자동 계산 상태(
                {growth.process.autoGrowthStatusDisplay})와 다릅니다.
                {growth.process.manualOverrideReason &&
                  ` 사유: ${growth.process.manualOverrideReason}`}
              </div>
            )}
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4 lg:grid-cols-6">
            {/* Process */}
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.growthStatus"
                title="상태(최종)"
              >
                상태(최종)
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">
                {growth.process.growthStatusDisplay}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {growth.process.growthDisplayKey}
              </div>
            </div>
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.autoStatus"
                title="자동 계산"
              >
                자동 계산
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">
                {growth.process.autoGrowthStatusDisplay}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {growth.process.autoGrowthStatusKey}
              </div>
            </div>
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.override"
                title="오버라이드"
              >
                오버라이드
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">
                {growth.process.manualOverrideStatus ?? "-"}
              </div>
              {growth.process.manualOverrideStatus && (
                <div className="text-[10px] text-muted-foreground">
                  {[
                    growth.process.manualOverrideByName,
                    growth.process.manualOverrideAt?.slice(0, 10),
                  ]
                    .filter(Boolean)
                    .join(" · ") || "기록 없음"}
                </div>
              )}
            </div>
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.growthStart"
                title="성장 시작"
              >
                성장 시작
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">
                {growth.process.activityStartedAtDisplay}
              </div>
            </div>
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.growthEnd"
                title="성장 종료"
              >
                성장 종료
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">
                {growth.process.activityEndedAtDisplay}
              </div>
            </div>

            {/* Period — 주차 */}
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.weeksA"
                title="성장(성공) 주차 · a"
              >
                성장(성공) 주차 · a
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">{growth.period.a}</div>
            </div>
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.weeksB"
                title="성장(실패) 주차 · b"
              >
                성장(실패) 주차 · b
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">{growth.period.b}</div>
            </div>
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.weeksC"
                title="휴식(개인) 주차 · c"
              >
                휴식(개인) 주차 · c
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">{growth.period.c}</div>
            </div>
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.weeksD"
                title="휴식(공식) 주차 · d"
              >
                휴식(공식) 주차 · d
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">{growth.period.d}</div>
            </div>
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.weeksE"
                title="성장 가능 주차 · e"
              >
                성장 가능 주차 · e
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">{growth.period.e}</div>
            </div>
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.weeksH"
                title="물리적 주차 · h"
              >
                물리적 주차 · h
              </MetricLabelHelp>
              <div className="mt-0.5 text-sm font-medium">{growth.period.h}</div>
            </div>

            {/* Period — 시즌 (핵심 지표) */}
            <div className="bg-emerald-50 px-3 py-2 dark:bg-emerald-950/30">
              <MetricLabelHelp
                className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
                helpKey="admin.crews.cluster3.metric.seasonF"
                title="성장 휴식 시즌 · f"
              >
                성장 휴식 시즌 · f
              </MetricLabelHelp>
              <div className="mt-0.5 text-lg font-bold text-emerald-800 dark:text-emerald-300">
                {growth.period.f}
              </div>
            </div>
            <div className="bg-emerald-50 px-3 py-2 dark:bg-emerald-950/30">
              <MetricLabelHelp
                className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
                helpKey="admin.crews.cluster3.metric.seasonG"
                title="성장(성공) 시즌 · g"
              >
                성장(성공) 시즌 · g
              </MetricLabelHelp>
              <div className="mt-0.5 text-lg font-bold text-emerald-800 dark:text-emerald-300">
                {growth.period.g}
              </div>
            </div>

            {/* Point */}
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.points"
                title={growth.point.pointsLabel}
              >
                {growth.point.pointsLabel}
              </MetricLabelHelp>
              <div className={cn("mt-0.5 text-sm font-medium tabular-nums", pointColorClass("a"))}>
                {growth.point.points}개
              </div>
            </div>
            {/* 방패: 큰 숫자 = netAdvantages(패널티 적용 후), 보조 = rawAdvantages(순) */}
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.advantages"
                title={growth.point.advantagesLabel}
              >
                {growth.point.advantagesLabel}
              </MetricLabelHelp>
              <div className={cn("mt-0.5 text-sm font-medium tabular-nums", pointColorClass("b"))}>
                {growth.point.netAdvantages}개
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {growth.point.advantagesLabel}(순) {growth.point.rawAdvantages}개
              </div>
            </div>
            {/* 번개: 패널티 */}
            <div className="bg-background px-3 py-2">
              <MetricLabelHelp
                className="text-[10px] text-muted-foreground"
                helpKey="admin.crews.cluster3.metric.penalty"
                title={growth.point.penaltyLabel}
              >
                {growth.point.penaltyLabel}
              </MetricLabelHelp>
              <div className={cn("mt-0.5 text-sm font-medium tabular-nums", pointColorClass("c"))}>
                {growth.point.penalty}개
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 클럽 강화 품계 */}
      {clubRankError && !loading && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          클럽 강화 품계 로드 실패: {clubRankError}
        </div>
      )}
      {clubRank && (
        <div className="rounded-md border bg-background">
          <div className="border-b px-3 py-2">
            <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              클럽 강화 품계{clubRank.isFrozen ? " · 고정" : ""}
              <AdminHelpIconButton
                helpKey="admin.crews.cluster3.section.clubRank"
                title="클럽 강화 품계"
                size="sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-px bg-border">
            <div className="bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
              <MetricLabelHelp
                className="text-[10px] font-medium text-amber-700 dark:text-amber-400"
                helpKey="admin.crews.cluster3.metric.rankGrade"
                title="종합 품계"
              >
                종합 품계
              </MetricLabelHelp>
              <div className="mt-1 text-2xl font-bold text-amber-800 dark:text-amber-300">
                {clubRank.rankGrade ?? "—"}
              </div>
              {clubRank.isFrozen && (
                <div className="mt-0.5 text-[10px] text-amber-600">고정됨</div>
              )}
            </div>
            <div className="bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
              <MetricLabelHelp
                className="text-[10px] font-medium text-amber-700 dark:text-amber-400"
                helpKey="admin.crews.cluster3.metric.avgPercentile"
                title="주차 평균 백분위"
              >
                주차 평균 백분위
              </MetricLabelHelp>
              <div className="mt-1 text-2xl font-bold text-amber-800 dark:text-amber-300">
                {clubRank.avgPercentileDisplay}
              </div>
            </div>
          </div>
          {devMode && clubRank.weeklyDetails.length > 0 && (
            <div className="border-t px-3 py-2">
              <div className="text-[10px] text-muted-foreground mb-1">
                주차별 상세 (onboarding 제외 표시: *)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="px-1 py-0.5">
                        <span className="inline-flex items-center gap-1">
                          주차
                          <AdminHelpIconButton
                            helpKey="admin.crews.cluster3.column.week"
                            title="주차"
                            size="xs"
                          />
                        </span>
                      </th>
                      <th className="px-1 py-0.5">
                        <span className="inline-flex items-center gap-1">
                          점수
                          <AdminHelpIconButton
                            helpKey="admin.crews.cluster3.column.score"
                            title="점수"
                            size="xs"
                          />
                        </span>
                      </th>
                      <th className="px-1 py-0.5">
                        <span className="inline-flex items-center gap-1">
                          등수
                          <AdminHelpIconButton
                            helpKey="admin.crews.cluster3.column.rank"
                            title="등수"
                            size="xs"
                          />
                        </span>
                      </th>
                      <th className="px-1 py-0.5">
                        <span className="inline-flex items-center gap-1">
                          참가자
                          <AdminHelpIconButton
                            helpKey="admin.crews.cluster3.column.participants"
                            title="참가자"
                            size="xs"
                          />
                        </span>
                      </th>
                      <th className="px-1 py-0.5">
                        <span className="inline-flex items-center gap-1">
                          백분위
                          <AdminHelpIconButton
                            helpKey="admin.crews.cluster3.column.percentile"
                            title="백분위"
                            size="xs"
                          />
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {clubRank.weeklyDetails.map((d) => (
                      <tr
                        key={`${d.year}-${d.weekNumber}`}
                        className={d.isOnboarding ? "text-muted-foreground/50" : ""}
                      >
                        <td className="px-1 py-0.5 font-mono">
                          {d.year}-W{String(d.weekNumber).padStart(2, "0")}
                          {d.isOnboarding ? " *" : ""}
                        </td>
                        <td className="px-1 py-0.5">{d.weeklyScore}</td>
                        <td className="px-1 py-0.5">{d.weeklyRank}등</td>
                        <td className="px-1 py-0.5">{d.totalParticipants}명</td>
                        <td className="px-1 py-0.5">{d.weeklyPercentile}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* counts strip — 탭과 무관하게 항상 보이는 상태 요약.
          detail latestUpdatedAt 은 Phase 3 회귀 게이트라 편집 중에도 노출. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-md border bg-background px-3 py-2 text-xs">
          <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {devMode ? "Channel cards · editable" : "채널 카드"}
            <AdminHelpIconButton
              helpKey="admin.crews.cluster3.stat.channelCount"
              title="채널 카드"
              size="xs"
            />
          </div>
          <div className="mt-1 text-sm">
            {channelFilled} / {CHANNEL_CARD_SLOT_COUNT}{" "}
            {devMode ? "filled" : "장 입력됨"}
            {channelDirty && (
              <span className="ml-2 text-[10px] text-amber-600">
                {devMode ? "* unsaved" : "* 저장 안 됨"}
              </span>
            )}
          </div>
        </div>
        <div className="rounded-md border bg-background px-3 py-2 text-xs">
          <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {devMode ? "Top cards · output · editable" : "포트폴리오 대표 카드"}
            <AdminHelpIconButton
              helpKey="admin.crews.cluster3.stat.outputCount"
              title="포트폴리오 대표 카드"
              size="xs"
            />
          </div>
          <div className="mt-1 text-sm">
            {outputFilled} / {OUTPUT_CARD_SLOT_COUNT}{" "}
            {devMode ? "filled" : "장 입력됨"}
            {outputDirty && (
              <span className="ml-2 text-[10px] text-amber-600">
                {devMode ? "* unsaved" : "* 저장 안 됨"}
              </span>
            )}
          </div>
          {devMode && (
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              latest updated_at:{" "}
              <code className="font-mono">
                {formatAdminDateTime(outputSnapshot.latestUpdatedAt)}
              </code>
            </div>
          )}
        </div>
        <div className="rounded-md border bg-background px-3 py-2 text-xs">
          <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {devMode ? "Top cards · detail · editable" : "포트폴리오 상세 카드"}
            <AdminHelpIconButton
              helpKey="admin.crews.cluster3.stat.detailCount"
              title="포트폴리오 상세 카드"
              size="xs"
            />
          </div>
          <div className="mt-1 text-sm">
            {detailFilled} / {DETAIL_CARD_SLOT_COUNT}{" "}
            {devMode ? "filled" : "장 입력됨"}
            {detailDirty && (
              <span className="ml-2 text-[10px] text-amber-600">
                {devMode ? "* unsaved" : "* 저장 안 됨"}
              </span>
            )}
          </div>
          {devMode && (
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              latest updated_at:{" "}
              <code className="font-mono">
                {formatAdminDateTime(detailSnapshot.latestUpdatedAt)}
              </code>
            </div>
          )}
        </div>
      </div>

      {banner && (
        <div
          role="status"
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          {banner.message}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <div className="mb-1 font-medium">Warnings</div>
          <ul className="list-disc pl-4">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {devMode && shapeWarnings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <div className="mb-1 font-medium">Slot shape mismatch</div>
          <ul className="list-disc pl-4">
            {shapeWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex flex-wrap items-center gap-1 border-b">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <span key={tab.key} className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "relative -mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-xs",
                  isActive
                    ? "border-foreground bg-background font-semibold text-foreground"
                    : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted",
                )}
                aria-pressed={isActive}
              >
                {tab.label}
                {tab.dirty && (
                  <span
                    className="ml-1 text-amber-600"
                    title="저장되지 않은 변경 사항"
                  >
                    *
                  </span>
                )}
              </button>
              {tab.helpKey && (
                <AdminHelpIconButton helpKey={tab.helpKey} title={tab.label} size="xs" />
              )}
            </span>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "channel" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {devMode ? "Channel Cards (16)" : "채널 카드 (16장)"}
              {devMode && " · portfolio_channel_cards · editable"}
              <AdminHelpIconButton
                helpKey="admin.crews.cluster3.section.channelCards"
                title="채널 카드"
                size="sm"
                className="ml-1.5 align-middle"
              />
              {channelDirty && (
                <span className="ml-2 text-xs text-amber-600">
                  {devMode ? "* unsaved" : "* 저장 안 됨"}
                </span>
              )}
            </CardTitle>
            {devMode ? (
              <p className="text-xs text-muted-foreground">
                card_index 1~16 자리 고정. server 가 배열 위치에서 stamp. 모든
                필드가 빈 카드는 저장 시 DB row 가 생성되지 않으며, 기존 row
                가 있었다면 해당 card_index 의 row 가 삭제됩니다.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                채널 카드 16개. 모든 필드가 비어 있는 카드는 저장하지 않습니다.
              </p>
            )}
          </CardHeader>
          <CardContent>
            <ChannelCardsGrid
              slots={bundle.channelCards}
              formCards={form.channelCards}
              onChangeCard={setChannelCard}
              disabled={inputsDisabled}
              devMode={devMode}
            />
          </CardContent>
        </Card>
      )}

      {activeTab === "output" && (
        <TopCardsEditor
          title={
            devMode
              ? outputDirty
                ? "Section 4 — Top 5 Output Cards * unsaved"
                : "Section 4 — Top 5 Output Cards"
              : outputDirty
                ? "포트폴리오 대표 카드 5장 * 저장 안 됨"
                : "포트폴리오 대표 카드 5장"
          }
          titleHelpKey="admin.crews.cluster3.section.outputCards"
          cardType="output"
          slotCount={OUTPUT_CARD_SLOT_COUNT}
          editable
          slots={bundle.outputCards}
          formCards={form.outputCards}
          onChangeCard={setOutputCard}
          disabled={inputsDisabled}
          devMode={devMode}
          headerExtras={
            <EditWindowsLinkButton
              userId={bundle.userId}
              resourceKey="cluster3.output_cards"
              withDev={withDev}
            />
          }
        />
      )}

      {activeTab === "detail" && (
        <TopCardsEditor
          title={
            devMode
              ? detailDirty
                ? "Section 5 — Detail 10 Second Cards * unsaved"
                : "Section 5 — Detail 10 Second Cards"
              : detailDirty
                ? "포트폴리오 상세 카드 10장 * 저장 안 됨"
                : "포트폴리오 상세 카드 10장"
          }
          titleHelpKey="admin.crews.cluster3.section.detailCards"
          cardType="detail"
          slotCount={DETAIL_CARD_SLOT_COUNT}
          editable
          slots={bundle.detailCards}
          formCards={form.detailCards}
          onChangeCard={setDetailCard}
          disabled={inputsDisabled}
          devMode={devMode}
          headerExtras={
            <EditWindowsLinkButton
              userId={bundle.userId}
              resourceKey="cluster3.detail_cards"
              withDev={withDev}
            />
          }
        />
      )}

      {activeTab === "debug" && devMode && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="text-base">Debug Summary</CardTitle>
              <p className="text-xs text-muted-foreground">
                GET 응답 / 다음 PATCH payload / 마지막 applied — 회귀 진단용
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDebugOpen((v) => !v)}
            >
              {debugOpen ? "Hide" : "Show"}
            </Button>
          </CardHeader>
          {debugOpen && (
            <CardContent className="text-xs">
              <DebugSection
                title="next PATCH payload (preview, before save)"
                data={nextPatchPayload}
              />
              <DebugSection
                title="last applied (server-side upsert/delete result)"
                data={lastApplied}
              />
              <DebugSection
                title="slot shape"
                data={{
                  channelCards: slotShape.channel,
                  topCards: {
                    output: slotShape.output,
                    detail: slotShape.detail,
                  },
                  filled: {
                    channel: channelFilled,
                    topCards: {
                      output: outputFilled,
                      detail: detailFilled,
                    },
                  },
                }}
              />
              <DebugSection
                title="topCards preservation snapshot"
                data={{
                  hint:
                    "output 만 저장하면 detail 의 latestUpdatedAt / rows 가 변하지 않아야 하고, " +
                    "detail 만 저장하면 output 의 latestUpdatedAt / rows 가 변하지 않아야 합니다. " +
                    "한 쪽 호출이 다른 card_type row 의 updated_at 을 흔들면 scope 누락 회귀입니다.",
                  output: {
                    count: outputSnapshot.count,
                    slotCount: outputSnapshot.slotCount,
                    latestUpdatedAt: outputSnapshot.latestUpdatedAt,
                    rows: outputSnapshot.rows,
                  },
                  detail: {
                    count: detailSnapshot.count,
                    slotCount: detailSnapshot.slotCount,
                    latestUpdatedAt: detailSnapshot.latestUpdatedAt,
                    rows: detailSnapshot.rows,
                  },
                }}
              />
              <DebugSection
                title="topCards.output (Section 4 · editable · card_type='output')"
                data={bundle.outputCards}
              />
              <DebugSection
                title="topCards.detail (Section 5 · editable · card_type='detail')"
                data={bundle.detailCards}
              />
              <DebugSection
                title="growth indicators (GET /cluster3/growth)"
                data={growth}
              />
              <DebugSection
                title="club rank (GET /cluster3/growth/rank)"
                data={clubRank}
              />
              <DebugSection
                title="bundle (admin GET · full)"
                data={bundle}
              />
              <div className="mt-3 text-muted-foreground">
                <div>
                  source tables (user_id =
                  <code className="font-mono">{bundle.userId ?? "—"}</code>):
                </div>
                <ul className="mt-1 list-disc pl-4">
                  <li>
                    portfolio_channel_cards · card_index 1~16 ·{" "}
                    <span className="text-emerald-700">writable (Phase 2)</span>
                  </li>
                  <li>
                    portfolio_top_cards · card_type=&apos;output&apos; · card_index
                    1~5 ·{" "}
                    <span className="text-emerald-700">writable</span>
                  </li>
                  <li>
                    portfolio_top_cards · card_type=&apos;detail&apos; · card_index
                    1~10 ·{" "}
                    <span className="text-emerald-700">writable (Phase 4)</span>
                  </li>
                </ul>
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

// 작성 기간 관리 진입 버튼 — Cluster2 Review Link 의 동일 버튼과 톤/스타일 mirror.
// userId 가 있으면 ?q= 까지 붙여 EditWindowsManager 의 검색창에 시드된다.
// resource 는 EditWindowsManager 가 mount 시 1회 isEditableResourceKey 로
// 검증해 안전 fallback.
function EditWindowsLinkButton({
  userId,
  resourceKey,
  withDev,
}: {
  userId: string | null;
  resourceKey: "cluster3.output_cards" | "cluster3.detail_cards";
  withDev: (href: string) => string;
}) {
  const params = new URLSearchParams();
  if (userId) params.set("q", userId);
  params.set("resource", resourceKey);
  const href = withDev(
    `/admin/settings/edit-windows?${params.toString()}`,
  );
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      render={<Link href={href} />}
    >
      <CalendarClock className="h-3.5 w-3.5" />
      작성 기간 관리
    </Button>
  );
}
