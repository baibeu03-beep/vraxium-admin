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
import { formatAdminDateTime } from "@/lib/adminDateTime";
import {
  ORGANIZATION_LABEL,
  type OrganizationSlug,
} from "@/lib/organizations";
import {
  DebugSection,
  FieldCell,
  PreviewBlock,
  fmt,
  formatDepartmentName,
  normalizeForPatch,
  type FieldDef,
} from "@/components/admin/fieldKit";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import type { Cluster1ResumeDto } from "@/lib/cluster1ResumeTypes";

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
  point_label: string | null;
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
  {
    key: "display_name",
    label: "이름 (display_name)",
    type: "text",
    helpKey: "admin.crews.resume.field.displayName",
  },
  {
    key: "gender",
    label: "성별 (gender)",
    type: "text",
    helpKey: "admin.crews.resume.field.gender",
  },
  {
    key: "birth_date",
    label: "생년월일 (birth_date)",
    type: "date",
    helpKey: "admin.crews.resume.field.birthDate",
  },
  {
    key: "address",
    label: "주소 (address)",
    type: "text",
    full: true,
    helpKey: "admin.crews.resume.field.address",
  },
  {
    key: "contact_phone",
    label: "Phone (contact_phone)",
    type: "text",
    helpKey: "admin.crews.resume.field.contactPhone",
  },
  {
    key: "contact_email",
    label: "Email (contact_email)",
    type: "text",
    helpKey: "admin.crews.resume.field.contactEmail",
  },
  {
    key: "contact_available",
    label: "연락 가능 시간대/코멘트 (contact_available)",
    type: "textarea",
    full: true,
    placeholder: "예: 평일 19~22시 / 또는 user-app이 저장한 JSON 문자열 그대로",
    helpKey: "admin.crews.resume.field.contactAvailable",
  },
  {
    key: "vision",
    label: "Vision",
    type: "textarea",
    full: true,
    helpKey: "admin.crews.resume.field.vision",
  },
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
    helpKey: "admin.crews.resume.field.status",
  },
];

// dual-write 정리 (2026-05-13): EDUCATION_FIELDS / INTRODUCTION_FIELDS 입력 제거.
// 학력은 Cluster 2 → Educations, slogan_1 은 Cluster 2 → Slogans 에서만 수정.
// Cluster1 는 GET 응답을 읽기 전용으로 표시한다.

const MEMBERSHIP_FIELDS: readonly FieldDef[] = [
  {
    key: "team_name",
    label: "팀 (team_name)",
    type: "text",
    helpKey: "admin.crews.resume.field.teamName",
  },
  {
    key: "part_name",
    label: "파트 (part_name)",
    type: "text",
    helpKey: "admin.crews.resume.field.partName",
  },
  {
    key: "membership_level",
    label: "단계 (membership_level)",
    type: "text",
    helpKey: "admin.crews.resume.field.membershipLevel",
  },
  {
    key: "membership_state",
    label: "상태 (membership_state)",
    type: "text",
    helpKey: "admin.crews.resume.field.membershipState",
  },
  {
    key: "is_current",
    label: "is_current (현재 활성)",
    type: "checkbox",
    full: true,
    helpKey: "admin.crews.resume.field.isCurrent",
  },
];

const RESUME_CARD_SETTINGS_FIELDS: readonly FieldDef[] = [
  {
    key: "hexagon_link_1",
    label: "Hexagon 1 URL",
    type: "url",
    full: true,
    helpKey: "admin.crews.resume.field.hexagonLink1",
  },
  {
    key: "hexagon_link_2",
    label: "Hexagon 2 URL",
    type: "url",
    full: true,
    helpKey: "admin.crews.resume.field.hexagonLink2",
  },
  {
    key: "hexagon_link_3",
    label: "Hexagon 3 URL",
    type: "url",
    full: true,
    helpKey: "admin.crews.resume.field.hexagonLink3",
  },
  {
    key: "help_tooltip_text",
    label: "Help Tooltip Text",
    type: "textarea",
    full: true,
    helpKey: "admin.crews.resume.field.helpTooltipText",
  },
  {
    key: "medal_week_override",
    label: "Medal Week Override (비우면 approved_weeks 사용)",
    type: "number",
    helpKey: "admin.crews.resume.field.medalWeekOverride",
  },
];

