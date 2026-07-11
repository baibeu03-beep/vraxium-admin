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
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
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

// 강화 시 포인트(Point.A/B) — 0~20 정수 + 미설정(""). Point.C 는 라인에 두지 않는다.
const POINT_SELECT_OPTIONS: string[] = ["", ...Array.from({ length: 21 }, (_, i) => String(i))];

// 실무 정보 포인트 대상 활동유형 — config_key = activity_types.id(표시명/순서로 조인하지 않음).
const INFO_ACTIVITY_TYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "wisdom", label: "위즈덤" },
  { id: "essay", label: "에세이" },
  { id: "infodesk", label: "인포데스크" },
  { id: "calendar", label: "캘린더" },
  { id: "forum", label: "포럼" },
  { id: "session", label: "세션" },
  { id: "practical_lecture", label: "아카데미" },
  { id: "community", label: "커뮤니티" },
  { id: "etc_a", label: "기타A" },
];

// ──────────────────────────────────────────────────────────────
// 필드 라벨 — 라벨 텍스트 + 요소별 편집형 돋보기 도움말(AdminHelpIconButton).
//   · 도움말 아이콘은 "라벨 영역에만" 배치 → 아래 입력/Select 폭에 영향 없음.
//   · helpKey 는 요소마다 고유. 본문은 코드에 하드코딩하지 않고 /api/admin/help 저장소가 SoT.
// ──────────────────────────────────────────────────────────────

