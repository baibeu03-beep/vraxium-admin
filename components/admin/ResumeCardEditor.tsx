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
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";

// 라벨 끝의 영문 column-name 괄호 제거 — "이름 (display_name)" → "이름".
function operatorLabel(label: string): string {
  return label.replace(/\s*\([a-z0-9_,\s]+\)\s*$/i, "").trim() || label;
}

function operatorizeFields(
  fields: readonly FieldDef[],
  devMode: boolean,
): readonly FieldDef[] {
  if (devMode) return fields;
  return fields.map((f) => ({ ...f, label: operatorLabel(f.label) }));
}

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────
type Bundle = {
  legacyUserId: string;
  userId: string | null;
  profile: Record<string, unknown> | null;
  education: Record<string, unknown> | null;
  membership: Record<string, unknown> | null;
  introduction: Record<string, unknown> | null;
  resumeCardSettings: Record<string, unknown> | null;
  computed: {
    approvedWeeks: number | null;
    cumulativeWeeks: number | null;
    totalStars: number | null;
    totalShields: number | null;
    totalLightnings: number | null;
  };
};

type OrgSettings = {
  organization_slug: string;
  medal_theme: string | null;
  notice_top_text: string | null;
  notice_top_stamp_image_url: string | null;
} | null;

type SiteSettings = {
  id: number;
  notice_bottom_text: string | null;
  notice_bottom_stamp_image_url: string | null;
  help_tooltip_default: string | null;
} | null;

// Section = FormState 보관용 union (preview/표시까지 포함).
// EditableSection = 실제 PATCH body 에 포함되는 union — dual-write 정리 (2026-05-13) 후
//   profile / membership / resumeCardSettings 만 편집 가능.
//   education, introduction(slogan_1) 은 Cluster 2 가 canonical writer 이므로 표시만.
type Section =
  | "profile"
  | "education"
  | "membership"
  | "introduction"
  | "resumeCardSettings";

type EditableSection = "profile" | "membership" | "resumeCardSettings";

type FormState = Record<Section, Record<string, unknown>>;

// ─────────────────────────────────────────────────────────────────────
// Field definitions (must match lib/adminResumeCardData.ts whitelists)
// ─────────────────────────────────────────────────────────────────────
// 실제 user_profiles 스키마 기준. lib/adminResumeCardData.ts:PROFILE_FIELDS 와 일치해야 함.
// contact_available: text 컬럼. user-app resume-card 모달이 plain text 또는 JSON 문자열로
//   저장하므로 admin 측에선 textarea로 그대로 노출한다.
// 제거됨: eng_name, phone, email, bio — DB 컬럼 미존재로 PATCH 500 유발
// dual-write 정리 (2026-05-13): profile_photo_url 제거 — Cluster 2 → Photos 가 canonical writer.
const PROFILE_FIELDS: readonly FieldDef[] = [
  { key: "display_name", label: "이름 (display_name)", type: "text" },
  { key: "gender", label: "성별 (gender)", type: "text" },
  { key: "birth_date", label: "생년월일 (birth_date)", type: "date" },
  { key: "address", label: "주소 (address)", type: "text", full: true },
  { key: "contact_phone", label: "Phone (contact_phone)", type: "text" },
  { key: "contact_email", label: "Email (contact_email)", type: "text" },
  {
    key: "contact_available",
    label: "연락 가능 시간대/코멘트 (contact_available)",
    type: "textarea",
    full: true,
    placeholder: "예: 평일 19~22시 / 또는 user-app이 저장한 JSON 문자열 그대로",
  },
  { key: "vision", label: "Vision", type: "textarea", full: true },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      "active",
      "weekly_rest",
      "seasonal_rest",
      "graduated",
      "suspended",
    ],
  },
];

// dual-write 정리 (2026-05-13): EDUCATION_FIELDS / INTRODUCTION_FIELDS 입력 제거.
// 학력은 Cluster 2 → Educations, slogan_1 은 Cluster 2 → Slogans 에서만 수정.
// Cluster1 는 GET 응답을 읽기 전용으로 표시한다.

const MEMBERSHIP_FIELDS: readonly FieldDef[] = [
  { key: "team_name", label: "팀 (team_name)", type: "text" },
  { key: "part_name", label: "파트 (part_name)", type: "text" },
  { key: "membership_level", label: "단계 (membership_level)", type: "text" },
  { key: "membership_state", label: "상태 (membership_state)", type: "text" },
  {
    key: "is_current",
    label: "is_current (현재 활성)",
    type: "checkbox",
    full: true,
  },
];