const SECTION_DEFS: Record<
  EditableSection,
  {
    label: string;
    operatorLabel: string;
    description: string;
    titleHelpKey: string;
    fields: readonly FieldDef[];
  }
> = {
  profile: {
    label: "Profile",
    operatorLabel: "기본 정보",
    description: "user_profiles · 1:1",
    titleHelpKey: "admin.crews.resume.section.profile",
    fields: PROFILE_FIELDS,
  },
  membership: {
    label: "Membership",
    operatorLabel: "활동 정보",
    description: "user_memberships · is_current = true",
    titleHelpKey: "admin.crews.resume.section.membership",
    fields: MEMBERSHIP_FIELDS,
  },
  resumeCardSettings: {
    label: "Cluster1 Settings",
    operatorLabel: "이력 카드 설정",
    description: "user_resume_card_settings",
    titleHelpKey: "admin.crews.resume.section.settings",
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
  useReportLoading(loading);
  const [saving, setSaving] = useState(false);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [orgSettings, setOrgSettings] = useState<OrgSettings>(null);
  const [siteSettings, setSiteSettings] = useState<SiteSettings>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [banner, setBanner] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [resume, setResume] = useState<Cluster1ResumeDto | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<Record<
    string,
    Record<string, unknown>
  > | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [bundleRes, orgRes, siteRes, resumeRes] = await Promise.all([
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
        fetch(
          `/api/admin/crews/${encodeURIComponent(legacyUserId)}/resume-card/resume`,
          { cache: "no-store" },
        ),
      ]);
      const [bundleJson, orgJson, siteJson, resumeJson] = await Promise.all([
        bundleRes.json(),
        orgRes.json(),
        siteRes.json(),
        resumeRes.json(),
      ]);
      if (!bundleRes.ok || !bundleJson.success) {
        throw new Error(bundleJson?.error ?? "Failed to load resume-card.");
      }
      const b = bundleJson.data as Bundle;
      setBundle(b);
      setForm(syncFormFromBundle(b));
      setOrgSettings((orgJson?.data ?? null) as OrgSettings);
      setSiteSettings((siteJson?.data ?? null) as SiteSettings);
      setResume(
        resumeRes.ok && resumeJson?.success
          ? (resumeJson.data as Cluster1ResumeDto)
          : null,
      );
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
            {devMode ? "Save All" : "전체 저장"}
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
                  <CardTitle className="inline-flex items-center gap-1.5 text-base">
                    {devMode ? def.label : def.operatorLabel}
                    <AdminHelpIconButton
                      helpKey={def.titleHelpKey}
                      title={def.operatorLabel}
                      size="sm"
                    />
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
              <CardTitle className="inline-flex items-center gap-1.5 text-base">
                <span>
                  {devMode ? "Education" : "학력"}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    {devMode ? "(readonly)" : "(읽기 전용)"}
                  </span>
                </span>
                <AdminHelpIconButton
                  helpKey="admin.crews.resume.section.education"
                  title="학력"
                  size="sm"
                />
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
                  {formatDepartmentName(form.education.major_name_1)}
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
                  <CardTitle className="inline-flex items-center gap-1.5 text-base">
                    {devMode ? def.label : def.operatorLabel}
                    <AdminHelpIconButton
                      helpKey={def.titleHelpKey}
                      title={def.operatorLabel}
                      size="sm"
                    />
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
              <CardTitle className="inline-flex items-center gap-1.5 text-base">
                <span>
                  {devMode ? "Introduction" : "슬로건"}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    {devMode ? "(readonly)" : "(읽기 전용)"}
                  </span>
                </span>
                <AdminHelpIconButton
                  helpKey="admin.crews.resume.section.introduction"
                  title="슬로건"
                  size="sm"
                />
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
                  <CardTitle className="inline-flex items-center gap-1.5 text-base">
                    {devMode ? def.label : def.operatorLabel}
                    <AdminHelpIconButton
                      helpKey={def.titleHelpKey}
                      title={def.operatorLabel}
                      size="sm"
                    />
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

          {/* ── Resume Card 확장 섹션 (readonly) ── */}

          {/* 1. Resume 상태 배지 */}
          {resume && (
            <Card>
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-1.5 text-base">
                  {devMode ? "Resume Status Badge" : "이력 상태 배지"}
                  <AdminHelpIconButton
                    helpKey="admin.crews.resume.badge.status"
                    title="이력 상태 배지"
                    size="sm"
                  />
                </CardTitle>
                {devMode && (
                  <p className="text-xs text-muted-foreground">
                    user_profiles.status → resume badge mapping
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold",
                      resume.resumeStatus.status === "complete"
                        ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300"
                        : resume.resumeStatus.status === "running"
                          ? "bg-blue-100 text-blue-800 ring-1 ring-blue-300"
                          : resume.resumeStatus.status === "on_rest"
                            ? "bg-amber-100 text-amber-800 ring-1 ring-amber-300"
                            : resume.resumeStatus.status === "recharging"
                              ? "bg-purple-100 text-purple-800 ring-1 ring-purple-300"
                              : "bg-muted text-muted-foreground ring-1 ring-border",
                      resume.resumeStatus.isBadgeDimmed && "opacity-60",
                    )}
                  >
                    {resume.resumeStatus.label}
                  </span>
                  {resume.resumeStatus.status === "complete" && (
                    <span className="text-xs font-medium text-emerald-600">
                      ✓ Complete
                    </span>
                  )}
                </div>
                {devMode && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    status: <code>{resume.resumeStatus.status}</code> ·
                    dimmed: <code>{String(resume.resumeStatus.isBadgeDimmed)}</code>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* 2. 일정 신뢰도 */}
          {resume && (
            <Card>
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-1.5 text-base">
                  {devMode ? "Schedule Reliability" : "일정 신뢰도"}
                  <AdminHelpIconButton
                    helpKey="admin.crews.resume.section.reliability"
                    title="일정 신뢰도"
                    size="sm"
                  />
                </CardTitle>
                {devMode && (
                  <p className="text-xs text-muted-foreground">
                    ((d + b) / (a - e)) × 100
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <div className="mb-3 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tabular-nums">
                    {resume.scheduleReliability.rate}
                  </span>
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-md border bg-muted/30 px-2 py-1.5">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode ? "a · 물리 주차" : "물리 주차"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.physicalWeeks"
                        title="물리 주차"
                        size="xs"
                      />
                    </div>
                    <div className="font-medium tabular-nums">
                      {resume.scheduleReliability.physicalWeeks}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-2 py-1.5">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode ? "b · 사전 휴식" : "사전 휴식"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.preRestWeeks"
                        title="사전 휴식"
                        size="xs"
                      />
                    </div>
                    <div className="font-medium tabular-nums">
                      {resume.scheduleReliability.preRestWeeks}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-2 py-1.5">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode ? "c · 미인정" : "미인정"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.unapprovedWeeks"
                        title="미인정"
                        size="xs"
                      />
                    </div>
                    <div className="font-medium tabular-nums">
                      {resume.scheduleReliability.unapprovedActiveWeeks}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-2 py-1.5">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode ? "d · 인정" : "인정"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.approvedWeeks"
                        title="인정"
                        size="xs"
                      />
                    </div>
                    <div className="font-medium tabular-nums">
                      {resume.scheduleReliability.approvedActiveWeeks}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-2 py-1.5 col-span-2">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode ? "e · 공식 휴식" : "공식 휴식"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.officialRestWeeks"
                        title="공식 휴식"
                        size="xs"
                      />
                    </div>
                    <div className="font-medium tabular-nums">
                      {resume.scheduleReliability.officialRestWeeks}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* 3. 활동 완료율 */}
          {resume && (
            <Card>
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-1.5 text-base">
                  {devMode ? "Activity Completion" : "활동 완료율"}
                  <AdminHelpIconButton
                    helpKey="admin.crews.resume.section.completion"
                    title="활동 완료율"
                    size="sm"
                  />
                </CardTitle>
                {devMode && (
                  <p className="text-xs text-muted-foreground">
                    (r / p) × 100 · Cluster4 실데이터 연동
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <div className="mb-3 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tabular-nums">
                    {resume.activityCompletion.rate}
                  </span>
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-md border bg-muted/30 px-2 py-1.5">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode ? "p · 가능 활동" : "가능 활동"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.availableActivities"
                        title="가능 활동"
                        size="xs"
                      />
                    </div>
                    <div className="font-medium tabular-nums">
                      {resume.activityCompletion.availableActivities}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-2 py-1.5">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode ? "r · 이행 활동" : "이행 활동"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.completedActivities"
                        title="이행 활동"
                        size="xs"
                      />
                    </div>
                    <div className="font-medium tabular-nums">
                      {resume.activityCompletion.completedActivities}
                    </div>
                  </div>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-foreground transition-all"
                    style={{
                      width: `${Math.min(100, resume.activityCompletion.rate)}%`,
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* 4. 진행 시즌 리스트 */}
          {resume && resume.seasonRecords.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-1.5 text-base">
                  {devMode ? "Season Records" : "진행 시즌 리스트"}
                  <AdminHelpIconButton
                    helpKey="admin.crews.resume.section.seasons"
                    title="진행 시즌"
                    size="sm"
                  />
                </CardTitle>
                {devMode && (
                  <p className="text-xs text-muted-foreground">
                    season_definitions + user_week_statuses
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-1.5 pr-2 font-medium">
                          <span className="inline-flex items-center gap-1">
                            {devMode ? "Year" : "년도"}
                            <AdminHelpIconButton
                              helpKey="admin.crews.resume.column.year"
                              title="년도"
                              size="xs"
                            />
                          </span>
                        </th>
                        <th className="pb-1.5 pr-2 font-medium">
                          <span className="inline-flex items-center gap-1">
                            {devMode ? "Season" : "시즌"}
                            <AdminHelpIconButton
                              helpKey="admin.crews.resume.column.season"
                              title="시즌"
                              size="xs"
                            />
                          </span>
                        </th>
                        <th className="pb-1.5 pr-2 font-medium">
                          <span className="inline-flex items-center gap-1">
                            {devMode ? "Position" : "포지션"}
                            <AdminHelpIconButton
                              helpKey="admin.crews.resume.column.position"
                              title="포지션"
                              size="xs"
                            />
                          </span>
                        </th>
                        <th className="pb-1.5 pr-2 font-medium">
                          <span className="inline-flex items-center gap-1">
                            {devMode ? "Status" : "상태"}
                            <AdminHelpIconButton
                              helpKey="admin.crews.resume.column.status"
                              title="상태"
                              size="xs"
                            />
                          </span>
                        </th>
                        <th className="pb-1.5 pr-2 font-medium">
                          <span className="inline-flex items-center gap-1">
                            {devMode ? "Weeks" : "주차"}
                            <AdminHelpIconButton
                              helpKey="admin.crews.resume.column.weeks"
                              title="주차"
                              size="xs"
                            />
                          </span>
                        </th>
                        <th className="pb-1.5 font-medium">
                          <span className="inline-flex items-center gap-1">
                            {devMode ? "Review" : "검수"}
                            <AdminHelpIconButton
                              helpKey="admin.crews.resume.column.review"
                              title="검수"
                              size="xs"
                            />
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {resume.seasonRecords.map((rec, idx) => (
                        <tr
                          key={idx}
                          className="border-b border-border/40 last:border-b-0"
                        >
                          <td className="py-1.5 pr-2 tabular-nums">
                            {rec.year}
                          </td>
                          <td className="py-1.5 pr-2">{rec.seasonName}</td>
                          <td className="py-1.5 pr-2">
                            <span className="inline-flex rounded bg-muted px-1.5 py-0.5 text-[10px]">
                              {rec.position}
                            </span>
                          </td>
                          <td className="py-1.5 pr-2">
                            <span
                              className={cn(
                                "inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium",
                                rec.progressStatus === "진행 중" &&
                                  "bg-blue-50 text-blue-700",
                                rec.progressStatus === "정상 완료" &&
                                  "bg-emerald-50 text-emerald-700",
                                rec.progressStatus === "정상 졸업" &&
                                  "bg-emerald-100 text-emerald-800",
                                rec.progressStatus === "통합 휴식" &&
                                  "bg-amber-50 text-amber-700",
                                rec.progressStatus === "활동 중단" &&
                                  "bg-red-50 text-red-700",
                              )}
                            >
                              {rec.progressStatus}
                            </span>
                          </td>
                          <td className="py-1.5 pr-2 tabular-nums">
                            {rec.approvedWeeks}/{rec.totalWeeks}
                          </td>
                          <td className="py-1.5">
                            <span
                              className={cn(
                                "text-[10px]",
                                rec.reviewStatus === "검수 중"
                                  ? "text-amber-600"
                                  : "text-emerald-600",
                              )}
                            >
                              {rec.reviewStatus}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* 5. 실무 성적 요약 */}
          {resume && (
            <Card>
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-1.5 text-base">
                  {devMode ? "Practical Stats" : "실무 성적 요약"}
                  <AdminHelpIconButton
                    helpKey="admin.crews.resume.section.stats"
                    title="실무 성적"
                    size="sm"
                  />
                </CardTitle>
                {devMode && (
                  <p className="text-xs text-muted-foreground">
                    Cluster4 실데이터 연동
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-md border bg-muted/30 px-2 py-2">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode
                        ? "실무 정보 습득 (infoCount)"
                        : "실무 정보 습득"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.infoCount"
                        title="실무 정보 습득"
                        size="xs"
                      />
                    </div>
                    <div className="mt-0.5 font-semibold tabular-nums">
                      {resume.practicalStats.infoCount}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        회
                      </span>
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-2 py-2">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode
                        ? "실무 경험 축적 (experienceCount)"
                        : "실무 경험 축적"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.experienceCount"
                        title="실무 경험 축적"
                        size="xs"
                      />
                    </div>
                    <div className="mt-0.5 font-semibold tabular-nums">
                      {resume.practicalStats.experienceCount}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        건
                      </span>
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-2 py-2">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode
                        ? "실무 역량 성장 (abilityUnitCount)"
                        : "실무 역량 성장"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.abilityUnitCount"
                        title="실무 역량 성장"
                        size="xs"
                      />
                    </div>
                    <div className="mt-0.5 font-semibold tabular-nums">
                      {resume.practicalStats.abilityUnitCount}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        unit
                      </span>
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-2 py-2">
                    <div className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {devMode
                        ? "실무 경력 누적 (careerProjectCount)"
                        : "실무 경력 누적"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.resume.metric.careerProjectCount"
                        title="실무 경력 누적"
                        size="xs"
                      />
                    </div>
                    <div className="mt-0.5 font-semibold tabular-nums">
                      {resume.practicalStats.careerProjectCount}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        proj
                      </span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
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
                {formatDepartmentName(form.education.major_name_1)}
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
                <DebugSection title="resume (Cluster1 Resume DTO)" data={resume} />
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

