"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock, RefreshCw, Save } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ORGANIZATION_LABEL,
  type OrganizationSlug,
} from "@/lib/organizations";
import {
  DebugSection,
  FieldCell,
  PreviewBlock,
  fmt,
  normalizeForPatch,
  type FieldDef,
} from "@/components/admin/fieldKit";
import PhotoSlots from "@/components/admin/cluster2/PhotoSlots";
import EducationsList, {
  EDUCATION_FIELD_DEFS,
  type EducationDto,
} from "@/components/admin/cluster2/EducationsList";
import {
  CLUSTER2_SLOGAN_OPTIONS,
  isCanonicalSloganOption,
} from "@/lib/cluster2SloganOptions";

// Cluster2 admin editor.
// resume-card editor 와 동일한 패턴:
//   - GET bundle → form state hydrate
//   - 좌측 form (섹션별 카드) + 우측 preview/debug
//   - Save All = 단일 PATCH (section 별 부분 patch body)
//
// front cluster-2 self-edit API 와 동일 supabase 컬럼군을 사용한다.
// admin 에서 저장하면 front Cluster2 페이지에 즉시 반영.

// ─────────────────────────────────────────────────────────────────────
// Types (서버 lib/adminCluster2Data.ts 의 Cluster2Bundle 과 1:1)
// ─────────────────────────────────────────────────────────────────────
type Bundle = {
  legacyUserId: string;
  userId: string | null;
  photos: {
    sidebarPhoto: string | null;
    mainPhoto: string | null;
    subPhotos: (string | null)[];
  } | null;
  slogans: Record<string, unknown> | null;
  videos: Record<string, unknown> | null;
  introductions: Record<string, unknown> | null;
  educations: EducationDto[];
  reviewLink: {
    cluving_review_link: string | null;
    readonly: true;
    window: {
      resourceKey: "cluster2.review_links";
      status: "open" | "scheduled" | "expired" | "not_granted";
      openedAt: string | null;
      expiresAt: string | null;
    };
  };
};

type PhotosForm = {
  sidebarPhoto: string | null;
  mainPhoto: string | null;
  subPhotos: (string | null)[]; // 4
};

type FormState = {
  photos: PhotosForm;
  slogans: Record<string, unknown>;
  videos: Record<string, unknown>;
  introductions: Record<string, unknown>;
  educations: EducationDto[];
};

// ─────────────────────────────────────────────────────────────────────
// Field definitions
//   서버 whitelist (lib/adminCluster2Data.ts) 와 1:1.
// ─────────────────────────────────────────────────────────────────────
// 슬로건은 1/2/3 세트별로 text + tag + rating 을 함께 편집한다.
// 서버 lib/adminCluster2Data.ts:SLOGAN_FIELDS 의 9 컬럼과 1:1 대응.
type SloganGroup = {
  index: 1 | 2 | 3;
  text: FieldDef;
  tag: FieldDef;
  rating: FieldDef;
};

const SLOGAN_GROUPS: readonly SloganGroup[] = [1, 2, 3].map((i) => ({
  index: i as 1 | 2 | 3,
  text: {
    key: `slogan_${i}`,
    label: `Text (slogan_${i})`,
    type: "textarea",
    full: true,
  },
  // options 는 render 시점에 legacy 값을 fallback 으로 합쳐서 다시 주입한다.
  // canonical 목록은 lib/cluster2SloganOptions.ts (front 와 mirror).
  tag: {
    key: `slogan_${i}_tag`,
    label: `Tag (slogan_${i}_tag)`,
    type: "select",
    options: CLUSTER2_SLOGAN_OPTIONS,
  },
  rating: {
    key: `slogan_${i}_rating`,
    label: `Rating 0–10 (slogan_${i}_rating)`,
    type: "number",
    min: 0,
    max: 10,
    step: 1,
    placeholder: "0–10 정수",
  },
}));

// SLOGAN_GROUPS 의 9개 FieldDef 를 일렬로 펼친 형태 — buildPatchBody 가 일괄 normalize 할 때 사용.
const SLOGAN_FIELDS: readonly FieldDef[] = SLOGAN_GROUPS.flatMap((g) => [
  g.text,
  g.tag,
  g.rating,
]);