const RESUME_CARD_SETTINGS_FIELDS: readonly FieldDef[] = [
  { key: "hexagon_link_1", label: "Hexagon 1 URL", type: "url", full: true },
  { key: "hexagon_link_2", label: "Hexagon 2 URL", type: "url", full: true },
  { key: "hexagon_link_3", label: "Hexagon 3 URL", type: "url", full: true },
  {
    key: "help_tooltip_text",
    label: "Help Tooltip Text",
    type: "textarea",
    full: true,
  },
  {
    key: "medal_week_override",
    label: "Medal Week Override (비우면 approved_weeks 사용)",
    type: "number",
  },
];

const SECTION_DEFS: Record<
  EditableSection,
  {
    label: string;
    operatorLabel: string;
    description: string;
    fields: readonly FieldDef[];
  }
> = {
  profile: {
    label: "Profile",
    operatorLabel: "기본 정보",
    description: "user_profiles · 1:1",
    fields: PROFILE_FIELDS,
  },
  membership: {
    label: "Membership",
    operatorLabel: "활동 정보",
    description: "user_memberships · is_current = true",
    fields: MEMBERSHIP_FIELDS,
  },
  resumeCardSettings: {
    label: "Cluster1 Settings",
    operatorLabel: "이력 카드 설정",
    description: "user_resume_card_settings",
    fields: RESUME_CARD_SETTINGS_FIELDS,
  },
};

// dual-write 정리 (2026-05-13): education / introduction 은 PATCH 대상에서 제외.
const SECTION_ORDER: readonly EditableSection[] = [
  "profile",
  "membership",
  "resumeCardSettings",
];

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
function emptyForm(): FormState {
  return {
    profile: {},
    education: {},
    membership: {},
    introduction: {},
    resumeCardSettings: {},
  };
}

function syncFormFromBundle(bundle: Bundle | null): FormState {
  if (!bundle) return emptyForm();
  return {
    profile: { ...(bundle.profile ?? {}) },
    education: { ...(bundle.education ?? {}) },
    membership: { ...(bundle.membership ?? {}) },
    introduction: { ...(bundle.introduction ?? {}) },
    resumeCardSettings: { ...(bundle.resumeCardSettings ?? {}) },
  };
}

function buildPatchBody(
  form: FormState,
): Record<EditableSection, Record<string, unknown>> {
  const out = {} as Record<EditableSection, Record<string, unknown>>;
  for (const section of SECTION_ORDER) {
    const def = SECTION_DEFS[section];
    const sectionPatch: Record<string, unknown> = {};
    for (const field of def.fields) {
      sectionPatch[field.key] = normalizeForPatch(
        form[section][field.key],
        field.type,
      );
    }
    out[section] = sectionPatch;
  }
  return out;
}