function FieldLabel({
  label,
  helpKey,
  required,
  muted,
}: {
  label: string;
  helpKey: string;
  required?: boolean;
  // 실무 경력 카드처럼 작은 보조 라벨(text-xs text-muted-foreground)로 표시할 때.
  muted?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <Label
        className={cn(
          "whitespace-nowrap",
          muted ? "text-xs text-muted-foreground" : "text-sm text-foreground",
        )}
      >
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </Label>
      <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 폼 그룹 — 라벨(+도움말)을 위에, 입력을 아래 전체 폭으로 두는 세로 그룹.
//   · 라벨↔입력 내부 간격(gap-1.5)은 좁게 유지, 그룹 사이 간격은 부모 grid gap 이 담당.
//   · min-w-0 로 좁은 화면에서도 그룹 단위로 자연스럽게 줄바꿈.
// ──────────────────────────────────────────────────────────────

function FormRow({
  label,
  helpKey,
  required,
  children,
}: {
  label: string;
  helpKey: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <FieldLabel label={label} helpKey={helpKey} required={required} />
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

  // 표시 UI = 실무 정보 개설 폼(PracticalInfoOpeningForm)의 사각형 미리보기와 동일한 스타일.
  //   (w-40 aspect-square 점선 박스 + "미리보기" placeholder, 업로드 시 이미지 채움)
  //   업로드/삭제는 우측 상단 아이콘 버튼. 업로드 기능(API)·onChange/onRemove 동작은 무변경.
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
      <div className="relative w-40">
        {value ? (
          <div className="aspect-square w-40 overflow-hidden rounded-md border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt="기업 로고" className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className="flex aspect-square w-40 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
            {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : "미리보기"}
          </div>
        )}
        {/* 우측 상단: 업로드 / 삭제 (이미지가 있을 때만 삭제 노출) */}
        <div className="absolute right-1 top-1 flex flex-col gap-1">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            className="shadow"
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
            title={value ? "로고 교체" : "로고 업로드"}
            aria-label={value ? "로고 교체" : "로고 업로드"}
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
          {value && (
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="shadow"
              disabled={disabled || uploading}
              onClick={onRemove}
              title="로고 삭제"
              aria-label="로고 삭제"
            >
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </Button>
          )}
        </div>
      </div>
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

  // ── 강화 시 포인트 (라인과 함께 저장 → cluster4_line_point_configs) ──
  const [pointA, setPointA] = useState(""); // "" = 미설정
  const [pointB, setPointB] = useState("");
  // 실무 정보 포인트 대상 활동유형(config_key). info 일 때만 사용.
  const [infoActivityTypeId, setInfoActivityTypeId] = useState("");

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
    setPointA("");
    setPointB("");
    setInfoActivityTypeId("");
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
        // 강화 시 포인트 — 미설정("")은 null. 서버가 config_key 도출 후 함께 저장(설정값만).
        point_a: pointA === "" ? null : Number(pointA),
        point_b: pointB === "" ? null : Number(pointB),
      };
      // 실무 정보 포인트는 활동유형(activity_types.id) 기준 — 서버가 config_key 로 사용.
      if (hub === "info") payload.point_activity_type_id = infoActivityTypeId || null;
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
      const pc = json.pointConfig as { saved: boolean; reason?: string } | undefined;
      // 포인트 입력 여부는 리셋 전에 판단(handleReset 이 상태를 비움).
      const enteredPoints = pointA !== "" || pointB !== "";
      let pointSuffix = "";
      if (enteredPoints) {
        pointSuffix = pc?.saved
          ? " · 강화 포인트 저장됨"
          : ` · ⚠ 강화 포인트 미저장${pc?.reason ? ` (${pc.reason})` : ""}`;
      }
      // handleReset 이 banner 를 지우므로 리셋 후에 성공 안내를 띄운다.
      handleReset();
      setBanner({
        kind: enteredPoints && !pc?.saved ? "error" : "success",
        message: `라인이 등록되었습니다 (${saved.hubLabel} · ${saved.lineName} · ${saved.lineCode})${pointSuffix} — 목록은 라인 정보 페이지에서 확인하세요.`,
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
    pointA, pointB, infoActivityTypeId,
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
            <FormRow label="라인명" helpKey="admin.lines.register.lineName" required>
              <Input
                value={lineName}
                onChange={(e) => setLineName(e.target.value)}
                placeholder="예) 마케팅 전략 라인"
              />
            </FormRow>

            {/* 2행: 소속 허브 | 라인 종류 | 소속 조직 */}
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-3">
              <FormRow label="소속 허브" helpKey="admin.lines.register.hub" required>
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
              <FormRow label="라인 종류" helpKey="admin.lines.register.lineType" required>
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
              <FormRow label="소속 조직" helpKey="admin.lines.register.organization">
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
              <FormRow label="라인 코드" helpKey="admin.lines.register.lineCode" required>
                <Input
                  value={lineCode}
                  onChange={(e) => setLineCode(e.target.value)}
                  placeholder="예) WCBS-NL0001"
                />
              </FormRow>
              <FormRow label="유닛 링크" helpKey="admin.lines.register.unitLink">
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
            <FormRow
              label="메인 타이틀"
              helpKey="admin.lines.register.mainTitle"
              required={mainTitleMode === "fixed"}
            >
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

          {/* ── 강화 시 포인트 (Point.A / Point.B) — 라인과 함께 저장(cluster4_line_point_configs) ── */}
          <div className="space-y-4" data-point-fields>
            <div className="inline-flex items-center gap-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                강화 시 포인트
              </h3>
              <AdminHelpIconButton helpKey="admin.lines.register.pointSection" title="강화 시 포인트" size="xs" />
            </div>
            {/* 실무 정보는 활동유형(activity_types.id)을 config_key 로 사용 — 표시명/순서 조인 금지. */}
            {hub === "info" && (
              <FormRow label="포인트 대상 활동유형" helpKey="admin.lines.register.pointActivityType">
                <select
                  aria-label="포인트 대상 활동유형"
                  data-point-activity-type
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={infoActivityTypeId}
                  onChange={(e) => setInfoActivityTypeId(e.target.value)}
                >
                  <option value="">-</option>
                  {INFO_ACTIVITY_TYPES.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} ({a.id})
                    </option>
                  ))}
                </select>
              </FormRow>
            )}
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <FormRow label="Point.A" helpKey="admin.lines.register.pointA">
                <select
                  aria-label="Point.A"
                  data-point-a
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  value={pointA}
                  onChange={(e) => setPointA(e.target.value)}
                  disabled={hub === HUB_UNSELECTED || isCareer}
                >
                  {POINT_SELECT_OPTIONS.map((v) => (
                    <option key={v} value={v}>{v === "" ? "-" : v}</option>
                  ))}
                </select>
              </FormRow>
              <FormRow label="Point.B" helpKey="admin.lines.register.pointB">
                <select
                  aria-label="Point.B"
                  data-point-b
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  value={pointB}
                  onChange={(e) => setPointB(e.target.value)}
                  disabled={hub === HUB_UNSELECTED || isCareer}
                >
                  {POINT_SELECT_OPTIONS.map((v) => (
                    <option key={v} value={v}>{v === "" ? "-" : v}</option>
                  ))}
                </select>
              </FormRow>
            </div>
            {isCareer && (
              <p className="text-xs text-muted-foreground">실무 경력은 강화 포인트 설정 대상이 아닙니다.</p>
            )}
          </div>

          {/* ── 실무 경력 전용 카드 (3열) ── */}
          <section
            className={cn("space-y-4 rounded-lg border bg-muted/20 p-4", !isCareer && "opacity-60")}
            aria-disabled={!isCareer}
          >
            <div className="flex items-center justify-between">
              <div className="inline-flex items-center gap-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  실무 경력 전용 입력
                </h3>
                <AdminHelpIconButton
                  helpKey="admin.lines.register.careerSection"
                  title="실무 경력 전용 입력"
                  size="xs"
                />
              </div>
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
                  <FieldLabel
                    label="제휴/연계사"
                    helpKey="admin.lines.register.partnerCompany"
                    muted
                  />
                  <Input
                    value={partnerCompany}
                    onChange={(e) => setPartnerCompany(e.target.value)}
                    placeholder="예) 브랙시움"
                    disabled={!isCareer || saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel
                    label="기업 로고"
                    helpKey="admin.lines.register.companyLogo"
                    muted
                  />
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
                  <FieldLabel
                    label="담당자명"
                    helpKey="admin.lines.register.managerName"
                    muted
                  />
                  <Input
                    value={managerName}
                    onChange={(e) => setManagerName(e.target.value)}
                    placeholder="예) 김담당"
                    disabled={!isCareer || saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel
                    label="직급"
                    helpKey="admin.lines.register.managerPosition"
                    muted
                  />
                  <Input
                    value={managerPosition}
                    onChange={(e) => setManagerPosition(e.target.value)}
                    placeholder="예) 팀장"
                    disabled={!isCareer || saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel
                    label="직무"
                    helpKey="admin.lines.register.managerJob"
                    muted
                  />
                  <Input
                    value={managerJob}
                    onChange={(e) => setManagerJob(e.target.value)}
                    placeholder="예) 마케팅"
                    disabled={!isCareer || saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel
                    label="프로필 사진"
                    helpKey="admin.lines.register.managerProfile"
                    muted
                  />
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

          {/* ── 버튼 (우측 하단: 등록 · 초기화) — 도움말 아이콘은 버튼 외부에 배치 ── */}
          <div className="flex items-center justify-end gap-4 border-t pt-4">
            <div className="inline-flex items-center gap-1.5">
              <Button type="button" loading={saving} onClick={() => void handleSubmit()}>
                등록
              </Button>
              <AdminHelpIconButton
                helpKey="admin.lines.register.submit"
                title="등록"
                size="sm"
              />
            </div>
            <div className="inline-flex items-center gap-1.5">
              <Button type="button" variant="outline" onClick={handleReset} disabled={saving}>
                초기화
              </Button>
              <AdminHelpIconButton
                helpKey="admin.lines.register.reset"
                title="초기화"
                size="sm"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