const VIDEO_FIELDS: readonly FieldDef[] = [
  {
    key: "video_url_1",
    label: "Video 1 URL",
    type: "url",
    full: true,
    placeholder: "https://youtu.be/...",
  },
  {
    key: "video_url_2",
    label: "Video 2 URL",
    type: "url",
    full: true,
    placeholder: "https://youtu.be/...",
  },
  {
    key: "video_url_3",
    label: "Video 3 URL",
    type: "url",
    full: true,
    placeholder: "https://youtu.be/...",
  },
];

// 자기소개서 5문항 — front 와 동일하게 각 항목 1,000자 제한.
// 서버(lib/adminCluster2Data.ts) 도 동일 상한으로 reject.
export const INTRODUCTION_MAX_LENGTH = 1000;

const INTRODUCTION_FIELDS: readonly FieldDef[] = [
  {
    key: "growth_story",
    label: "성장 과정 (growth_story)",
    type: "textarea",
    full: true,
    maxLength: INTRODUCTION_MAX_LENGTH,
  },
  {
    key: "social_experience",
    label: "사회 경험 (social_experience)",
    type: "textarea",
    full: true,
    maxLength: INTRODUCTION_MAX_LENGTH,
  },
  {
    key: "career_direction",
    label: "커리어 방향 (career_direction)",
    type: "textarea",
    full: true,
    maxLength: INTRODUCTION_MAX_LENGTH,
  },
  {
    key: "work_style",
    label: "실무 스타일 (work_style)",
    type: "textarea",
    full: true,
    maxLength: INTRODUCTION_MAX_LENGTH,
  },
  {
    key: "personal_story",
    label: "퍼스널 스토리 (personal_story)",
    type: "textarea",
    full: true,
    maxLength: INTRODUCTION_MAX_LENGTH,
  },
];

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
function emptyForm(): FormState {
  return {
    photos: { sidebarPhoto: null, mainPhoto: null, subPhotos: [null, null, null, null] },
    slogans: {},
    videos: {},
    introductions: {},
    educations: [],
  };
}

function syncFormFromBundle(bundle: Bundle | null): FormState {
  if (!bundle) return emptyForm();
  return {
    photos: {
      sidebarPhoto: bundle.photos?.sidebarPhoto ?? null,
      mainPhoto: bundle.photos?.mainPhoto ?? null,
      subPhotos: [
        bundle.photos?.subPhotos?.[0] ?? null,
        bundle.photos?.subPhotos?.[1] ?? null,
        bundle.photos?.subPhotos?.[2] ?? null,
        bundle.photos?.subPhotos?.[3] ?? null,
      ],
    },
    slogans: { ...(bundle.slogans ?? {}) },
    videos: { ...(bundle.videos ?? {}) },
    introductions: { ...(bundle.introductions ?? {}) },
    educations: bundle.educations.map((e) => ({ ...e })),
  };
}

// blob:/data:/file: 같은 local-only URL 은 storage 에 보존되지 않으므로
// 저장 전에 null 로 정규화한다. (DB 가 가비지를 보관하지 않도록)
function sanitizeStorageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (
    v.startsWith("blob:") ||
    v.startsWith("data:") ||
    v.startsWith("file:")
  ) {
    return null;
  }
  return v;
}

function buildPatchBody(form: FormState) {
  const slogans: Record<string, unknown> = {};
  for (const field of SLOGAN_FIELDS) {
    const normalized = normalizeForPatch(form.slogans[field.key], field.type);
    // rating 컬럼은 DB 가 integer 라 0–10 정수로 클램프해서 보낸다.
    if (
      field.key.endsWith("_rating") &&
      typeof normalized === "number" &&
      Number.isFinite(normalized)
    ) {
      slogans[field.key] = Math.max(0, Math.min(10, Math.round(normalized)));
    } else {
      slogans[field.key] = normalized;
    }
  }
  const videos: Record<string, unknown> = {};
  for (const field of VIDEO_FIELDS) {
    videos[field.key] = normalizeForPatch(form.videos[field.key], field.type);
  }
  const introductions: Record<string, unknown> = {};
  for (const field of INTRODUCTION_FIELDS) {
    introductions[field.key] = normalizeForPatch(
      form.introductions[field.key],
      field.type,
    );
  }

  const educations = form.educations.map((edu, index) => {
    const out: Record<string, unknown> = {};
    for (const field of EDUCATION_FIELD_DEFS) {
      out[field.key] = normalizeForPatch(
        (edu as Record<string, unknown>)[field.key],
        field.type,
      );
    }
    out.sort_order =
      typeof edu.sort_order === "number" ? edu.sort_order : index + 1;
    out.is_primary = Boolean(edu.is_primary);
    return out;
  });

  return {
    photos: {
      sidebarPhoto: sanitizeStorageUrl(form.photos.sidebarPhoto),
      mainPhoto: sanitizeStorageUrl(form.photos.mainPhoto),
      subPhotos: form.photos.subPhotos.map((s) => sanitizeStorageUrl(s)),
    },
    slogans,
    videos,
    introductions,
    educations,
  };
}

