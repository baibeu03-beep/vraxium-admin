"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
    locked: true;
    lockReason: string;
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
const SLOGAN_FIELDS: readonly FieldDef[] = [
  { key: "slogan_1", label: "Slogan 1", type: "textarea", full: true },
  { key: "slogan_2", label: "Slogan 2", type: "textarea", full: true },
  { key: "slogan_3", label: "Slogan 3", type: "textarea", full: true },
];

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

const INTRODUCTION_FIELDS: readonly FieldDef[] = [
  {
    key: "growth_story",
    label: "성장 과정 (growth_story)",
    type: "textarea",
    full: true,
  },
  {
    key: "social_experience",
    label: "사회 경험 (social_experience)",
    type: "textarea",
    full: true,
  },
  {
    key: "career_direction",
    label: "커리어 방향 (career_direction)",
    type: "textarea",
    full: true,
  },
  {
    key: "work_style",
    label: "실무 스타일 (work_style)",
    type: "textarea",
    full: true,
  },
  {
    key: "personal_story",
    label: "퍼스널 스토리 (personal_story)",
    type: "textarea",
    full: true,
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
    slogans[field.key] = normalizeForPatch(form.slogans[field.key], field.type);
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

          {/* Slogans */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Slogans</CardTitle>
              <p className="text-xs text-muted-foreground">
                user_introductions.slogan_{`{1,2,3}`} · _tag · _rating
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {SLOGAN_FIELDS.map((field) => (
                  <FieldCell
                    key={field.key}
                    field={field}
                    value={form.slogans[field.key]}
                    onChange={(v) => setSloganValue(field.key, v)}
                    disabled={inputsDisabled}
                  />
                ))}
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
                user_introductions · 5 문항
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
              <CardTitle className="text-base">
                Review Link <span className="text-xs font-normal text-muted-foreground">(readonly)</span>
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {bundle?.reviewLink.lockReason ?? "정책상 제한 필드입니다."}
              </p>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm break-all">
                {fmt(bundle?.reviewLink.cluving_review_link)}
              </div>
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
              <PreviewBlock title="Slogan 1">
                {fmt(form.slogans.slogan_1)}
              </PreviewBlock>
              <PreviewBlock title="Slogan 2">
                {fmt(form.slogans.slogan_2)}
              </PreviewBlock>
              <PreviewBlock title="Slogan 3">
                {fmt(form.slogans.slogan_3)}
              </PreviewBlock>
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
                {fmt(bundle?.reviewLink.cluving_review_link)}
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
