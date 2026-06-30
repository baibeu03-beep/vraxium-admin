"use client";

// 4허브 공통 — 개설된 라인 검색·필터 + 와이드 테이블 + 대상자 보기 + 상세/편집.
// competency / career / (필요 시 info·experience) 매니저에서 재사용한다.
// 데이터는 GET /api/admin/cluster4/lines?partType=&detailed=1 (append-only) 로 자체 조회.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, X, Search, ChevronDown, ChevronRight, Pencil, Upload, Trash2 } from "lucide-react";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatClubDate, formatClubDateTime } from "@/lib/clubDate";
import type {
  Cluster4LineDetail,
  Cluster4LinePartType,
} from "@/lib/adminCluster4LinesTypes";
import {
  buildOutputLinksFromForm,
  OUTPUT_LINK_LABEL_PLACEHOLDER,
  OUTPUT_LINK_URL_PLACEHOLDER,
} from "@/lib/cluster4OutputLinks";
import {
  EnhancementStatusBadge,
  SubmissionStatusBadge,
  ENHANCEMENT_FILTER_OPTIONS,
  matchesEnhancementFilter,
  type EnhancementFilter,
} from "@/components/admin/cluster4/enhancementBadges";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import { useReportLoading } from "@/components/admin/loadingBannerContext";

type StatusFilter = "all" | "active" | "inactive";