// YouTube 썸네일 derive (admin 저장 금지, runtime preview 만)
function getYouTubeThumbnail(url: string | null | undefined): string | null {
  if (!url) return null;
  const m =
    url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ??
    url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ??
    url.match(/embed\/([a-zA-Z0-9_-]{11})/);
  return m ? `https://img.youtube.com/vi/${m[1]}/maxresdefault.jpg` : null;
}

function formatWindowDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function ReviewLinkWindowNotice({
  window,
}: {
  window: Bundle["reviewLink"]["window"] | undefined;
}) {
  if (!window || window.status === "not_granted") {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <div className="font-medium">작성 권한 없음</div>
        <div className="mt-0.5">
          설정 &gt; 작성 기간 관리에서 권한을 부여할 수 있습니다.
        </div>
      </div>
    );
  }

  if (window.status === "open") {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        <div className="font-medium">작성 가능</div>
        <div className="mt-0.5">
          만료: {formatWindowDate(window.expiresAt)}
        </div>
      </div>
    );
  }

  if (window.status === "scheduled") {
    return (
      <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
        <div className="font-medium">작성 예정</div>
        <div className="mt-0.5">
          시작: {formatWindowDate(window.openedAt)}
        </div>
        <div>만료: {formatWindowDate(window.expiresAt)}</div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-800">
      <div className="font-medium">작성 기간 만료</div>
      <div className="mt-0.5">만료: {formatWindowDate(window.expiresAt)}</div>
    </div>
  );
}

const REVIEW_LINK_SLOTS = [
  {
    key: "cluving_review_link",
    label: "Total Complete",
    stored: true,
    helper: "user_cluster2.cluving_review_link",
  },
  { key: "review_link_3w", label: "3 weeks", stored: false },
  { key: "review_link_6w", label: "6 weeks", stored: false },
  { key: "review_link_9w", label: "9 weeks", stored: false },
  { key: "review_link_12w", label: "12 weeks", stored: false },
  { key: "review_link_15w", label: "15 weeks", stored: false },
  { key: "review_link_18w", label: "18 weeks", stored: false },
  { key: "review_link_21w", label: "21 weeks", stored: false },
  { key: "review_link_24w", label: "24 weeks", stored: false },
  { key: "review_link_27w", label: "27 weeks", stored: false },
] as const;