// ─────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────
export default function ResumeCardEditor({
  organization,
  legacyUserId,
  memberDisplayName,
}: {
  organization: OrganizationSlug;
  legacyUserId: string;
  memberDisplayName?: string | null;
}) {
  const devMode = useAdminDevMode();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [orgSettings, setOrgSettings] = useState<OrgSettings>(null);
  const [siteSettings, setSiteSettings] = useState<SiteSettings>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [banner, setBanner] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<Record<
    string,
    Record<string, unknown>
  > | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [bundleRes, orgRes, siteRes] = await Promise.all([
        fetch(
          `/api/admin/crews/${encodeURIComponent(legacyUserId)}/resume-card`,
          { cache: "no-store" },
        ),
        fetch(
          `/api/admin/settings/organizations/${encodeURIComponent(
            organization,
          )}/resume-card`,
          { cache: "no-store" },
        ),
        fetch(`/api/admin/settings/site/resume-card`, { cache: "no-store" }),
      ]);
      const [bundleJson, orgJson, siteJson] = await Promise.all([
        bundleRes.json(),
        orgRes.json(),
        siteRes.json(),
      ]);
      if (!bundleRes.ok || !bundleJson.success) {
        throw new Error(bundleJson?.error ?? "Failed to load resume-card.");
      }
      const b = bundleJson.data as Bundle;
      setBundle(b);
      setForm(syncFormFromBundle(b));
      setOrgSettings((orgJson?.data ?? null) as OrgSettings);
      setSiteSettings((siteJson?.data ?? null) as SiteSettings);
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load.",
      });
    } finally {
      setLoading(false);
    }
  }, [legacyUserId, organization]);

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
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/resume-card`,
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
      setLastApplied(
        (json.applied ?? null) as Record<
          string,
          Record<string, unknown>
        > | null,
      );
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

  const setFieldValue = (
    section: EditableSection,
    key: string,
    value: unknown,
  ) => {
    setForm((current) => ({
      ...current,
      [section]: { ...current[section], [key]: value },
    }));
  };

  const isReadOnly = !bundle?.userId;
  const inputsDisabled = loading || saving || isReadOnly;

  // Resolve preview values (mirrors user-app /api/profile resolution priority)
  const resolvedMedalTheme = orgSettings?.medal_theme ?? null;
  const overrideRaw = form.resumeCardSettings.medal_week_override;
  const overrideNum =
    typeof overrideRaw === "number"
      ? overrideRaw
      : typeof overrideRaw === "string" && overrideRaw.trim() !== ""
        ? Number(overrideRaw)
        : null;
  const resolvedMedalWeek =
    overrideNum !== null && Number.isFinite(overrideNum)
      ? overrideNum
      : (bundle?.computed.approvedWeeks ?? 0);

  const helpOverride = form.resumeCardSettings.help_tooltip_text;
  const resolvedHelpText =
    typeof helpOverride === "string" && helpOverride.trim() !== ""
      ? helpOverride
      : (siteSettings?.help_tooltip_default ?? null);

  // Client-side preview of what would be sent on Save.
  // 서버의 pickWritable이 다시 한번 whitelist 필터링하므로, 이 페이로드의
  // 키 = 실제 DB update 대상 컬럼 (1:1 매칭).
  const nextPatchPayload = useMemo(() => buildPatchBody(form), [form]);

  return (
    <div className="flex flex-col gap-4">
      {/* top bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold">
            {devMode ? "Cluster1 Editor" : "이력 카드 편집"}
          </h1>
          <div className="text-xs text-muted-foreground">
            {ORGANIZATION_LABEL[organization]} ·{" "}
            <span className="font-medium text-foreground">
              {memberDisplayName ?? (devMode ? legacyUserId : "이름 미등록")}
            </span>
            {devMode && (
              <>
                {" "}
                · legacy_user_id:{" "}
                <code className="font-mono">{legacyUserId}</code>
              </>
            )}
            {devMode && bundle?.userId && (
              <>
                {" "}
                · user_id: <code className="font-mono">{bundle.userId}</code>
              </>
            )}
            {lastSavedAt && (
              <>
                {" "}
                · {devMode ? "last saved" : "최근 저장"}:{" "}
                <code className="font-mono">{lastSavedAt}</code>
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
            disabled={inputsDisabled}
          >
            <Save className="h-4 w-4" />
            {saving
              ? devMode
                ? "Saving..."
                : "저장 중..."
              : devMode
                ? "Save All"
                : "전체 저장"}
          </Button>
        </div>
      </div>

      {/* read-only notice */}
      {isReadOnly && !loading && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {devMode ? (
            <>
              이 crew는 user_profiles에 매칭되는 행이 없어{" "}
              <strong>읽기 전용</strong>입니다. legacy_user_id{" "}
              <code className="font-mono">{legacyUserId}</code>의 인증 가입 후
              다시 시도하세요.
            </>
          ) : (
            <>
              이 회원은 아직 가입 전이라 <strong>읽기 전용</strong>입니다. 회원
              가입 완료 후 다시 시도하세요.
            </>
          )}
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
        {/* form — 편집 가능 섹션은 SECTION_ORDER 만, 학력/슬로건은 readonly 카드 */}
        <div className="flex flex-col gap-4 xl:col-span-2">
          {/* Profile (편집) — profile_photo_url 은 dual-write 정리로 제거됨 */}
          {(() => {
            const def = SECTION_DEFS.profile;
            const photoUrl =
              (bundle?.profile?.profile_photo_url as string | null) ?? null;
            return (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {devMode ? def.label : def.operatorLabel}
                  </CardTitle>
                  {devMode && (
                    <p className="text-xs text-muted-foreground">
                      {def.description}
                    </p>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="mb-3 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    {devMode ? (
                      <>
                        프로필 사진은 <strong>Cluster 2 → Photos</strong> 에서
                        수정합니다.
                      </>
                    ) : (
                      <>
                        프로필 사진은 <strong>활동 페이지 편집 → 사진</strong>{" "}
                        에서 수정합니다.
                      </>
                    )}
                    {devMode && photoUrl && (
                      <div className="mt-1 break-all font-mono text-[10px]">
                        {photoUrl}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {operatorizeFields(def.fields, devMode).map((field) => (
                      <FieldCell
                        key={field.key}
                        field={field}
                        value={form.profile[field.key]}
                        onChange={(v) =>
                          setFieldValue("profile", field.key, v)
                        }
                        disabled={inputsDisabled}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Education (readonly) — Cluster 2 → Educations 가 canonical writer */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {devMode ? "Education" : "학력"}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {devMode ? "(readonly)" : "(읽기 전용)"}
                </span>
              </CardTitle>
              {devMode && (
                <p className="text-xs text-muted-foreground">
                  user_educations · 대표학력 표시 전용
                </p>
              )}
            </CardHeader>
            <CardContent>
              <div className="mb-3 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {devMode ? (
                  <>
                    학력은 <strong>Cluster 2 → Educations</strong> 에서
                    수정합니다. Cluster1 는 대표학력
                    (<code className="font-mono">is_primary=true</code>) 만
                    표시합니다.
                  </>
                ) : (
                  <>
                    학력은 <strong>활동 페이지 편집 → 학력</strong> 에서
                    수정합니다. 이력 카드에는 대표학력만 표시됩니다.
                  </>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-sm">
                <PreviewBlock title={devMode ? "학교 (school_name)" : "학교"}>
                  {fmt(form.education.school_name)}
                </PreviewBlock>
                <PreviewBlock title={devMode ? "전공 (major_name_1)" : "전공"}>
                  {fmt(form.education.major_name_1)}
                </PreviewBlock>
                {devMode && (
                  <>
                    <PreviewBlock title="is_primary">
                      {String(Boolean(form.education.is_primary))}
                    </PreviewBlock>
                    <PreviewBlock title="sort_order">
                      {fmt(form.education.sort_order)}
                    </PreviewBlock>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Membership (편집) */}
          {(() => {
            const def = SECTION_DEFS.membership;
            return (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {devMode ? def.label : def.operatorLabel}
                  </CardTitle>
                  {devMode && (
                    <p className="text-xs text-muted-foreground">
                      {def.description}
                    </p>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {operatorizeFields(def.fields, devMode).map((field) => (
                      <FieldCell
                        key={field.key}
                        field={field}
                        value={form.membership[field.key]}
                        onChange={(v) =>
                          setFieldValue("membership", field.key, v)
                        }
                        disabled={inputsDisabled}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Introduction (readonly) — Cluster 2 → Slogans 가 canonical writer */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {devMode ? "Introduction" : "슬로건"}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {devMode ? "(readonly)" : "(읽기 전용)"}
                </span>
              </CardTitle>
              {devMode && (
                <p className="text-xs text-muted-foreground">
                  user_introductions · slogan 표시 전용
                </p>
              )}
            </CardHeader>
            <CardContent>
              <div className="mb-3 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {devMode ? (
                  <>
                    Slogan 은 <strong>Cluster 2 → Slogans</strong> 에서
                    수정합니다.
                  </>
                ) : (
                  <>
                    슬로건은 <strong>활동 페이지 편집 → 슬로건</strong> 에서
                    수정합니다.
                  </>
                )}
              </div>
              <PreviewBlock title={devMode ? "Slogan 1" : "슬로건 1"}>
                {fmt(form.introduction.slogan_1)}
              </PreviewBlock>
            </CardContent>
          </Card>

          {/* Cluster1 Settings (편집) */}
          {(() => {
            const def = SECTION_DEFS.resumeCardSettings;
            return (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {devMode ? def.label : def.operatorLabel}
                  </CardTitle>
                  {devMode && (
                    <p className="text-xs text-muted-foreground">
                      {def.description}
                    </p>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {operatorizeFields(def.fields, devMode).map((field) => (
                      <FieldCell
                        key={field.key}
                        field={field}
                        value={form.resumeCardSettings[field.key]}
                        onChange={(v) =>
                          setFieldValue("resumeCardSettings", field.key, v)
                        }
                        disabled={inputsDisabled}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </div>

        {/* preview + debug */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {devMode ? "Sidebar Preview" : "이력 카드 미리보기"}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {devMode
                  ? "resume-card 표시값 미리보기 (form 기준)"
                  : "이력 카드에 표시될 값을 미리 보여줍니다."}
              </p>
            </CardHeader>
            <CardContent className="text-sm">
              <PreviewBlock title="Photo">
                {fmt(form.profile.profile_photo_url)}
              </PreviewBlock>
              <PreviewBlock title="Name">
                {fmt(form.profile.display_name)}{" "}
                <span className="text-muted-foreground">
                  ({fmt(form.profile.eng_name)})
                </span>
              </PreviewBlock>
              <PreviewBlock title="성별 / 생년월일">
                {fmt(form.profile.gender)} / {fmt(form.profile.birth_date)}
              </PreviewBlock>
              <PreviewBlock title="주소">
                {fmt(form.profile.address)}
              </PreviewBlock>
              <PreviewBlock title="Phone / Email">
                {fmt(form.profile.phone ?? form.profile.contact_phone)}
                {" / "}
                {fmt(form.profile.email ?? form.profile.contact_email)}
              </PreviewBlock>
              <PreviewBlock title="연락 가능 시간대/코멘트">
                {fmt(form.profile.contact_available)}
              </PreviewBlock>
              <PreviewBlock title="학교 · 학과">
                {fmt(form.education.school_name)} ·{" "}
                {fmt(form.education.major_name_1)}
              </PreviewBlock>
              <PreviewBlock title="팀 · 파트 · 단계">
                {fmt(form.membership.team_name)} ·{" "}
                {fmt(form.membership.part_name)} ·{" "}
                {fmt(form.membership.membership_level)}
              </PreviewBlock>
              <PreviewBlock title="Slogan">
                {fmt(form.introduction.slogan_1)}
              </PreviewBlock>
              <PreviewBlock title="Stats (read-only)">
                approved/cumulative: {fmt(bundle?.computed.approvedWeeks)} /{" "}
                {fmt(bundle?.computed.cumulativeWeeks)}
                <br />⭐ {fmt(bundle?.computed.totalStars)} 🛡{" "}
                {fmt(bundle?.computed.totalShields)} ⚡{" "}
                {fmt(bundle?.computed.totalLightnings)}
              </PreviewBlock>
              <PreviewBlock title="Status (medal text)">
                {fmt(form.profile.status)}
              </PreviewBlock>
              <PreviewBlock title="Medal (org + override)">
                theme: {fmt(resolvedMedalTheme)} · week:{" "}
                {fmt(resolvedMedalWeek)}
              </PreviewBlock>
              <PreviewBlock title="Hexagon Links">
                <ol className="list-decimal pl-4">
                  <li>{fmt(form.resumeCardSettings.hexagon_link_1)}</li>
                  <li>{fmt(form.resumeCardSettings.hexagon_link_2)}</li>
                  <li>{fmt(form.resumeCardSettings.hexagon_link_3)}</li>
                </ol>
              </PreviewBlock>
              <PreviewBlock title="Notice Top (org)">
                {fmt(orgSettings?.notice_top_text)}
                {orgSettings?.notice_top_stamp_image_url && (
                  <div className="mt-1 break-all text-xs text-muted-foreground">
                    stamp: {orgSettings.notice_top_stamp_image_url}
                  </div>
                )}
              </PreviewBlock>
              <PreviewBlock title="Notice Bottom (site)">
                {fmt(siteSettings?.notice_bottom_text)}
                {siteSettings?.notice_bottom_stamp_image_url && (
                  <div className="mt-1 break-all text-xs text-muted-foreground">
                    stamp: {siteSettings.notice_bottom_stamp_image_url}
                  </div>
                )}
              </PreviewBlock>
              <PreviewBlock title="Help Tooltip">
                {fmt(resolvedHelpText)}
              </PreviewBlock>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between">
              <div>
                <CardTitle className="text-base">Debug Summary</CardTitle>
                <p className="text-xs text-muted-foreground">
                  GET 응답 (DB 기준) — /api/profile 검증용
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
                <DebugSection title="orgSettings" data={orgSettings} />
                <DebugSection title="siteSettings" data={siteSettings} />
                <p className="mt-3 text-muted-foreground">
                  user-app 검증 endpoint:{" "}
                  <code className="font-mono">
                    /api/profile?userId={bundle?.userId ?? "—"}
                  </code>
                </p>
              </CardContent>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

