"use client";

// /admin/lines/register — 라인 등록 (additive Phase).
//
// 신규 등록 라인만 line_registrations 에 저장한다 (POST /api/admin/lines/registrations).
// 기존 4허브 SoT(cluster4_lines · 마스터 · career_projects), 개설 기능, 고객 화면,
// snapshot, demoUserId/일반 사용자 경로는 일절 수정하지 않는다.
//
// 레이아웃 (2026-06-07 개정):
//   - 1행 라인명(전체 폭) / 2행 소속 허브·라인 종류(1:1) / 3행 라인 코드·유닛 링크(1:1)
//     / 4행 메인 타이틀(전체 폭, 고정·변동) — 유닛 링크는 단일 텍스트(형식 강제 없음, 미입력 시 '-')
//   - 실무 경력 전용 카드(3열): 좌(제휴/연계사·기업 로고) / 중(담당자명·직급·직무·프로필) /
//                우(원형 프로필 미리보기 placeholder)
//   - 버튼 우측 하단: [등록] [초기화]
//   - 하단 "등록된 라인" 목록은 /admin/lines/info 로 이동 (2026-06-07) — 이 화면은 등록 폼만.

import { useCallback, useRef, useState } from "react";
import { Loader2, Trash2, Upload, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  LINE_REGISTRATION_HUBS,
  LINE_REGISTRATION_HUB_LABEL,
  LINE_REGISTRATION_LINE_TYPES,
  LINE_REGISTRATION_ORGS,
  LINE_REGISTRATION_ORG_LABEL,
  LINE_REGISTRATION_PROFILE_KEYS,
  lineRegistrationProfileImage,
  VARIABLE_MAIN_TITLE_NOTICE,
  type LineRegistrationDto,
  type LineRegistrationHub,
  type LineRegistrationMainTitleMode,
} from "@/lib/adminLineRegistrationsTypes";

type Banner = { kind: "success" | "error"; message: string } | null;

// 허브 미선택 sentinel — DB 저장값 아님 (등록 시 검증으로 차단).
const HUB_UNSELECTED = "-" as const;
type HubSelection = LineRegistrationHub | typeof HUB_UNSELECTED;

function lineTypeOptions(hub: HubSelection): readonly string[] {
  if (hub === HUB_UNSELECTED) return ["-"];
  return LINE_REGISTRATION_LINE_TYPES[hub];
}

// ──────────────────────────────────────────────────────────────
// 폼 행 — 라벨(좌, 고정폭) + 입력(우). 라벨 세로 정렬 + 간격 통일용 공통 래퍼.
// ──────────────────────────────────────────────────────────────

function FormRow({
  label,
  required,
  children,
  alignTop,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[92px_minmax(0,1fr)] gap-3",
        alignTop ? "items-start" : "items-center",
      )}
    >
      <Label className={cn("text-sm text-foreground", alignTop && "pt-2")}>
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 기업 로고 업로드 — 기존 공용 /api/admin/cluster4/upload-image 재사용 (API 수정 없음).
// ──────────────────────────────────────────────────────────────