function ReviewLinkSlots({
  value,
}: {
  value: string | null | undefined;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
        <div className="font-medium">현재 운영 저장 슬롯: Total Complete 1개</div>
        <div className="mt-0.5">
          3w~27w 슬롯은 프론트 demo UI이며 DB 저장 대상이 아닙니다.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {REVIEW_LINK_SLOTS.map((slot) => {
          const slotValue = slot.stored ? value : null;
          return (
            <div key={slot.key} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor={`review-link-${slot.key}`}
                  className="text-xs font-medium"
                >
                  {slot.label}
                </label>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px]",
                    slot.stored
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600",
                  )}
                >
                  {slot.stored ? "DB 저장" : "DB 미연결"}
                </span>
              </div>
              <Input
                id={`review-link-${slot.key}`}
                value={
                  slot.stored
                    ? slotValue?.trim()
                      ? slotValue
                      : "—"
                    : "미운영 슬롯 / DB 미연결"
                }
                readOnly
                disabled={!slot.stored}
                className={cn(
                  "font-mono text-xs",
                  !slot.stored && "text-muted-foreground",
                )}
              />
              <div className="min-h-4 text-[10px] text-muted-foreground">
                {slot.stored
                  ? slot.helper
                  : "프론트 표시용 demo 슬롯입니다. 현재 저장 API/DB 컬럼과 연결되어 있지 않습니다."}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        주차별 Review Link 운영화 시 user_review_links 또는 user_cluster2 확장 필요
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────
export default function Cluster2Editor({
  organization,
  legacyUserId,
}: {
  organization: OrganizationSlug;
  legacyUserId: string;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [banner, setBanner] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<unknown>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster2`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to load cluster2.");
      }
      const b = json.data as Bundle;
      setBundle(b);
      setForm(syncFormFromBundle(b));
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load.",
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

  useEffect(() => {
    if (!banner || banner.kind !== "success") return;
    const timer = window.setTimeout(() => setBanner(null), 4000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const handleSave = async () => {
    if (saving || !bundle?.userId) return;

    // Introductions 1,000자 사전 검증 — textarea 의 maxLength 가 paste 도 잘라내지만
    // form state 가 다른 경로로 길어졌을 가능성 대비 한 번 더 확인.
    const overLengthFields = INTRODUCTION_FIELDS.filter((f) => {
      const v = form.introductions[f.key];
      return typeof v === "string" && v.length > INTRODUCTION_MAX_LENGTH;
    });
    if (overLengthFields.length > 0) {
      setBanner({
        kind: "error",
        message: `자기소개서 ${INTRODUCTION_MAX_LENGTH.toLocaleString()}자 초과: ${overLengthFields
          .map((f) => f.key)
          .join(", ")} — 저장을 중단했습니다.`,
      });
      return;
    }

    setSaving(true);
    setWarnings([]);
    try {
      const body = buildPatchBody(form);
      const res = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster2`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to save.");
      }
      const next = json.data as Bundle;
      setBundle(next);
      setForm(syncFormFromBundle(next));
      setWarnings(Array.isArray(json.warnings) ? json.warnings : []);
      setLastApplied(json.applied ?? null);
      setLastSavedAt(new Date().toISOString());
      setBanner({
        kind: "success",
        message: "Saved. Form resynced from PATCH response.",
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to save.",
      });
    } finally {
      setSaving(false);
    }
  };

  const setSloganValue = (key: string, value: unknown) =>
    setForm((c) => ({ ...c, slogans: { ...c.slogans, [key]: value } }));
  const setVideoValue = (key: string, value: unknown) =>
    setForm((c) => ({ ...c, videos: { ...c.videos, [key]: value } }));
  const setIntroValue = (key: string, value: unknown) =>
    setForm((c) => ({
      ...c,
      introductions: { ...c.introductions, [key]: value },
    }));

  const isReadOnly = !bundle?.userId;
  const inputsDisabled = loading || saving || isReadOnly;

  const nextPatchPayload = useMemo(() => buildPatchBody(form), [form]);

  return (
    <div className="flex flex-col gap-4">
      {/* top bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold">Cluster 2 Editor</h1>
          <div className="text-xs text-muted-foreground">
            {ORGANIZATION_LABEL[organization]} · crew id:{" "}
            <code className="font-mono">{legacyUserId}</code>
            {bundle?.userId && (
              <>
                {" "}
                · user_id: <code className="font-mono">{bundle.userId}</code>
              </>
            )}
            {lastSavedAt && (
              <>
                {" "}
                · last saved: <code className="font-mono">{lastSavedAt}</code>
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
            Reload
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={inputsDisabled}
          >
            <Save className="h-4 w-4" />
            {saving ? "Saving..." : "Save All"}
          </Button>
        </div>
      </div>

      {/* read-only notice */}
      {isReadOnly && !loading && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          이 crew 는 user_profiles 매칭 행이 없어 <strong>읽기 전용</strong>
          입니다. crew id <code className="font-mono">{legacyUserId}</code> 의
          인증 가입 후 다시 시도하세요.
        </div>
      )}

      {/* banner */}
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

      {/* warnings */}
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* form */}
        <div className="flex flex-col gap-4 xl:col-span-2">
          {/* Photos */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Photos</CardTitle>
              <p className="text-xs text-muted-foreground">
                sidebar = user_profiles.profile_photo_url · main+sub =
                user_introductions.sub_photo_5 / 1~4
              </p>
            </CardHeader>
            <CardContent>
              <PhotoSlots
                value={form.photos}
                onChange={(next) =>
                  setForm((c) => ({ ...c, photos: next }))
                }
                disabled={inputsDisabled}
              />
            </CardContent>
          </Card>

          {/* Slogans — 1/2/3 세트별로 text + tag + rating */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Slogans</CardTitle>
              <p className="text-xs text-muted-foreground">
                user_introductions.slogan_{`{1,2,3}`} · _tag · _rating (0–10
                정수)
              </p>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-6">
                {SLOGAN_GROUPS.map((group) => {
                  // DB 의 기존 값이 canonical 옵션에 없는 경우 (front 옵션이 바뀌었거나
                  // 과거 자유 입력 값) 유실 방지를 위해 select options 끝에 fallback 으로 추가.
                  const tagRaw = form.slogans[group.tag.key];
                  const tagValueStr =
                    typeof tagRaw === "string" ? tagRaw.trim() : "";
                  const isLegacyTag =
                    tagValueStr.length > 0 &&
                    !isCanonicalSloganOption(tagValueStr);
                  const tagField: FieldDef = isLegacyTag
                    ? {
                        ...group.tag,
                        options: [...CLUSTER2_SLOGAN_OPTIONS, tagValueStr],
                      }
                    : group.tag;
                  return (
                    <div
                      key={group.index}
                      className={cn(
                        "flex flex-col gap-3",
                        group.index > 1 && "border-t pt-6",
                      )}
                    >
                      <div className="text-sm font-medium">
                        Slogan {group.index}
                      </div>
                      <FieldCell
                        field={group.text}
                        value={form.slogans[group.text.key]}
                        onChange={(v) => setSloganValue(group.text.key, v)}
                        disabled={inputsDisabled}
                      />
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="flex flex-col gap-1">
                          <FieldCell
                            field={tagField}
                            value={tagValueStr}
                            onChange={(v) => setSloganValue(group.tag.key, v)}
                            disabled={inputsDisabled}
                          />
                          {isLegacyTag && (
                            <p className="text-[10px] text-amber-700">
                              기존 값 <code className="font-mono">{tagValueStr}</code>{" "}
                              는 canonical 옵션에 없습니다. 다른 옵션을 고르면
                              덮어쓰입니다.
                            </p>
                          )}
                        </div>
                        <FieldCell
                          field={group.rating}
                          value={form.slogans[group.rating.key]}
                          onChange={(v) => setSloganValue(group.rating.key, v)}
                          disabled={inputsDisabled}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Videos */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Videos</CardTitle>
              <p className="text-xs text-muted-foreground">
                user_introductions.video_url_{`{1,2,3}`} · 썸네일은 자동 계산
                (저장 불가)
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {VIDEO_FIELDS.map((field) => (
                  <div
                    key={field.key}
                    className={cn(field.full && "sm:col-span-2")}
                  >
                    <FieldCell
                      field={field}
                      value={form.videos[field.key]}
                      onChange={(v) => setVideoValue(field.key, v)}
                      disabled={inputsDisabled}
                    />
                    {(() => {
                      const thumb = getYouTubeThumbnail(
                        form.videos[field.key] as string | null,
                      );
                      return thumb ? (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          썸네일 미리보기 (자동):
                          <div className="mt-1">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={thumb}
                              alt="thumbnail"
                              className="h-20 w-auto rounded border"
                            />
                          </div>
                        </div>
                      ) : null;
                    })()}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Educations */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Educations</CardTitle>
              <p className="text-xs text-muted-foreground">
                user_educations · 저장 시 user_id 전체 삭제+재삽입 · sort_order
                = 0 이 대표학력
              </p>
            </CardHeader>
            <CardContent>
              <EducationsList
                rows={form.educations}
                onChange={(next) =>
                  setForm((c) => ({ ...c, educations: next }))
                }
                disabled={inputsDisabled}
              />
            </CardContent>
          </Card>

          {/* Introductions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Introductions</CardTitle>
              <p className="text-xs text-muted-foreground">
                user_cluster2 · 5 문항 · 각 항목{" "}
                {INTRODUCTION_MAX_LENGTH.toLocaleString()}자 제한
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3">
                {INTRODUCTION_FIELDS.map((field) => (
                  <FieldCell
                    key={field.key}
                    field={field}
                    value={form.introductions[field.key]}
                    onChange={(v) => setIntroValue(field.key, v)}
                    disabled={inputsDisabled}
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Review Link (readonly) */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <CardTitle className="text-base">
                  Review Link{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    (readonly)
                  </span>
                </CardTitle>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  render={<Link href="/admin/settings/edit-windows" />}
                >
                  <CalendarClock className="h-3.5 w-3.5" />
                  작성 기간 관리
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ReviewLinkWindowNotice window={bundle?.reviewLink.window} />
              <ReviewLinkSlots value={bundle?.reviewLink.cluving_review_link} />
            </CardContent>
          </Card>
        </div>

        {/* preview + debug */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Front Cluster2 Preview</CardTitle>
              <p className="text-xs text-muted-foreground">
                Front Cluster2 에 노출될 값 (form 기준)
              </p>
            </CardHeader>
            <CardContent className="text-sm">
              <PreviewBlock title="Sidebar Photo">
                {fmt(form.photos.sidebarPhoto)}
              </PreviewBlock>
              <PreviewBlock title="Main Photo">
                {fmt(form.photos.mainPhoto)}
              </PreviewBlock>
              <PreviewBlock title="Sub Photos (4)">
                <ol className="list-decimal pl-4">
                  {form.photos.subPhotos.map((p, i) => (
                    <li key={i}>{fmt(p)}</li>
                  ))}
                </ol>
              </PreviewBlock>
              {SLOGAN_GROUPS.map((group) => (
                <PreviewBlock
                  key={group.index}
                  title={`Slogan ${group.index}`}
                >
                  {fmt(form.slogans[group.text.key])}
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    tag: {fmt(form.slogans[group.tag.key])} · rating:{" "}
                    {fmt(form.slogans[group.rating.key])}
                  </div>
                </PreviewBlock>
              ))}
              <PreviewBlock title="Videos">
                <ol className="list-decimal pl-4">
                  <li>{fmt(form.videos.video_url_1)}</li>
                  <li>{fmt(form.videos.video_url_2)}</li>
                  <li>{fmt(form.videos.video_url_3)}</li>
                </ol>
              </PreviewBlock>
              <PreviewBlock title="대표 학력 (is_primary)">
                {(() => {
                  const primary = form.educations.find((e) => e.is_primary);
                  if (!primary) return "—";
                  return `${fmt(primary.school_name)} · ${fmt(primary.major_name_1)}`;
                })()}
              </PreviewBlock>
              <PreviewBlock title="Educations · count">
                {form.educations.length}
              </PreviewBlock>
              <PreviewBlock title="자기소개서">
                <ol className="list-decimal pl-4 text-xs">
                  <li>성장: {fmt(form.introductions.growth_story)}</li>
                  <li>사회: {fmt(form.introductions.social_experience)}</li>
                  <li>커리어: {fmt(form.introductions.career_direction)}</li>
                  <li>실무: {fmt(form.introductions.work_style)}</li>
                  <li>퍼스널: {fmt(form.introductions.personal_story)}</li>
                </ol>
              </PreviewBlock>
              <PreviewBlock title="Review Link (readonly)">
                <div>Total Complete: {fmt(bundle?.reviewLink.cluving_review_link)}</div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  3w~27w: demo UI / DB 미연결
                </div>
              </PreviewBlock>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between">
              <div>
                <CardTitle className="text-base">Debug Summary</CardTitle>
                <p className="text-xs text-muted-foreground">
                  GET 응답 / 다음 PATCH payload — front Cluster2 GET 검증용
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
                  title="last applied (server-side pickWritable result)"
                  data={lastApplied}
                />
                <DebugSection title="bundle (admin GET)" data={bundle} />
                <div className="mt-3 text-muted-foreground">
                  <div>
                    front 검증 endpoints (user_id =
                    <code className="font-mono">{bundle?.userId ?? "—"}</code>):
                  </div>
                  <ul className="mt-1 list-disc pl-4">
                    <li>/api/photos?userId=…</li>
                    <li>/api/slogans?userId=…</li>
                    <li>/api/videos?userId=…</li>
                    <li>/api/educations?userId=…</li>
                    <li>/api/introductions?userId=…</li>
                  </ul>
                </div>
              </CardContent>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