const EDIT_REASON_LABEL: Record<string, string> = {
  ok: "편집 가능",
  ok_override: "오버라이드",
  target_missing: "대상 없음",
  not_owner: "비대상",
  line_inactive: "라인 비활성",
  window_not_open: "기간 전",
  window_closed: "마감",
  unsupported_target_mode: "rule 대상",
};

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${DAY_NAMES[d.getDay()]})`;
}

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// 기업 로고 / 감독자 사진 공용 업로드 필드 — URL input 이 아니라 업로드 후 반환 URL 만 저장.
// /api/admin/cluster4/upload-image (라인 등록 화면과 동일 엔드포인트) 사용.
function MetaImageUploadField({
  label,
  value,
  onChange,
  onRemove,
  disabled,
  rounded = "rounded",
  emptyButtonLabel = "이미지 업로드",
  altText = "이미지",
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  onRemove: () => void;
  disabled?: boolean;
  rounded?: "rounded" | "rounded-full";
  emptyButtonLabel?: string;
  altText?: string;
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
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
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
          <img src={value} alt={altText} className={cn("h-10 w-10 shrink-0 border object-cover", rounded)} />
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{value}</p>
          <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={disabled || uploading} onClick={() => fileRef.current?.click()}>
            교체
          </Button>
          <Button type="button" variant="ghost" size="icon" className="shrink-0" disabled={disabled || uploading} onClick={onRemove}>
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" className="w-full" loading={uploading} disabled={disabled || uploading} onClick={() => fileRef.current?.click()}>
          {!uploading && <Upload className="mr-2 h-4 w-4" />}
          {emptyButtonLabel}
        </Button>
      )}
    </div>
  );
}

function CanEditBadge({ canEdit, reason }: { canEdit: boolean; reason: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        canEdit ? "bg-green-100 text-green-800" : "bg-muted text-muted-foreground",
      )}
    >
      {EDIT_REASON_LABEL[reason] ?? reason}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────
// Detail / Edit modal
// ──────────────────────────────────────────────────────────────

function fmtDateTime(iso: string | null): string {
  return formatClubDateTime(iso);
}

// 라인 개설 역할별 진행 상태 + 담당자 기록 + 권장 시간 안내 (실무 경력 라인 전용).
// 운영 정책: 파트장(입력) → 에이전트(검수) → 팀장(개설). 안내 문구는 순수 텍스트이며
// 시간/순서/권한 차단은 없다 — 버튼은 마감 후에도 항상 동작하고 단계 순서도 강제하지 않는다.
const WORKFLOW_ROLES = [
  {
    key: "input" as const,
    role: "파트장",
    title: "입력",
    guide: "권장 입력 기한 : 월요일 14시",
    action: "input_complete" as const,
    buttonLabel: "입력 완료",
    doneLabel: "입력 완료",
    pendingLabel: "입력 중",
    actorLabel: "입력자",
  },
  {
    key: "review" as const,
    role: "에이전트",
    title: "검수",
    guide: "권장 검수 기한 : 월요일 20시",
    action: "review_complete" as const,
    buttonLabel: "검수 완료",
    doneLabel: "검수 완료",
    pendingLabel: "미검수",
    actorLabel: "검수자",
  },
  {
    key: "open" as const,
    role: "팀장",
    title: "개설",
    guide: "권장 개설 기한 : 월요일 22시",
    action: "open" as const,
    buttonLabel: "개설",
    doneLabel: "개설 완료",
    pendingLabel: "미개설",
    actorLabel: "개설자",
  },
];

function LineWorkflowSection({
  line,
  onRefresh,
}: {
  line: Cluster4LineDetail;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stageState = {
    input: { done: Boolean(line.inputCompletedAt), at: line.inputCompletedAt, actor: line.createdByName },
    review: { done: Boolean(line.reviewedAt), at: line.reviewedAt, actor: line.reviewedByName },
    open: { done: Boolean(line.openedAt), at: line.openedAt, actor: line.openedByName },
  };

  const handleAction = useCallback(
    async (action: "input_complete" | "review_complete" | "open") => {
      setBusy(action);
      setError(null);
      try {
        const res = await fetch(`/api/admin/cluster4/lines/${line.id}/workflow`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const json = await res.json();
        if (!json.success) {
          setError(json.error ?? "처리에 실패했습니다");
          return;
        }
        // 목록 재조회 → detailId 유지로 모달의 line prop 이 최신 상태/담당자로 갱신된다.
        onRefresh();
      } catch {
        setError("처리 중 오류가 발생했습니다");
      } finally {
        setBusy(null);
      }
    },
    [line.id, onRefresh],
  );

  return (
    <section className="space-y-3 rounded-md border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">라인 개설 진행 상태</h3>
        <p className="text-xs text-muted-foreground">
          입력자 : {stageState.input.actor ?? "-"}
          {"  ·  "}검수자 : {stageState.review.actor ?? "-"}
          {"  ·  "}개설자 : {stageState.open.actor ?? "-"}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {WORKFLOW_ROLES.map((cfg) => {
          const st = stageState[cfg.key];
          return (
            <div key={cfg.key} className="space-y-2 rounded-md border bg-background p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">
                  {cfg.role} · {cfg.title}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                    st.done
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {st.done ? cfg.doneLabel : cfg.pendingLabel}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">{cfg.guide}</p>
              <p className="text-[11px] text-muted-foreground">
                {cfg.actorLabel} : {st.actor ?? "-"}
                {st.at ? ` · ${fmtDateTime(st.at)}` : ""}
              </p>
              <Button
                size="sm"
                variant={st.done ? "outline" : "default"}
                className="w-full"
                loading={busy === cfg.action}
                disabled={busy !== null}
                onClick={() => handleAction(cfg.action)}
              >
                {st.done ? `${cfg.doneLabel} (다시 처리)` : cfg.buttonLabel}
              </Button>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        ※ 안내 문구는 권장 기한일 뿐 시간/순서/권한 제한은 없습니다. 마감 후에도 모든 단계 처리가 가능하며, 입력자와 검수자가 같아도 됩니다.
      </p>
    </section>
  );
}

function LineDetailModal({
  line,
  nameColumnLabel,
  editable,
  onClose,
  onSaved,
  onRefresh,
}: {
  line: Cluster4LineDetail;
  nameColumnLabel: string;
  editable: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  onRefresh: () => void;
}) {
  const devMode = useAdminDevMode();
  const [mainTitle, setMainTitle] = useState(line.mainTitle);
  // output_links 우선 prefill (DTO 가 이미 jsonb→legacy fallback 해석). 슬롯 순서 보존.
  const [outputLink1, setOutputLink1] = useState(line.outputLinks[0]?.url ?? line.outputLink1 ?? "");
  const [outputLabel1, setOutputLabel1] = useState(line.outputLinks[0]?.label ?? "");
  const [outputLink2, setOutputLink2] = useState(line.outputLinks[1]?.url ?? line.outputLink2 ?? "");
  const [outputLabel2, setOutputLabel2] = useState(line.outputLinks[1]?.label ?? "");
  const [opensAt, setOpensAt] = useState(isoToLocalInput(line.submissionOpensAt));
  const [closesAt, setClosesAt] = useState(isoToLocalInput(line.submissionClosesAt));
  const [isActive, setIsActive] = useState(line.isActive);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // career 라인 sponsor-card 메타 — 편집 가능. source = career_projects (company_name 기준).
  // careerProjectId 가 있을 때만 편집 UI 노출 / 저장 시 함께 PATCH.
  const isCareerLine = Boolean(line.careerProjectId);
  const [companyName, setCompanyName] = useState(line.companyName ?? "");
  const [companyLogoUrl, setCompanyLogoUrl] = useState(line.companyLogoUrl ?? "");
  const [supervisorName, setSupervisorName] = useState(line.supervisorName ?? "");
  const [supervisorDepartment, setSupervisorDepartment] = useState(line.supervisorDepartment ?? "");
  const [supervisorPosition, setSupervisorPosition] = useState(line.supervisorPosition ?? "");
  const [supervisorPhotoUrl, setSupervisorPhotoUrl] = useState(line.supervisorPhotoUrl ?? "");

  const handleSave = useCallback(async () => {
    if (!mainTitle.trim()) {
      setError("메인 타이틀을 입력해주세요");
      return;
    }
    const built = buildOutputLinksFromForm([
      { url: outputLink1, label: outputLabel1 },
      { url: outputLink2, label: outputLabel2 },
    ]);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const outputLinks = built.value;
    const opensIso = localInputToIso(opensAt);
    const closesIso = localInputToIso(closesAt);
    if (!opensIso || !closesIso) {
      setError("기입 기간을 올바르게 입력해주세요");
      return;
    }
    if (new Date(opensIso).getTime() > new Date(closesIso).getTime()) {
      setError("기입 시작은 마감보다 이후일 수 없습니다");
      return;
    }
    if (isCareerLine && !companyName.trim()) {
      setError("기업명을 입력해주세요");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/cluster4/lines/${line.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          main_title: mainTitle.trim(),
          // output_links 우선 저장 + 레거시 컬럼 backward-compat mirror.
          output_links: outputLinks,
          output_link_1: outputLinks[0]?.url ?? null,
          output_link_2: outputLinks[1]?.url ?? null,
          submission_opens_at: opensIso,
          submission_closes_at: closesIso,
          is_active: isActive,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error ?? "저장에 실패했습니다");
        return;
      }

      // career 라인이면 연결된 career_project 의 sponsor-card 6필드도 함께 PATCH.
      // 성공 시 서버가 해당 프로젝트를 보는 대상자 snapshot 을 stale 처리한다.
      if (isCareerLine && line.careerProjectId) {
        const metaRes = await fetch(
          `/api/admin/career-projects/${line.careerProjectId}/sponsor-meta`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              company_name: companyName.trim() || null,
              // 로고/사진은 업로드 후 반환 URL 만 저장 (URL input 아님).
              company_logo_url: companyLogoUrl.trim() || null,
              supervisor_name: supervisorName.trim() || null,
              supervisor_department: supervisorDepartment.trim() || null,
              supervisor_position: supervisorPosition.trim() || null,
              supervisor_profile_img: supervisorPhotoUrl.trim() || null,
            }),
          },
        );
        const metaJson = await metaRes.json();
        if (!metaJson.success) {
          setError(metaJson.error ?? "기업/감독자 정보 저장에 실패했습니다");
          return;
        }
      }

      onSaved(
        isCareerLine
          ? "라인 정보 및 기업/감독자 정보가 수정되었습니다"
          : "라인 정보가 수정되었습니다",
      );
    } catch {
      setError("저장 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
    }
  }, [
    line.id,
    line.careerProjectId,
    isCareerLine,
    mainTitle,
    outputLink1,
    outputLabel1,
    outputLink2,
    outputLabel2,
    opensAt,
    closesAt,
    isActive,
    companyName,
    companyLogoUrl,
    supervisorName,
    supervisorDepartment,
    supervisorPosition,
    supervisorPhotoUrl,
    onSaved,
  ]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-8"
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl space-y-6 overflow-y-auto rounded-xl bg-background p-6 shadow-xl ring-1 ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {nameColumnLabel} · {line.weekLabel ?? "주차 미상"}
              {line.lineCode ? ` · ${line.lineCode}` : ""}
            </p>
            <h2 className="truncate text-lg font-bold">{line.mainTitle}</h2>
            {devMode && (
              <p className="font-mono text-xs text-muted-foreground">lineId: {line.id}</p>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        {/* 라인 개설 역할별 진행 상태 + 담당자 기록 + 권장 시간 안내 (실무 경력 라인 전용). */}
        {isCareerLine && <LineWorkflowSection line={line} onRefresh={onRefresh} />}

        {/* career 라인 sponsor-card 메타. source = career_projects (company_name 기준).
            careerProjectId 가 있는 라인(=career part 연결)에서만 노출.
            editable 이면 input/upload 로 직접 수정 가능 — 저장 시 career_projects PATCH. */}
        {isCareerLine && (
          <section className="space-y-3 rounded-md border bg-muted/30 p-4">
            <h3 className="text-sm font-semibold">
              기업 · 감독자 정보 {editable ? "(편집)" : "(읽기 전용)"}
            </h3>
            {editable ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="cm-company" className="text-xs text-muted-foreground">
                      기업명 <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="cm-company"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="기업명"
                    />
                  </div>
                  <MetaImageUploadField
                    label="기업 로고"
                    value={companyLogoUrl}
                    onChange={setCompanyLogoUrl}
                    onRemove={() => setCompanyLogoUrl("")}
                    disabled={saving}
                    emptyButtonLabel="로고 이미지 업로드"
                    altText="기업 로고"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="cm-sup-name" className="text-xs text-muted-foreground">감독자명</Label>
                    <Input id="cm-sup-name" value={supervisorName} onChange={(e) => setSupervisorName(e.target.value)} placeholder="김담당" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cm-sup-dept" className="text-xs text-muted-foreground">감독자 부서</Label>
                    <Input id="cm-sup-dept" value={supervisorDepartment} onChange={(e) => setSupervisorDepartment(e.target.value)} placeholder="마케팅팀" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cm-sup-pos" className="text-xs text-muted-foreground">감독자 직책</Label>
                    <Input id="cm-sup-pos" value={supervisorPosition} onChange={(e) => setSupervisorPosition(e.target.value)} placeholder="팀장" />
                  </div>
                </div>
                <div className="sm:max-w-sm">
                  <MetaImageUploadField
                    label="감독자 사진"
                    value={supervisorPhotoUrl}
                    onChange={setSupervisorPhotoUrl}
                    onRemove={() => setSupervisorPhotoUrl("")}
                    disabled={saving}
                    rounded="rounded-full"
                    emptyButtonLabel="감독자 사진 업로드"
                    altText="감독자 사진"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  기업/감독자 정보는 연결된 경력 프로젝트에 저장됩니다. 저장 시 대상자의 주차 카드가 갱신됩니다.
                </p>
              </>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">기업</Label>
                  <div className="flex items-center gap-2">
                    {companyLogoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={companyLogoUrl} alt="기업 로고" className="h-8 w-8 shrink-0 rounded border object-cover" />
                    ) : null}
                    <span className="text-sm font-medium">{companyName || "기업명 미등록"}</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">감독자</Label>
                  <div className="flex items-center gap-2">
                    {supervisorPhotoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={supervisorPhotoUrl} alt="감독자 사진" className="h-8 w-8 shrink-0 rounded-full border object-cover" />
                    ) : null}
                    <span className="text-sm">
                      <span className="font-medium">{supervisorName || "-"}</span>
                      {(supervisorDepartment || supervisorPosition) && (
                        <span className="text-muted-foreground">
                          {" · "}
                          {[supervisorDepartment, supervisorPosition].filter(Boolean).join(" ")}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="space-y-4">
          <h3 className="text-sm font-semibold">
            라인 기본 정보 {editable ? "(편집)" : "(읽기 전용)"}
          </h3>
          <div className="space-y-2">
            <Label htmlFor="d-title">메인 타이틀</Label>
            <Input
              id="d-title"
              value={mainTitle}
              onChange={(e) => setMainTitle(e.target.value)}
              disabled={!editable}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="d-link1" className="text-xs text-muted-foreground">
                  Output Link 1 URL
                </Label>
                <Input
                  id="d-link1"
                  value={outputLink1}
                  onChange={(e) => setOutputLink1(e.target.value)}
                  placeholder={OUTPUT_LINK_URL_PLACEHOLDER}
                  disabled={!editable}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-label1" className="text-xs text-muted-foreground">
                  Link 1 설명
                </Label>
                <Input
                  id="d-label1"
                  value={outputLabel1}
                  onChange={(e) => setOutputLabel1(e.target.value)}
                  placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER}
                  disabled={!editable}
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="d-link2" className="text-xs text-muted-foreground">
                  Output Link 2 URL
                </Label>
                <Input
                  id="d-link2"
                  value={outputLink2}
                  onChange={(e) => setOutputLink2(e.target.value)}
                  placeholder={OUTPUT_LINK_URL_PLACEHOLDER}
                  disabled={!editable}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-label2" className="text-xs text-muted-foreground">
                  Link 2 설명
                </Label>
                <Input
                  id="d-label2"
                  value={outputLabel2}
                  onChange={(e) => setOutputLabel2(e.target.value)}
                  placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER}
                  disabled={!editable}
                />
              </div>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="d-opens" className="text-xs text-muted-foreground">
                기입 시작
              </Label>
              <Input
                id="d-opens"
                type="datetime-local"
                value={opensAt}
                onChange={(e) => setOpensAt(e.target.value)}
                disabled={!editable}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-closes" className="text-xs text-muted-foreground">
                기입 마감
              </Label>
              <Input
                id="d-closes"
                type="datetime-local"
                value={closesAt}
                onChange={(e) => setClosesAt(e.target.value)}
                disabled={!editable}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="rounded border-input"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={!editable}
            />
            활성 라인 (is_active)
          </label>

          {line.outputImages.length > 0 && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Output 이미지 (읽기 전용)
              </Label>
              <div className="flex flex-wrap gap-2">
                {line.outputImages.map((url) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={url}
                    src={url}
                    alt="output"
                    className="h-16 w-16 rounded border object-cover"
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              대상자 ({line.targets.length}명) · 기입 {line.submittedCount} / 미기입{" "}
              {line.pendingCount} · 편집가능 {line.canEditCount}
            </h3>
            <span className="text-xs text-muted-foreground">
              대상 추가/제거는 안전을 위해 읽기 전용입니다
            </span>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이름</TableHead>
                  <TableHead>조직</TableHead>
                  <TableHead className="text-center">강화 상태</TableHead>
                  <TableHead className="text-center">라인칸 기입 상태</TableHead>
                  <TableHead>{devMode ? "canEdit" : "수정 가능 여부"}</TableHead>
                  {devMode && <TableHead>lineTargetId / submissionId</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {line.targets.map((t) => (
                  <TableRow key={t.lineTargetId}>
                    <TableCell className="font-medium">{t.displayName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.organizationSlug ?? "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <EnhancementStatusBadge
                        status={t.enhancementStatus}
                        reason={t.enhancementReason}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <SubmissionStatusBadge status={t.submissionStatus} />
                      {t.submitted && t.submittedAt ? (
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          · {formatClubDate(t.submittedAt)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <CanEditBadge canEdit={t.canEdit} reason={t.editReason} />
                    </TableCell>
                    {devMode && (
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        <div className="truncate">{t.lineTargetId}</div>
                        <div className="truncate">{t.submissionId ?? "—"}</div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <div className="flex justify-end gap-3 border-t pt-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            닫기
          </Button>
          {editable && (
            <Button onClick={handleSave} loading={saving} disabled={saving}>
              라인 정보 저장
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Main table
// ──────────────────────────────────────────────────────────────

type OrgOption = { slug: string; name: string };

export default function Cluster4LineTable({
  partType,
  title,
  nameColumnLabel = "라인명",
  editable = true,
  refreshSignal = 0,
  weekId,
}: {
  partType: Cluster4LinePartType;
  title: string;
  nameColumnLabel?: string;
  editable?: boolean;
  refreshSignal?: number;
  // 부모(매니저)의 선택 주차. 지정되면 서버에서 해당 주차 라인만 조회하고
  // 내부 주차 드롭다운은 숨긴다. 미지정 시 전체 주차 + 내부 드롭다운 필터.
  weekId?: string;
}) {
  const [rows, setRows] = useState<Cluster4LineDetail[]>([]);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});

  // Filters
  const [orgFilter, setOrgFilter] = useState("");
  const [weekFilter, setWeekFilter] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [enhancementFilter, setEnhancementFilter] = useState<EnhancementFilter>("all");

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        partType,
        detailed: "1",
        limit: "500",
      });
      // 선택 주차가 지정되면 서버에서 해당 주차 라인만 조회한다.
      if (weekId) qs.set("weekId", weekId);
      // ⚠ QA 누수 차단: 라인 대상자(개설 대상 크루)도 mode 전달 필수 — 미전달=operating(실사용자 라인) 노출.
      const res = await fetch(
        appendModeQuery(
          `/api/admin/cluster4/lines?${qs.toString()}`,
          readScopeMode(new URLSearchParams(window.location.search)),
        ),
      );
      const json = await res.json();
      if (json.success) {
        setRows(json.data.rows ?? []);
      } else {
        setRows([]);
        setError(json.error ?? "라인 목록을 불러오지 못했습니다");
      }
    } catch (e) {
      console.error("[Cluster4LineTable] fetch failed", e);
      setError("라인 목록을 불러오지 못했습니다");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [partType, weekId]);

  useEffect(() => {
    void (async () => {
      await fetchRows();
    })();
  }, [fetchRows, refreshSignal]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/organizations");
        const json = await res.json();
        const list: OrgOption[] = json.organizations ?? [];
        const map: Record<string, string> = {};
        for (const o of list) map[o.slug] = o.name;
        setOrgNames(map);
      } catch {
        // org 이름 매핑 실패는 무시 (slug 그대로 표시).
      }
    })();
  }, []);

  // Filter option sources — 표시된 라인에서 직접 도출(누락 방지).
  const weekOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.weekId) seen.set(r.weekId, r.weekLabel ?? r.weekId);
    }
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [rows]);

  const orgOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      for (const t of r.targets) {
        if (t.organizationSlug) set.add(t.organizationSlug);
      }
    }
    return Array.from(set, (slug) => ({ slug, name: orgNames[slug] ?? slug }));
  }, [rows, orgNames]);

  const filteredRows = useMemo(() => {
    const nq = nameQuery.trim().toLowerCase();
    const tq = targetQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter === "active" && !r.isActive) return false;
      if (statusFilter === "inactive" && r.isActive) return false;
      // 라인 단위 강화 상태 = 대표 대상자(첫 행) 값. 대상자 0명이면 null.
      if (
        !matchesEnhancementFilter(
          enhancementFilter,
          r.targets[0]?.enhancementStatus ?? null,
        )
      )
        return false;
      if (weekFilter && r.weekId !== weekFilter) return false;
      if (orgFilter && !r.targets.some((t) => t.organizationSlug === orgFilter))
        return false;
      if (nq) {
        const hay = `${r.mainTitle} ${r.lineCode ?? ""}`.toLowerCase();
        if (!hay.includes(nq)) return false;
      }
      if (tq && !r.targets.some((t) => t.displayName.toLowerCase().includes(tq)))
        return false;
      return true;
    });
  }, [rows, statusFilter, enhancementFilter, weekFilter, orgFilter, nameQuery, targetQuery]);

  const detailLine = useMemo(
    () => rows.find((r) => r.id === detailId) ?? null,
    [rows, detailId],
  );

  const resetFilters = useCallback(() => {
    setOrgFilter("");
    setWeekFilter("");
    setNameQuery("");
    setTargetQuery("");
    setStatusFilter("all");
    setEnhancementFilter("all");
  }, []);

  const hasFilter =
    !!orgFilter ||
    !!weekFilter ||
    !!nameQuery ||
    !!targetQuery ||
    statusFilter !== "all" ||
    enhancementFilter !== "all";

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {loading ? (
            <LoadingState active variant="inline" />
          ) : (
            `총 ${rows.length}개 · 필터 결과 ${filteredRows.length}개`
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filter bar */}
        <div className="grid gap-3 rounded-md border bg-muted/30 p-3 md:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">조직</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={orgFilter}
              onChange={(e) => setOrgFilter(e.target.value)}
            >
              <option value="">전체 조직</option>
              {orgOptions.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          {!weekId && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">주차</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={weekFilter}
                onChange={(e) => setWeekFilter(e.target.value)}
              >
                <option value="">전체 주차</option>
                {weekOptions.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">상태</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="all">전체 상태</option>
              <option value="active">활성</option>
              <option value="inactive">비활성</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">강화 상태</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={enhancementFilter}
              onChange={(e) =>
                setEnhancementFilter(e.target.value as EnhancementFilter)
              }
            >
              {ENHANCEMENT_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{nameColumnLabel} 검색</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder={`${nameColumnLabel}/코드 검색...`}
                value={nameQuery}
                onChange={(e) => setNameQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">대상자 검색</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="대상자 이름 검색..."
                value={targetQuery}
                onChange={(e) => setTargetQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              size="sm"
              onClick={resetFilters}
              disabled={!hasFilter}
            >
              필터 초기화
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        {loading ? (
          <LoadingState active />
        ) : filteredRows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {rows.length === 0 ? "개설된 라인이 없습니다." : "필터 결과가 없습니다."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>주차</TableHead>
                  <TableHead>{nameColumnLabel}</TableHead>
                  <TableHead className="text-center">강화 상태</TableHead>
                  <TableHead className="text-center">대상</TableHead>
                  <TableHead className="text-center">기입/미기입</TableHead>
                  <TableHead className="text-center">편집가능</TableHead>
                  <TableHead className="whitespace-nowrap">기입 기간</TableHead>
                  <TableHead className="text-center">활성</TableHead>
                  <TableHead className="whitespace-nowrap">생성일</TableHead>
                  <TableHead>동작</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((line) => {
                  const expanded = expandedId === line.id;
                  const names = line.targets.map((t) => t.displayName);
                  const preview = names.slice(0, 3).join(", ");
                  const extra = names.length > 3 ? ` 외 ${names.length - 3}명` : "";
                  return (
                    <Fragment key={line.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() =>
                          setExpandedId((prev) => (prev === line.id ? null : line.id))
                        }
                      >
                        <TableCell>
                          {expanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {line.weekLabel ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-[260px]">
                          <div className="truncate font-medium">{line.mainTitle}</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {line.lineCode ?? line.id}
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          {line.targets[0] ? (
                            <EnhancementStatusBadge
                              status={line.targets[0].enhancementStatus}
                              reason={line.targets[0].enhancementReason}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">{line.targetCount}명</TableCell>
                        <TableCell className="text-center text-xs">
                          <span className="text-green-700">{line.submittedCount}</span>
                          {" / "}
                          <span className="text-orange-600">{line.pendingCount}</span>
                        </TableCell>
                        <TableCell className="text-center">{line.canEditCount}</TableCell>
                        <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">
                          {formatClubDate(line.submissionOpensAt)}
                          <br />~ {formatClubDate(line.submissionClosesAt)}
                        </TableCell>
                        <TableCell className="text-center">
                          {line.isActive ? (
                            <Check className="mx-auto h-4 w-4 text-green-600" />
                          ) : (
                            <X className="mx-auto h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {fmtDateShort(line.createdAt)}
                        </TableCell>
                        <TableCell
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDetailId(line.id)}
                          >
                            <Pencil className="mr-1 h-3 w-3" /> 상세
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="bg-muted/20">
                          <TableCell />
                          <TableCell colSpan={10} className="py-2">
                            <div className="mb-1 text-xs font-medium text-muted-foreground">
                              대상자 {line.targets.length}명 ({preview}
                              {extra})
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {line.targets.map((t) => (
                                <span
                                  key={t.lineTargetId}
                                  className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs"
                                >
                                  <span className="font-medium">{t.displayName}</span>
                                  {t.organizationSlug && (
                                    <span className="text-muted-foreground">
                                      · {orgNames[t.organizationSlug] ?? t.organizationSlug}
                                    </span>
                                  )}
                                  <EnhancementStatusBadge
                                    status={t.enhancementStatus}
                                    reason={t.enhancementReason}
                                    className="ml-1"
                                  />
                                  <SubmissionStatusBadge status={t.submissionStatus} />
                                  <CanEditBadge canEdit={t.canEdit} reason={t.editReason} />
                                </span>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {detailLine && (
        <LineDetailModal
          line={detailLine}
          nameColumnLabel={nameColumnLabel}
          editable={editable}
          onClose={() => setDetailId(null)}
          onSaved={() => {
            setDetailId(null);
            void fetchRows();
          }}
          onRefresh={() => {
            // 모달을 닫지 않고 목록만 재조회 → detailId 유지로 line prop 이 최신화된다.
            void fetchRows();
          }}
        />
      )}
    </Card>
  );
}