function LogoUploadField({
  value,
  onChange,
  onRemove,
  disabled,
}: {
  value: string;
  onChange: (url: string) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/admin/cluster4/upload-image", {
          method: "POST",
          body: formData,
        });
        const json = await res.json();
        if (!json.success) {
          alert(json.error || "업로드에 실패했습니다");
          return;
        }
        onChange(json.data.url);
      } catch {
        alert("업로드 중 오류가 발생했습니다");
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [onChange],
  );

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled || uploading}
      />
      {value ? (
        <div className="flex items-center gap-2 rounded-md border p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="기업 로고" className="h-10 w-10 shrink-0 rounded object-cover" />
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{value}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
          >
            교체
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            disabled={disabled || uploading}
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={disabled || uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Upload className="mr-2 h-4 w-4" />
          )}
          {uploading ? "업로드 중..." : "로고 이미지 업로드"}
        </Button>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

export default function LineRegistrationManager() {
  const [banner, setBanner] = useState<Banner>(null);
  const [saving, setSaving] = useState(false);

  // ── 기본 정보 ──
  const [lineName, setLineName] = useState("");
  const [hub, setHub] = useState<HubSelection>(HUB_UNSELECTED);
  const [lineType, setLineType] = useState("-");
  const [lineCode, setLineCode] = useState("");
  // 소속 조직 — "" = 미지정('-'). 미지정 등록은 허용되나 개설 브리지는 불가 (Phase 2C).
  const [orgSlug, setOrgSlug] = useState("");

  // ── 메인 타이틀 (고정/변동) ──
  const [mainTitleMode, setMainTitleMode] =
    useState<LineRegistrationMainTitleMode>("fixed");
  const [mainTitle, setMainTitle] = useState("");

  // ── 유닛 링크 (단일 텍스트 — 형식 강제 없음, 미입력 시 '-') ──
  const [unitLink, setUnitLink] = useState("");

  // ── 실무 경력 전용 ──
  const [partnerCompany, setPartnerCompany] = useState("");
  const [companyLogo, setCompanyLogo] = useState("");
  const [managerName, setManagerName] = useState("");
  const [managerPosition, setManagerPosition] = useState("");
  const [managerJob, setManagerJob] = useState("");
  const [managerProfileKey, setManagerProfileKey] = useState("");

  const isCareer = hub === "career";

  // 허브 변경 → 라인 종류를 그 허브의 첫 옵션으로 리셋. 비career 전환 시 경력 전용 카드는
  // 비활성화(서버에서도 null 강제 — 이중 안전망으로 전송 자체를 생략).
  const handleHubChange = useCallback((next: HubSelection) => {
    setHub(next);
    setLineType(lineTypeOptions(next)[0]);
  }, []);

  // 초기화 — 모든 입력값을 기본 상태로 (DB 저장 없음).
  const handleReset = useCallback(() => {
    setLineName("");
    setHub(HUB_UNSELECTED);
    setLineType("-");
    setLineCode("");
    setOrgSlug("");
    setMainTitleMode("fixed");
    setMainTitle("");
    setUnitLink("");
    setPartnerCompany("");
    setCompanyLogo("");
    setManagerName("");
    setManagerPosition("");
    setManagerJob("");
    setManagerProfileKey("");
    setBanner(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!lineName.trim()) {
      setBanner({ kind: "error", message: "라인명을 입력해주세요" });
      return;
    }
    if (hub === HUB_UNSELECTED) {
      setBanner({ kind: "error", message: "소속 허브를 선택해주세요" });
      return;
    }
    if (lineType === "-" || !lineTypeOptions(hub).includes(lineType)) {
      setBanner({ kind: "error", message: "라인 종류를 선택해주세요" });
      return;
    }
    if (!lineCode.trim()) {
      setBanner({ kind: "error", message: "라인 코드를 입력해주세요" });
      return;
    }
    if (mainTitleMode === "fixed" && !mainTitle.trim()) {
      setBanner({ kind: "error", message: "메인 타이틀을 입력해주세요 (변동이면 '변동'을 선택)" });
      return;
    }

    setSaving(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = {
        line_name: lineName.trim(),
        hub,
        line_type: lineType,
        line_code: lineCode.trim(),
        main_title_mode: mainTitleMode,
        // 변동(variable)은 서버가 '-' 로 강제 저장 — main_title 은 fixed 일 때만 의미.
        main_title: mainTitleMode === "fixed" ? mainTitle.trim() : null,
        // 유닛 링크 — 단일 텍스트. 미입력/공백은 서버가 '-' 로 저장.
        unit_link: unitLink.trim() || null,
        // 소속 조직 — 미지정이면 null (개설 브리지 불가 상태로 저장).
        organization_slug: orgSlug || null,
      };
      if (hub === "career") {
        payload.partner_company = partnerCompany.trim() || null;
        payload.company_logo_url = companyLogo.trim() || null;
        payload.manager_name = managerName.trim() || null;
        payload.manager_position = managerPosition.trim() || null;
        payload.manager_job = managerJob.trim() || null;
        payload.manager_profile_key = managerProfileKey || null;
      }
      const res = await fetch("/api/admin/lines/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        const message =
          (json && typeof json.error === "string" && json.error) || `HTTP ${res.status}`;
        throw new Error(message);
      }
      const saved = json.data as LineRegistrationDto;
      // handleReset 이 banner 를 지우므로 리셋 후에 성공 안내를 띄운다.
      handleReset();
      setBanner({
        kind: "success",
        message: `라인이 등록되었습니다 (${saved.hubLabel} · ${saved.lineName} · ${saved.lineCode}) — 목록은 라인 정보 페이지에서 확인하세요.`,
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "저장에 실패했습니다",
      });
    } finally {
      setSaving(false);
    }
  }, [
    lineName, hub, lineType, lineCode, orgSlug, mainTitleMode, mainTitle, unitLink,
    partnerCompany, companyLogo, managerName, managerPosition, managerJob,
    managerProfileKey, handleReset,
  ]);

  return (
    // 폼이 너무 넓게 퍼지지 않도록 적정 너비로 제한하고, 다른 관리 페이지처럼
    // mx-auto 로 가운데 정렬한다 (좌우 여백은 (portal) layout 의 p-6 가 담당).
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      {banner && (
        <div
          className={cn(
            "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800",
          )}
        >
          <span>{banner.message}</span>
          <button type="button" onClick={() => setBanner(null)} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>라인 등록</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* ── 기본 정보 — 1행 라인명 / 2행 허브·종류 / 3행 코드·유닛 링크 / 4행 메인 타이틀 ── */}
          <div className="space-y-4">
            {/* 1행: 라인명 (전체 폭) */}
            <FormRow label="라인명" required>
              <Input
                value={lineName}
                onChange={(e) => setLineName(e.target.value)}
                placeholder="예) 마케팅 전략 라인"
              />
            </FormRow>

            {/* 2행: 소속 허브 | 라인 종류 | 소속 조직 */}
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-3">
              <FormRow label="소속 허브" required>
                <select
                  aria-label="소속 허브"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={hub}
                  onChange={(e) => handleHubChange(e.target.value as HubSelection)}
                >
                  <option value={HUB_UNSELECTED}>-</option>
                  {LINE_REGISTRATION_HUBS.map((h) => (
                    <option key={h} value={h}>
                      {LINE_REGISTRATION_HUB_LABEL[h]}
                    </option>
                  ))}
                </select>
              </FormRow>
              <FormRow label="라인 종류" required>
                <select
                  aria-label="라인 종류"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  value={lineType}
                  onChange={(e) => setLineType(e.target.value)}
                  disabled={hub === HUB_UNSELECTED}
                >
                  {hub === HUB_UNSELECTED ? (
                    <option value="-">-</option>
                  ) : (
                    lineTypeOptions(hub).map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))
                  )}
                </select>
              </FormRow>
              <FormRow label="소속 조직">
                {/* Phase 2C: 미지정('-')도 등록 가능하나 개설 브리지는 조직 지정 행만 가능. */}
                <select
                  aria-label="소속 조직"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={orgSlug}
                  onChange={(e) => setOrgSlug(e.target.value)}
                >
                  <option value="">-</option>
                  {LINE_REGISTRATION_ORGS.map((o) => (
                    <option key={o} value={o}>
                      {LINE_REGISTRATION_ORG_LABEL[o]}
                    </option>
                  ))}
                </select>
              </FormRow>
            </div>

            {/* 3행: 라인 코드 | 유닛 링크 (1:1) */}
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2">
              {/* 유닛 링크 셀(안내 문구 포함)과 입력창 상단 정렬을 맞추기 위해 alignTop */}
              <FormRow label="라인 코드" required alignTop>
                <Input
                  value={lineCode}
                  onChange={(e) => setLineCode(e.target.value)}
                  placeholder="예) WCBS-NL0001"
                />
              </FormRow>
              <FormRow label="유닛 링크" alignTop>
                <div className="space-y-1.5">
                  <Input
                    value={unitLink}
                    onChange={(e) => setUnitLink(e.target.value)}
                    placeholder="유닛 링크를 입력하세요"
                    aria-label="유닛 링크"
                  />
                  <p className="text-xs text-muted-foreground">
                    형식 제한 없음 · 미입력 시 &quot;-&quot; 로 저장됩니다
                  </p>
                </div>
              </FormRow>
            </div>

            {/* 4행: 메인 타이틀 (전체 폭) */}
            <FormRow label="메인 타이틀" required={mainTitleMode === "fixed"} alignTop>
              <div className="space-y-2">
                <Input
                  value={mainTitle}
                  onChange={(e) => setMainTitle(e.target.value)}
                  placeholder="메인 타이틀을 입력하세요"
                  disabled={mainTitleMode === "variable"}
                />
                <div className="flex items-center gap-4 text-sm">
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="mainTitleMode"
                      checked={mainTitleMode === "fixed"}
                      onChange={() => setMainTitleMode("fixed")}
                    />
                    고정
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="mainTitleMode"
                      checked={mainTitleMode === "variable"}
                      onChange={() => setMainTitleMode("variable")}
                    />
                    변동
                  </label>
                </div>
                {mainTitleMode === "variable" && (
                  <p className="text-xs text-muted-foreground">
                    {VARIABLE_MAIN_TITLE_NOTICE}
                  </p>
                )}
              </div>
            </FormRow>
          </div>

          {/* ── 실무 경력 전용 카드 (3열) ── */}
          <section
            className={cn("space-y-4 rounded-lg border bg-muted/20 p-4", !isCareer && "opacity-60")}
            aria-disabled={!isCareer}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                실무 경력 전용 입력
              </h3>
              {!isCareer && (
                <span className="text-xs text-muted-foreground">
                  소속 허브가 &quot;실무 경력&quot;일 때만 활성화됩니다
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              {/* 좌측 열: 제휴/연계사 + 기업 로고 */}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">제휴/연계사</Label>
                  <Input
                    value={partnerCompany}
                    onChange={(e) => setPartnerCompany(e.target.value)}
                    placeholder="예) 브랙시움"
                    disabled={!isCareer || saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">기업 로고</Label>
                  <LogoUploadField
                    value={companyLogo}
                    onChange={setCompanyLogo}
                    onRemove={() => setCompanyLogo("")}
                    disabled={!isCareer || saving}
                  />
                </div>
              </div>

              {/* 중앙 열: 담당자명 / 직급 / 직무 / 프로필 사진 */}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">담당자명</Label>
                  <Input
                    value={managerName}
                    onChange={(e) => setManagerName(e.target.value)}
                    placeholder="예) 김담당"
                    disabled={!isCareer || saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">직급</Label>
                  <Input
                    value={managerPosition}
                    onChange={(e) => setManagerPosition(e.target.value)}
                    placeholder="예) 팀장"
                    disabled={!isCareer || saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">직무</Label>
                  <Input
                    value={managerJob}
                    onChange={(e) => setManagerJob(e.target.value)}
                    placeholder="예) 마케팅"
                    disabled={!isCareer || saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">프로필 사진</Label>
                  <select
                    aria-label="프로필 사진"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                    value={managerProfileKey}
                    onChange={(e) => setManagerProfileKey(e.target.value)}
                    disabled={!isCareer || saving}
                  >
                    <option value="">-</option>
                    {LINE_REGISTRATION_PROFILE_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 우측 열: 원형 프로필 미리보기 — 선택 시 매핑 이미지, 미선택 시 placeholder 원 */}
              <div className="flex flex-col items-center justify-start gap-2 md:px-4 md:pt-5">
                {(() => {
                  const preview = isCareer
                    ? lineRegistrationProfileImage(managerProfileKey || null)
                    : null;
                  return preview ? (
                    <div
                      data-testid="profile-preview-circle"
                      className="h-24 w-24 shrink-0 overflow-hidden rounded-full border border-primary/40"
                      title={managerProfileKey}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={preview.src}
                        alt={managerProfileKey}
                        className="h-full w-full object-cover"
                        style={{
                          objectPosition: preview.objectPosition,
                          transform: `scale(${preview.zoom})`,
                          transformOrigin: preview.zoomOrigin,
                        }}
                      />
                    </div>
                  ) : (
                    <div
                      data-testid="profile-placeholder-circle"
                      className="h-24 w-24 shrink-0 rounded-full border border-dashed border-border bg-muted/30"
                      title="프로필 미선택"
                    />
                  );
                })()}
                <span className="text-xs text-muted-foreground">
                  {isCareer && managerProfileKey ? managerProfileKey : "프로필 미리보기"}
                </span>
              </div>
            </div>
          </section>

          {/* ── 버튼 (우측 하단: 등록 · 초기화) ── */}
          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button type="button" onClick={() => void handleSubmit()} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              등록
            </Button>
            <Button type="button" variant="outline" onClick={handleReset} disabled={saving}>
              초기화
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
