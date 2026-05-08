"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ORGANIZATION_LABEL,
  type OrganizationSlug,
} from "@/lib/organizations";

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

type FieldType =
  | "text"
  | "textarea"
  | "date"
  | "number"
  | "checkbox"
  | "select"
  | "url";

type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
  placeholder?: string;
  full?: boolean;
};

type Section =
  | "profile"
  | "education"
  | "membership"
  | "introduction"
  | "resumeCardSettings";

type FormState = Record<Section, Record<string, unknown>>;

// ─────────────────────────────────────────────────────────────────────
// Field definitions (must match lib/adminResumeCardData.ts whitelists)
// ─────────────────────────────────────────────────────────────────────
// 실제 user_profiles 스키마 기준. lib/adminResumeCardData.ts:PROFILE_FIELDS 와 일치해야 함.
// contact_available: text 컬럼. user-app resume-card 모달이 plain text 또는 JSON 문자열로
//   저장하므로 admin 측에선 textarea로 그대로 노출한다.
// 제거됨: eng_name, phone, email, bio — DB 컬럼 미존재로 PATCH 500 유발
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
  {
    key: "profile_photo_url",
    label: "Profile Photo URL",
    type: "url",
    full: true,
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

// 실제 user_educations 스키마 기준. lib/adminResumeCardData.ts:EDUCATION_FIELDS 와 일치해야 함.
// 제거됨: major_name_2/3, status, admission_year, graduation_year, grade_value, grade_max_type
const EDUCATION_FIELDS: readonly FieldDef[] = [
  { key: "school_name", label: "학교 (school_name)", type: "text" },
  { key: "major_name_1", label: "전공 (major_name_1)", type: "text" },
  {
    key: "is_primary",
    label: "is_primary (대표 학력 여부)",
    type: "checkbox",
    full: true,
  },
  { key: "sort_order", label: "Sort Order", type: "number" },
];

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

const INTRODUCTION_FIELDS: readonly FieldDef[] = [
  { key: "slogan_1", label: "Slogan 1", type: "textarea", full: true },
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
  Section,
  { label: string; description: string; fields: readonly FieldDef[] }
> = {
  profile: {
    label: "Profile",
    description: "user_profiles · 1:1",
    fields: PROFILE_FIELDS,
  },
  education: {
    label: "Education",
    description: "user_educations · sort_order = 0",
    fields: EDUCATION_FIELDS,
  },
  membership: {
    label: "Membership",
    description: "user_memberships · is_current = true",
    fields: MEMBERSHIP_FIELDS,
  },
  introduction: {
    label: "Introduction",
    description: "user_introductions",
    fields: INTRODUCTION_FIELDS,
  },
  resumeCardSettings: {
    label: "Resume Card Settings",
    description: "user_resume_card_settings",
    fields: RESUME_CARD_SETTINGS_FIELDS,
  },
};

const SECTION_ORDER: readonly Section[] = [
  "profile",
  "education",
  "membership",
  "introduction",
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

function normalizeForPatch(value: unknown, type: FieldType): unknown {
  if (type === "checkbox") return Boolean(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (type === "number") {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    return trimmed;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return value ?? null;
}

function buildPatchBody(form: FormState): Record<Section, Record<string, unknown>> {
  const out = {} as Record<Section, Record<string, unknown>>;
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

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// ─────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────
export default function ResumeCardEditor({
  organization,
  legacyUserId,
}: {
  organization: OrganizationSlug;
  legacyUserId: string;
}) {
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

  const setFieldValue = (section: Section, key: string, value: unknown) => {
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
          <h1 className="text-lg font-semibold">Resume Card Editor</h1>
          <div className="text-xs text-muted-foreground">
            {ORGANIZATION_LABEL[organization]} · legacy_user_id:{" "}
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
                · last saved:{" "}
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
          이 crew는 user_profiles에 매칭되는 행이 없어 <strong>읽기 전용</strong>
          입니다. legacy_user_id{" "}
          <code className="font-mono">{legacyUserId}</code>의 인증 가입 후 다시
          시도하세요.
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
        {/* form (5 sections) */}
        <div className="flex flex-col gap-4 xl:col-span-2">
          {SECTION_ORDER.map((section) => {
            const def = SECTION_DEFS[section];
            return (
              <Card key={section}>
                <CardHeader>
                  <CardTitle className="text-base">{def.label}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {def.description}
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {def.fields.map((field) => (
                      <FieldCell
                        key={field.key}
                        field={field}
                        value={form[section][field.key]}
                        onChange={(v) => setFieldValue(section, field.key, v)}
                        disabled={inputsDisabled}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* preview + debug */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sidebar Preview</CardTitle>
              <p className="text-xs text-muted-foreground">
                resume-card 표시값 미리보기 (form 기준)
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

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────
function FieldCell({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", field.full && "sm:col-span-2")}>
      <Label className="text-xs">{field.label}</Label>
      <FieldInput
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const stringValue = value == null ? "" : String(value);

  if (field.type === "textarea") {
    return (
      <textarea
        value={stringValue}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={3}
        placeholder={field.placeholder}
        className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
      />
    );
  }

  if (field.type === "checkbox") {
    return (
      <label className="mt-1 inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <span className="text-muted-foreground">
          {Boolean(value) ? "true" : "false"}
        </span>
      </label>
    );
  }

  if (field.type === "select" && field.options) {
    const NULL_TOKEN = "__null__";
    const current = stringValue || NULL_TOKEN;
    return (
      <Select
        value={current}
        onValueChange={(v) => onChange(v === NULL_TOKEN ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NULL_TOKEN}>— (null)</SelectItem>
          {field.options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (field.type === "date") {
    const dateValue =
      typeof stringValue === "string" && stringValue.includes("T")
        ? stringValue.slice(0, 10)
        : stringValue;
    return (
      <Input
        type="date"
        value={dateValue}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    );
  }

  return (
    <Input
      type={field.type === "number" ? "number" : "text"}
      value={stringValue}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder}
      disabled={disabled}
    />
  );
}

function PreviewBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/40 py-2 last:border-b-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="mt-0.5 break-words">{children}</div>
    </div>
  );
}

function DebugSection({ title, data }: { title: string; data: unknown }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 font-medium text-foreground">{title}</div>
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-[10px] leading-tight">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
