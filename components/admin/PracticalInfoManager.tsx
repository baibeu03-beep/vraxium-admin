"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import {
  Plus,
  Search,
  Check,
  X,
  Upload,
  Trash2,
  Pencil,
  Users,
} from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { buildLineOpeningTabs } from "@/lib/adminHeaderTabs";
import PracticalInfoOpeningSection0 from "@/components/admin/PracticalInfoOpeningSection0";
import PracticalInfoCurrentSituation from "@/components/admin/PracticalInfoCurrentSituation";
import PracticalInfoWeekResults, {
  type SelectedInfoWeekMeta,
} from "@/components/admin/PracticalInfoWeekResults";
import type { Cluster4InfoLineDetail } from "@/lib/adminCluster4LinesTypes";
import {
  buildOutputLinksFromForm,
  OUTPUT_LINK_LABEL_PLACEHOLDER,
  OUTPUT_LINK_URL_PLACEHOLDER,
  OUTPUT_LINK_LABEL_MAX_LENGTH,
} from "@/lib/cluster4OutputLinks";
import { OUTPUT_IMAGE_CAPTION_MAX_LENGTH } from "@/lib/cluster4OutputImages";
import {
  EnhancementStatusBadge,
  SubmissionStatusBadge,
  ENHANCEMENT_FILTER_OPTIONS,
  matchesEnhancementFilter,
  type EnhancementFilter,
} from "@/components/admin/cluster4/enhancementBadges";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

type Banner = { kind: "success" | "error"; message: string } | null;

type CurrentWeekData = {
  weekId: string | null;
  seasonKey: string;
  seasonName: string;
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isOfficialRest: boolean;
  canOpen: boolean;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

type WeekOption = {
  id: string;
  label: string;
  seasonKey: string;
  seasonName: string;
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isOfficialRest: boolean;
  canOpen: boolean;
  isCurrent: boolean;
  // 운영 정책상 개설 대상 주차(목요일 경계 규칙). 일반 모드 기본 선택 대상.
  isOpenTarget: boolean;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

// 라인 개설 예외(line_opening_windows /active) — 활성 예외 주차 + 허용 라인.
type ExceptionWeekItem = {
  id: string;
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isOfficialRest: boolean;
  canOpen: boolean;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
  // null = 해당 주차 전체 라인 허용, 배열 = 그 활동 유형들만 허용.
  allowedActivityTypeIds: string[] | null;
};

type ActivityType = {
  id: string;
  name: string;
  lineCode: string | null;
  description: string | null;
  isActive: boolean;
  hasActiveLine: boolean;
};

type UserItem = {
  userId: string;
  displayName: string;
  profileImg: string | null;
  organization: string | null;
};

type UploadedImage = {
  url: string;
  name: string;
};

// 실무 정보 탭 표시 순서 — 운영 요청에 따라 9개 활동 유형의 표시 순서를 명시적으로 고정한다.
// DB 조회 순서(activity-types API 는 id ASC)나 id 알파벳 순에 의존하지 않고, 아래 배열 순서를
// UI 표시 순서로 강제한다. 여기 나열되지 않은(신규) 활동 유형은 API 순서로 뒤에 append 되므로
// 아래 9개의 상대 순서는 항상 유지된다.
//   위즈덤 → 에세이 → 인포데스크 → 캘린더 → 포럼 → 세션 → 아카데미 → 커뮤니티 → 기타A
// /crews/encre/[userId]/cluster4 프론트 카드와 동일하게 activity_types(cluster_id='practical_info')
// 를 단일 기준으로 사용한다 (lib/userActivityDetailsTypes.WORK_INFO_ACTIVITY_TYPE_IDS 참고).
const PREFERRED_TAB_ORDER = [
  "wisdom",
  "essay",
  "infodesk",
  "calendar",
  "forum",
  "session",
  "practical_lecture",
  "community",
  "etc_a",
] as const;

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

// ──────────────────────────────────────────────────────────────
// Date formatting — 오전/오후 + (요일)
// ──────────────────────────────────────────────────────────────

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

function fmtDateWithDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const dow = DAY_NAMES[d.getDay()];
  return `${y}. ${m}. ${day}. (${dow})`;
}

function fmtDateTimeWithDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const dow = DAY_NAMES[d.getDay()];
  let h = d.getHours();
  const min = d.getMinutes();
  const ampm = h < 12 ? "오전" : "오후";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  const minStr = min === 0 ? "00" : String(min).padStart(2, "0");
  return `${y}. ${m}. ${day}. (${dow}) ${ampm} ${h}:${minStr}`;
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const dow = DAY_NAMES[d.getDay()];
  return `${y}. ${m}. ${day}. (${dow})`;
}

// ISO ↔ <input type="datetime-local"> 변환 (로컬 타임존 기준).
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

// ──────────────────────────────────────────────────────────────
// Image Upload Component
// ──────────────────────────────────────────────────────────────

function ImageUploadSlot({
  label,
  image,
  caption,
  onUpload,
  onRemove,
  onCaptionChange,
  disabled,
}: {
  label: string;
  image: UploadedImage | null;
  // 캡션은 이미지와 분리된 독립 state. 업로드 전에도 입력 가능.
  caption: string;
  onUpload: (img: UploadedImage) => void;
  onRemove: () => void;
  onCaptionChange: (caption: string) => void;
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

        onUpload({ url: json.data.url, name: file.name });
      } catch {
        alert("업로드 중 오류가 발생했습니다");
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [onUpload],
  );

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {image ? (
        <div className="flex items-center gap-3 rounded-md border p-2">
          <img
            src={image.url}
            alt={image.name}
            className="h-16 w-16 shrink-0 rounded object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{image.name}</p>
            <p className="truncate text-xs text-muted-foreground">{image.url}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
      ) : (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={handleFileChange}
            disabled={disabled || uploading}
          />
          <Button
            variant="outline"
            className="w-full"
            loading={uploading}
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            이미지 업로드
          </Button>
        </div>
      )}
      {/* 이미지 캡션 — 업로드 전/후 항상 노출. 이미지 없으면 payload 미포함. 비우면 null 저장. */}
      <Input
        value={caption}
        onChange={(e) => onCaptionChange(e.target.value)}
        placeholder="이미지 캡션을 입력하세요"
        aria-label={`${label} 캡션`}
        maxLength={OUTPUT_IMAGE_CAPTION_MAX_LENGTH}
        disabled={disabled}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// canEdit badge
// ──────────────────────────────────────────────────────────────

function CanEditBadge({
  canEdit,
  reason,
}: {
  canEdit: boolean;
  reason: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        canEdit
          ? "bg-green-100 text-green-800"
          : "bg-muted text-muted-foreground",
      )}
    >
      {EDIT_REASON_LABEL[reason] ?? reason}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────
// Line Detail / Edit Modal
// ──────────────────────────────────────────────────────────────

function LineDetailModal({
  line,
  activityTypeName,
  onClose,
  onSaved,
}: {
  line: Cluster4InfoLineDetail;
  activityTypeName: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const devMode = useAdminDevMode();
  const [mainTitle, setMainTitle] = useState(line.mainTitle);
  // 서브 타이틀·그로스 포인트는 크루원 제출값으로 이전됨 → 라인 편집에서 제거.
  // (대상자별 제출값은 아래 대상자 테이블에서 읽기 전용으로 표시한다.)
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
      onSaved("라인 정보가 수정되었습니다");
    } catch {
      setError("저장 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
    }
  }, [
    line.id,
    mainTitle,
    outputLink1,
    outputLabel1,
    outputLink2,
    outputLabel2,
    opensAt,
    closesAt,
    isActive,
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
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {activityTypeName} · {line.weekLabel ?? "주차 미상"}
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

        {/* Editable line fields */}
        <section className="space-y-4">
          <h3 className="text-sm font-semibold">라인 기본 정보 (편집)</h3>
          <div className="space-y-2">
            <Label htmlFor="d-title">메인 타이틀</Label>
            <Input
              id="d-title"
              value={mainTitle}
              onChange={(e) => setMainTitle(e.target.value)}
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
                  maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH}
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
                  maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH}
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
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="rounded border-input"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            활성 라인 (is_active)
          </label>

          {/* Output images — read-only */}
          {line.outputImages.length > 0 && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Output 이미지 (읽기 전용)
              </Label>
              <div className="flex flex-wrap gap-3">
                {line.outputImages.map((url, i) => (
                  <figure key={`${url}-${i}`} className="w-16 space-y-1">
                    <img
                      src={url}
                      alt={line.outputImageCaptions[i] ?? "output"}
                      className="h-16 w-16 rounded border object-cover"
                    />
                    {line.outputImageCaptions[i] ? (
                      <figcaption className="truncate text-[10px] text-muted-foreground">
                        {line.outputImageCaptions[i]}
                      </figcaption>
                    ) : null}
                  </figure>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Targets — read-only */}
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
                  <TableHead>서브 타이틀</TableHead>
                  <TableHead>그로스 포인트</TableHead>
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
                    <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
                      {t.subtitle ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
                      {t.growthPoint ?? "—"}
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
                          · {fmtDateShort(t.submittedAt)}
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
          <Button onClick={handleSave} loading={saving}>
            라인 정보 저장
          </Button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────────────────────

export default function PracticalInfoManager() {
  // dev 모드(?dev=true): 주차 선택 UI 노출 + 과거 주차 개설 허용 (테스트용).
  // 일반 모드: weekSelect 미렌더 + 서버가 개설 대상 주차(금요일 경계) 강제.
  const devMode = useAdminDevMode();

  // ── State ──
  const [currentWeek, setCurrentWeek] = useState<CurrentWeekData | null>(null);
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  // 라인 개설 예외(line_opening_windows) — 활성 예외가 가리키는 주차 + 허용 라인.
  // 자동 정책 외 주차를 개설 폼에서 함께 선택할 수 있게 한다(예외 허용 주차).
  const [exceptionWeeks, setExceptionWeeks] = useState<ExceptionWeekItem[]>([]);
  // 선택 주차 단일 SoT — "주차별 개설 결과" 드롭다운(PracticalInfoWeekResults)이 이 값을 제어하며,
  //   "신규 개설 주차" 라벨·라인 목록·탭 dot·라인 조회 API 파라미터가 모두 이 weekId 를 공유한다.
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  // "주차별 개설 결과" 가 보고하는 선택 주차 표시 메타(weeks-options 범위 밖 과거 주차 라벨 표기용).
  const [selectedWeekMeta, setSelectedWeekMeta] = useState<SelectedInfoWeekMeta | null>(null);
  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);

  const [activeTypeId, setActiveTypeId] = useState<string>("");
  const [detailLines, setDetailLines] = useState<Cluster4InfoLineDetail[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);
  // 탭 dot 계산용 — 선택 주차(selectedWeekId)의 모든 활동 유형 라인. activeTypeId 와
  // 무관하게 주차 전체를 받아 (weekId + activityTypeId) 조합으로 dot 을 산정한다.
  const [weekLines, setWeekLines] = useState<Cluster4InfoLineDetail[]>([]);

  const [loading, setLoading] = useState(true);
  // 전역 로딩 배너 보고 — 최초 로딩 + 라인 재조회(필터 변경).
  useReportLoading(loading || linesLoading);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [mainTitle, setMainTitle] = useState("");
  // 서브 타이틀·그로스 포인트는 크루원 제출값으로 이전됨 → 라인 개설 폼에서 제거.
  const [outputLink1, setOutputLink1] = useState("");
  const [outputLabel1, setOutputLabel1] = useState("");
  const [outputLink2, setOutputLink2] = useState("");
  const [outputLabel2, setOutputLabel2] = useState("");
  const [uploadedImage1, setUploadedImage1] = useState<UploadedImage | null>(null);
  const [uploadedImage2, setUploadedImage2] = useState<UploadedImage | null>(null);
  // 이미지 캡션 — 이미지와 분리된 독립 state (업로드 전에도 입력 가능).
  const [caption1, setCaption1] = useState("");
  const [caption2, setCaption2] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [userSearch, setUserSearch] = useState("");

  // Phase 2C — 라인 정보(/admin/lines/info)에서 넘어온 프리필 (additive, 개설 플로우 무변).
  // 실무 정보는 마스터가 없어 브리지 대상이 아니므로 메인 타이틀 프리필만 지원한다.
  // useSearchParams 대신 mount 1회 window 조회 — 기존 렌더/Suspense 경계 영향 없음.
  useEffect(() => {
    const prefill = new URLSearchParams(window.location.search).get("prefillMainTitle");
    if (prefill && prefill.trim().length > 0) {
      setMainTitle(prefill.trim());
      setShowForm(true);
    }
  }, []);

  // 2탭(라인 관리/라인 개설)·섹션0 은 **조직 분기 모드(?org 있음)** 에서만 적용한다.
  // 통합 검수 시스템(원본, ?org 없음)에서는 기존 단일 화면 그대로 — 탭/섹션0 없음, 폭도 기존 그대로.
  // 탭 UI 자체는 상단 Header title 영역에 있고 본문은 URL ?tab 으로 어느 콘텐츠를 보일지만 결정한다.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const orgScoped = readOrgParam(searchParams) != null;
  const mainTab: "manage" | "open" =
    orgScoped && searchParams?.get("tab") === "open" ? "open" : "manage";

  // Detail modal
  const [detailLineId, setDetailLineId] = useState<string | null>(null);
  const [enhancementFilter, setEnhancementFilter] = useState<EnhancementFilter>("all");

  // ── Ordered tabs (커뮤니티/에세이/위즈덤 우선) ──
  const orderedTypes = useMemo(() => {
    const preferred = PREFERRED_TAB_ORDER.map((id) =>
      activityTypes.find((t) => t.id === id),
    ).filter((t): t is ActivityType => Boolean(t));
    const preferredIds = new Set(preferred.map((t) => t.id));
    const rest = activityTypes.filter((t) => !preferredIds.has(t.id));
    return [...preferred, ...rest];
  }, [activityTypes]);

  const activeType = useMemo(
    () => orderedTypes.find((t) => t.id === activeTypeId) ?? null,
    [orderedTypes, activeTypeId],
  );

  // ── 탭 dot 산정 — (weekId + activityTypeId) 조합 ──
  // dot 은 activityTypeId 단독이 아니라 "선택 주차에 그 활동 유형의 활성 라인이 있는지"로
  // 판단한다. weekLines 는 이미 selectedWeekId 로 조회되지만, 안전을 위해 weekId 도 재확인한다.
  const openedActivityTypeIdsForSelectedWeek = useMemo(() => {
    const set = new Set<string>();
    for (const line of weekLines) {
      if (
        line.isActive &&
        line.weekId === selectedWeekId &&
        line.activityTypeId
      ) {
        set.add(line.activityTypeId);
      }
    }
    return set;
  }, [weekLines, selectedWeekId]);

  // ── Output Asset count ──
  const assetCount = useMemo(() => {
    let count = 0;
    if (outputLink1.trim()) count++;
    if (outputLink2.trim()) count++;
    if (uploadedImage1) count++;
    if (uploadedImage2) count++;
    return count;
  }, [outputLink1, outputLink2, uploadedImage1, uploadedImage2]);

  const assetValid = assetCount >= 1 && assetCount <= 2;

  // ── Filtered users ──
  const filteredUsers = useMemo(() => {
    if (!userSearch.trim()) return users;
    const q = userSearch.trim().toLowerCase();
    return users.filter((u) => u.displayName.toLowerCase().includes(q));
  }, [users, userSearch]);

  // ── Meta fetch (weeks / types / users) ──
  const fetchMeta = useCallback(async () => {
    try {
      const [weekRes, weeksRes, typesRes, usersRes, excRes] = await Promise.all([
        fetch("/api/admin/cluster4/current-week"),
        fetch(
          appendModeQuery(
            "/api/admin/cluster4/weeks-options?limit=3",
            readScopeMode(new URLSearchParams(window.location.search)),
          ),
        ),
        fetch("/api/admin/cluster4/activity-types?cluster=practical_info"),
        fetch("/api/admin/cluster4/users"),
        fetch("/api/admin/line-opening-windows/active"),
      ]);

      const weekJson = await weekRes.json();
      if (weekJson.success) setCurrentWeek(weekJson.data);

      // 라인 개설 예외(활성) — 개설 폼에 "예외 허용 주차" 로 함께 노출.
      const excJson = await excRes.json();
      if (excJson.success) {
        setExceptionWeeks((excJson.data.weeks ?? []) as ExceptionWeekItem[]);
      }

      const weeksJson = await weeksRes.json();
      if (weeksJson.success) {
        const opts: WeekOption[] = weeksJson.data.weeks ?? [];
        setWeekOptions(opts);
        // 운영 정책: 기본 개설 대상 = isOpenTarget(금요일 경계 규칙). 없으면 현재(N) → 첫 항목 순으로 fallback.
        const defaultWeek =
          opts.find((o) => o.isOpenTarget) ??
          opts.find((o) => o.isCurrent) ??
          opts[0];
        if (defaultWeek) setSelectedWeekId((prev) => prev || defaultWeek.id);
      }

      const typesJson = await typesRes.json();
      if (typesJson.success) {
        const types: ActivityType[] = typesJson.data;
        setActivityTypes(types);
        // 기본 활성 탭 지정 — 커뮤니티/에세이/위즈덤 우선, 그 외 API 순서.
        const firstId =
          PREFERRED_TAB_ORDER.map((id) => types.find((t) => t.id === id)?.id).find(
            Boolean,
          ) ?? types[0]?.id;
        if (firstId) setActiveTypeId((prev) => prev || firstId);
      }

      const usersJson = await usersRes.json();
      if (usersJson.success) setUsers(usersJson.data);
    } catch (error) {
      console.error("Failed to fetch meta", error);
      setBanner({ kind: "error", message: "데이터를 불러오는데 실패했습니다" });
    }
  }, []);

  // ── Lines fetch (per active activity-type tab + 선택한 주차) ──
  const fetchLines = useCallback(async (typeId: string, weekId: string) => {
    if (!typeId) {
      setDetailLines([]);
      return;
    }
    setLinesLoading(true);
    try {
      const qs = new URLSearchParams({ activity_type_id: typeId });
      // 개설된 라인 목록은 선택한 주차(selectedWeekId) 기준으로만 표시한다.
      if (weekId) qs.set("week_id", weekId);
      // 조직 컨텍스트(?org)를 내부 API 컨벤션(organization)으로 변환해 전달.
      // 조직 모드면 (해당 조직 OR 공통) 라인만, 통합 모드(org 없음)면 전체.
      const org = readOrgParam(new URLSearchParams(window.location.search));
      if (org) qs.set("organization", org);
      const res = await fetch(`/api/admin/cluster4/info-lines?${qs.toString()}`);
      const json = await res.json();
      if (json.success) {
        setDetailLines(json.data.rows ?? []);
      } else {
        setDetailLines([]);
        setBanner({ kind: "error", message: json.error ?? "라인 목록을 불러오지 못했습니다" });
      }
    } catch (error) {
      console.error("Failed to fetch lines", error);
      setDetailLines([]);
    } finally {
      setLinesLoading(false);
    }
  }, []);

  // ── Week-scoped lines fetch (탭 dot 계산용 — 활동 유형 무관, 선택 주차 전체) ──
  const fetchWeekLines = useCallback(async (weekId: string) => {
    if (!weekId) {
      setWeekLines([]);
      return;
    }
    try {
      const qs = new URLSearchParams({ week_id: weekId });
      const org = readOrgParam(new URLSearchParams(window.location.search));
      if (org) qs.set("organization", org);
      const res = await fetch(`/api/admin/cluster4/info-lines?${qs.toString()}`);
      const json = await res.json();
      setWeekLines(json.success ? (json.data.rows ?? []) : []);
    } catch (error) {
      console.error("Failed to fetch week lines", error);
      setWeekLines([]);
    }
  }, []);

  // ── Initial load ──
  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchMeta();
      setLoading(false);
    })();
  }, [fetchMeta]);

  // ── Refetch lines when tab OR 선택 주차 changes ──
  useEffect(() => {
    if (!activeTypeId) return;
    void (async () => {
      await fetchLines(activeTypeId, selectedWeekId);
    })();
  }, [activeTypeId, selectedWeekId, fetchLines]);

  // ── 주차 변경 시 탭 dot 데이터(weekLines) 즉시 재계산 ──
  useEffect(() => {
    void fetchWeekLines(selectedWeekId);
  }, [selectedWeekId, fetchWeekLines]);

  // ── Form reset ──
  const resetForm = useCallback(() => {
    setMainTitle("");
    setOutputLink1("");
    setOutputLabel1("");
    setOutputLink2("");
    setOutputLabel2("");
    setUploadedImage1(null);
    setUploadedImage2(null);
    setCaption1("");
    setCaption2("");
    setSelectedUserIds(new Set());
    setUserSearch("");
  }, []);

  // ── Tab switch ──
  const switchTab = useCallback(
    (typeId: string) => {
      setActiveTypeId(typeId);
      setShowForm(false);
      resetForm();
      setBanner(null);
    },
    [resetForm],
  );

  // ── Toggle user selection ──
  const toggleUser = useCallback((userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedUserIds(new Set(filteredUsers.map((u) => u.userId)));
  }, [filteredUsers]);

  const deselectAll = useCallback(() => {
    setSelectedUserIds(new Set());
  }, []);

  // 선택된 주차 정보 — 신규 라인 개설에 사용.
  const selectedWeek = useMemo(
    () => weekOptions.find((w) => w.id === selectedWeekId) ?? null,
    [weekOptions, selectedWeekId],
  );

  // 신규 라인 개설 가능 여부는 "선택 주차"(단일 SoT) 기준으로만 판정한다.
  //   선택 주차가 weeks-options(개설 가능 최근 주차)에 없으면(예: 과거 W16 열람) selectedWeek=null
  //   → 개설 불가. 이전의 currentWeek fallback 은 열람 주차와 무관한 주차로 개설을 허용해
  //   "표시 주차 ≠ 개설 주차" 불일치를 만들 수 있어 제거한다.
  const canOpenSelected = useMemo(
    () => (selectedWeek ? selectedWeek.canOpen : false),
    [selectedWeek],
  );

  // ── Save (신규 라인 개설) — 활동 유형은 현재 탭으로 고정 ──
  const handleSave = useCallback(async () => {
    if (!activeTypeId) {
      setBanner({ kind: "error", message: "활동 유형 탭을 선택해주세요" });
      return;
    }
    if (!selectedWeekId) {
      setBanner({ kind: "error", message: "주차를 선택해주세요" });
      return;
    }
    const targetWeekId = selectedWeek?.id ?? null;
    const targetOpens = selectedWeek?.submissionOpensAt ?? null;
    const targetCloses = selectedWeek?.submissionClosesAt ?? null;
    if (!targetWeekId || !targetOpens || !targetCloses) {
      setBanner({ kind: "error", message: "선택한 주차 정보를 확인할 수 없습니다" });
      return;
    }
    if (!selectedWeek?.canOpen) {
      setBanner({ kind: "error", message: "선택한 주차는 라인 개설이 불가합니다" });
      return;
    }
    if (!mainTitle.trim()) {
      setBanner({ kind: "error", message: "메인 타이틀을 입력해주세요" });
      return;
    }
    if (!assetValid) {
      setBanner({
        kind: "error",
        message:
          assetCount < 1
            ? "Output을 최소 1개 입력해주세요"
            : "Output은 최대 2개까지 입력 가능합니다",
      });
      return;
    }
    if (selectedUserIds.size === 0) {
      setBanner({ kind: "error", message: "개설 대상을 최소 1명 이상 선택해주세요" });
      return;
    }
    const built = buildOutputLinksFromForm([
      { url: outputLink1, label: outputLabel1 },
      { url: outputLink2, label: outputLabel2 },
    ]);
    if (!built.ok) {
      setBanner({ kind: "error", message: built.error });
      return;
    }
    const outputLinks = built.value;

    setSaving(true);
    setBanner(null);

    try {
      // output_images = [{url, caption}] — 이미지 있는 항목만 포함. 캡션 비우면 null.
      const outputImages: { url: string; caption: string | null }[] = [];
      for (const [img, cap] of [
        [uploadedImage1, caption1],
        [uploadedImage2, caption2],
      ] as const) {
        if (!img) continue;
        outputImages.push({
          url: img.url,
          caption: cap.trim() ? cap.trim() : null,
        });
      }

      const payload = {
        activity_type_id: activeTypeId,
        main_title: mainTitle.trim(),
        // output_links 우선 + 레거시 컬럼 backward-compat mirror.
        output_links: outputLinks,
        output_link_1: outputLinks[0]?.url ?? null,
        output_link_2: outputLinks[1]?.url ?? null,
        output_images: outputImages,
        target_user_ids: Array.from(selectedUserIds),
        week_id: targetWeekId,
        submission_opens_at: targetOpens,
        submission_closes_at: targetCloses,
      };
      // dev 모드에서만 ?dev=true 를 전달 → 서버가 과거 주차 개설을 허용.
      // 일반 모드에서는 서버가 N-1 을 강제하므로 week_id 조작이 무력화된다.
      // mode(운영/테스트) 도 함께 전달 → 서버 스코프 가드(target 혼입 방지)와 정합.
      const saveSp = new URLSearchParams();
      if (devMode) saveSp.set("dev", "true");
      if (new URLSearchParams(window.location.search).get("mode") === "test")
        saveSp.set("mode", "test");
      const res = await fetch(
        `/api/admin/cluster4/info-lines${saveSp.toString() ? `?${saveSp.toString()}` : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      const json = await res.json();

      if (!json.success) {
        setBanner({ kind: "error", message: json.error ?? "저장에 실패했습니다" });
        return;
      }

      setBanner({
        kind: "success",
        message: `라인이 생성되었습니다 (대상: ${json.data?.targetCount ?? 0}명)`,
      });
      resetForm();
      setShowForm(false);
      await fetchMeta();
      await fetchLines(activeTypeId, selectedWeekId);
      await fetchWeekLines(selectedWeekId);
    } catch (error) {
      console.error("Save failed", error);
      setBanner({ kind: "error", message: "저장 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [
    activeTypeId,
    selectedWeek,
    selectedWeekId,
    mainTitle,
    assetValid,
    assetCount,
    outputLink1,
    outputLabel1,
    outputLink2,
    outputLabel2,
    uploadedImage1,
    uploadedImage2,
    caption1,
    caption2,
    selectedUserIds,
    resetForm,
    fetchMeta,
    fetchLines,
    fetchWeekLines,
    devMode,
  ]);

  const detailLine = useMemo(
    () => detailLines.find((l) => l.id === detailLineId) ?? null,
    [detailLines, detailLineId],
  );

  // 라인 단위 강화 상태 = 대표 대상자(첫 행) 값 (대상자 전원 동일).
  const filteredLines = useMemo(
    () =>
      detailLines.filter((l) =>
        matchesEnhancementFilter(
          enhancementFilter,
          l.targets[0]?.enhancementStatus ?? null,
        ),
      ),
    [detailLines, enhancementFilter],
  );

  // ── Render ──
  if (loading) {
    return <LoadingState active />;
  }

  // 중복 기준: activity_type_id + week_id. detailLines 는 이미 현재 탭(activity_type)
  // + 선택 주차(selectedWeekId) 로 필터된 목록이므로, 그 안의 active 라인 유무로 판단한다.
  // 다른 주차의 active 라인은 현재 주차 신규 개설을 막지 않는다.
  const newLineDisabled = detailLines.some((l) => l.isActive);

  // 본문 폭: 조직 분기 모드에서만 넓게 사용(max-width 제거 → 좌우 여백 = 레이아웃 main p-6).
  // 통합 검수 시스템(원본)에서는 기존 폭(max-w-[1440px] 가운데 정렬) 그대로 유지.
  return (
    <div
      className={cn(
        "space-y-6",
        orgScoped
          ? "w-full min-w-0"
          : "mx-auto w-full max-w-[1440px] px-4 py-6",
      )}
    >
      <AdminPageHeader
        title="실무 정보 라인"
        description="허브와 라인 · 라인 관리 / 라인 개설"
        tabs={
          orgScoped
            ? buildLineOpeningTabs(pathname, searchParams, mainTab)
            : undefined
        }
      />

      {/* Week selector (신규 개설 대상 주차) — dev 모드에서만 노출.
          일반 모드에서는 렌더링하지 않으며, 서버가 N-1 을 강제한다. */}
      {devMode && weekOptions.length > 0 && (
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="weekSelect" className="text-xs text-muted-foreground">
              신규 개설 대상 주차 <span className="text-amber-600">(dev)</span>
            </Label>
            <select
              id="weekSelect"
              className="w-72 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedWeekId}
              onChange={(e) => setSelectedWeekId(e.target.value)}
            >
              <option value="">주차를 선택해주세요</option>
              {weekOptions.map((w) => (
                <option key={w.id} value={w.id} disabled={!w.canOpen}>
                  {w.label} ({w.startDate} ~ {w.endDate})
                  {w.isOpenTarget ? " · 개설대상" : ""}
                  {w.isCurrent ? " · 현재(N)" : ""}
                  {!w.canOpen ? " · 휴식" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* 2탭(라인 관리/라인 개설)은 상단 Header title 영역으로 이동 — 본문에는 두지 않는다. */}
      {mainTab === "manage" && (
        <>
      {/* 상단 현재 상황(표시 전용) — 오늘 날짜 + 개설 필요/이행 기간(금요일 경계). 저장 정책 무관.
          라인 관리 탭에만 노출(라인 개설 탭은 입력 집중 위해 제외). */}
      <PracticalInfoCurrentSituation />

      {/* 주차별 개설 결과(표시 전용 · read-only) — 주차 선택 + 요약 + 라인별 개설 상황 카드.
          라인 관리 탭에만 노출(라인 개설 탭은 입력 집중 위해 제외).
          이 카드의 주차 드롭다운이 manage 탭의 유일한 주차 선택 컨트롤(단일 SoT=selectedWeekId)이며,
          선택을 바꾸면 아래 "신규 개설 주차" 라벨·라인 목록·탭 dot 이 동일 주차로 따라간다. */}
      <PracticalInfoWeekResults
        selectedWeekId={selectedWeekId}
        onSelectWeek={setSelectedWeekId}
        onWeekMetaResolved={setSelectedWeekMeta}
      />

      {/* Banner */}
      {banner && (
        <div
          className={cn(
            "rounded-md border px-4 py-3 text-sm",
            banner.kind === "success"
              ? "border-green-300 bg-green-50 text-green-800"
              : "border-red-300 bg-red-50 text-red-800",
          )}
        >
          {banner.message}
          <button className="float-right" onClick={() => setBanner(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Selected week summary — "주차별 개설 결과" 선택 주차(단일 SoT)와 항상 동일.
          라벨/기간은 selectedWeekMeta(주차 전 범위)에서, 기입 기간·휴식 안내는 selectedWeek
          (weeks-options=개설 가능 주차)에서 가져온다. 둘 다 같은 selectedWeekId 를 가리킨다. */}
      {(() => {
        const label =
          selectedWeekMeta?.label ??
          (selectedWeek
            ? `${selectedWeek.year} ${selectedWeek.seasonName} W${selectedWeek.weekNumber}`
            : null);
        const startDate = selectedWeekMeta?.startDate ?? selectedWeek?.startDate ?? null;
        const endDate = selectedWeekMeta?.endDate ?? selectedWeek?.endDate ?? null;
        if (!label) return null;
        return (
          <p className="text-sm text-muted-foreground">
            신규 개설 주차:{" "}
            <span className="font-medium text-foreground">{label}</span>
            {startDate && endDate
              ? ` (${fmtDateWithDay(startDate)} ~ ${fmtDateWithDay(endDate)})`
              : null}
            {selectedWeek?.canOpen &&
              selectedWeek.submissionOpensAt &&
              selectedWeek.submissionClosesAt && (
                <>
                  {" · 기입 "}
                  {fmtDateTimeWithDay(selectedWeek.submissionOpensAt)} ~{" "}
                  {fmtDateTimeWithDay(selectedWeek.submissionClosesAt)}
                </>
              )}
            {selectedWeek && !selectedWeek.canOpen && (
              <span className="font-medium text-orange-600"> · 공식 휴식 주차 (개설 불가)</span>
            )}
          </p>
        );
      })()}

      {/* Activity-type tabs */}
      <div className="flex flex-wrap gap-2 border-b pb-px">
        {orderedTypes.map((t) => (
          <button
            key={t.id}
            onClick={() => switchTab(t.id)}
            className={cn(
              "relative -mb-px rounded-t-md border border-b-0 px-4 py-2 text-sm font-medium transition-colors",
              activeTypeId === t.id
                ? "border-input bg-background text-foreground"
                : "border-transparent bg-muted/40 text-muted-foreground hover:text-foreground",
            )}
          >
            {t.name}
            {openedActivityTypeIdsForSelectedWeek.has(t.id) && (
              <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-green-500 align-middle" />
            )}
          </button>
        ))}
      </div>

      {/* Tab content: list + form */}
      <div
        className={cn(
          "grid gap-6",
          showForm ? "xl:grid-cols-[minmax(0,1fr)_440px]" : "grid-cols-1",
        )}
      >
        {/* Lines list */}
        <Card className="min-w-0">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
            <div>
              <CardTitle className="text-base">
                {activeType?.name ?? "활동 유형"} 라인 목록
              </CardTitle>
              <CardDescription>
                개설된 라인 {detailLines.length}개 · 행을 클릭하면 상세/편집
              </CardDescription>
            </div>
            {!showForm && (
              <Button
                onClick={() => setShowForm(true)}
                disabled={!canOpenSelected || newLineDisabled}
                title={
                  newLineDisabled
                    ? "선택한 주차에 이 활동 유형의 활성 라인이 있습니다"
                    : !canOpenSelected
                      ? "선택한 주차는 개설 불가"
                      : undefined
                }
              >
                <Plus className="mr-2 h-4 w-4" /> 새 라인 개설
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {newLineDisabled && !showForm && (
              <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                선택한 주차에는 이 활동 유형의 활성 라인이 이미 있습니다. 신규 개설은 기존 라인 비활성화 후 가능합니다.
              </p>
            )}
            {detailLines.length > 0 && (
              <div className="mb-3 flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">강화 상태</Label>
                <select
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
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
            )}
            {linesLoading ? (
              <LoadingState active />
            ) : detailLines.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                개설된 라인이 없습니다.
              </p>
            ) : filteredLines.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                필터 결과가 없습니다.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>주차</TableHead>
                      <TableHead>메인 타이틀</TableHead>
                      <TableHead className="text-center">강화 상태</TableHead>
                      <TableHead>대상자</TableHead>
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
                    {filteredLines.map((line) => {
                      const names = line.targets.map((t) => t.displayName);
                      const preview = names.slice(0, 3).join(", ");
                      const extra = names.length > 3 ? ` 외 ${names.length - 3}명` : "";
                      return (
                        <TableRow
                          key={line.id}
                          className="cursor-pointer"
                          onClick={() => setDetailLineId(line.id)}
                        >
                          <TableCell className="whitespace-nowrap text-xs">
                            {line.weekLabel ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-[220px]">
                            <div className="truncate font-medium">{line.mainTitle}</div>
                            <div className="truncate font-mono text-[10px] text-muted-foreground">
                              {line.id}
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
                          <TableCell className="max-w-[200px]">
                            <span className="text-xs text-muted-foreground">
                              {preview}
                              {extra}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">{line.targetCount}명</TableCell>
                          <TableCell className="text-center text-xs">
                            <span className="text-green-700">{line.submittedCount}</span>
                            {" / "}
                            <span className="text-orange-600">{line.pendingCount}</span>
                          </TableCell>
                          <TableCell className="text-center">{line.canEditCount}</TableCell>
                          <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">
                            {fmtDateShort(line.submissionOpensAt)}
                            <br />~ {fmtDateShort(line.submissionClosesAt)}
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
                              onClick={() => setDetailLineId(line.id)}
                            >
                              <Pencil className="mr-1 h-3 w-3" /> 상세
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* New Line Form */}
        {showForm && (
          <Card className="h-fit xl:sticky xl:top-6">
            <CardHeader>
              <CardTitle className="text-base">새 실무 정보 라인</CardTitle>
              <CardDescription>
                {selectedWeek?.submissionClosesAt
                  ? `크루원 2차 입력 마감: ${fmtDateTimeWithDay(selectedWeek.submissionClosesAt)}`
                  : "주차를 선택해주세요"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Activity Type — read-only (탭 값으로 고정) */}
              <div className="space-y-2">
                <Label>활동 유형</Label>
                <div className="flex items-center gap-2 rounded-md border border-input bg-muted/50 px-3 py-2 text-sm">
                  <span className="font-medium">{activeType?.name ?? "-"}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    ({activeTypeId})
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">탭 고정</span>
                </div>
              </div>

              {/* Main Title */}
              <div className="space-y-2">
                <Label htmlFor="mainTitle">
                  메인 타이틀 <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="mainTitle"
                  value={mainTitle}
                  onChange={(e) => setMainTitle(e.target.value)}
                  placeholder="메인 타이틀을 입력하세요"
                />
              </div>

              {/* 서브 타이틀·그로스 포인트는 크루원 제출값으로 이전됨 → 라인 개설 폼에서 제거.
                  (크루원 제출 후 라인 상세의 대상자 테이블에서 읽기 전용으로 확인) */}

              {/* Output Assets */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>
                    Output Asset <span className="text-red-500">*</span>
                  </Label>
                  <span
                    className={cn(
                      "text-xs",
                      assetCount === 0
                        ? "text-red-500"
                        : assetCount <= 2
                          ? "text-green-600"
                          : "text-red-500",
                    )}
                  >
                    {assetCount}/2 (최소 1, 최대 2)
                  </span>
                </div>

                <div className="grid gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="link1" className="text-xs text-muted-foreground">
                      Link 1 URL
                    </Label>
                    <Input
                      id="link1"
                      value={outputLink1}
                      onChange={(e) => setOutputLink1(e.target.value)}
                      placeholder={OUTPUT_LINK_URL_PLACEHOLDER}
                      disabled={!outputLink1.trim() && assetCount >= 2}
                    />
                    <Input
                      id="label1"
                      value={outputLabel1}
                      onChange={(e) => setOutputLabel1(e.target.value)}
                      placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER}
                      aria-label="Link 1 설명"
                      maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="link2" className="text-xs text-muted-foreground">
                      Link 2 URL
                    </Label>
                    <Input
                      id="link2"
                      value={outputLink2}
                      onChange={(e) => setOutputLink2(e.target.value)}
                      placeholder={OUTPUT_LINK_URL_PLACEHOLDER}
                      disabled={!outputLink2.trim() && assetCount >= 2}
                    />
                    <Input
                      id="label2"
                      value={outputLabel2}
                      onChange={(e) => setOutputLabel2(e.target.value)}
                      placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER}
                      aria-label="Link 2 설명"
                      maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH}
                    />
                  </div>

                  <ImageUploadSlot
                    label="Image 1"
                    image={uploadedImage1}
                    caption={caption1}
                    onUpload={setUploadedImage1}
                    onRemove={() => { setUploadedImage1(null); setCaption1(""); }}
                    onCaptionChange={setCaption1}
                    disabled={!uploadedImage1 && assetCount >= 2}
                  />
                  <ImageUploadSlot
                    label="Image 2"
                    image={uploadedImage2}
                    caption={caption2}
                    onUpload={setUploadedImage2}
                    onRemove={() => { setUploadedImage2(null); setCaption2(""); }}
                    onCaptionChange={setCaption2}
                    disabled={!uploadedImage2 && assetCount >= 2}
                  />
                </div>
              </div>

              {/* Target Users */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>
                    개설 대상 크루 <span className="text-red-500">*</span>
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    <Users className="mr-1 inline h-3 w-3" />
                    {selectedUserIds.size}명
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="pl-9"
                      placeholder="이름 검색..."
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                    />
                  </div>
                  <Button variant="outline" size="sm" onClick={selectAll}>
                    전체
                  </Button>
                  <Button variant="outline" size="sm" onClick={deselectAll}>
                    해제
                  </Button>
                </div>

                <div className="max-h-60 overflow-y-auto rounded-md border p-2">
                  {filteredUsers.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                      {users.length === 0
                        ? "등록된 사용자가 없습니다"
                        : "검색 결과가 없습니다"}
                    </p>
                  ) : (
                    <div className="grid grid-cols-2 gap-1">
                      {filteredUsers.map((user) => (
                        <label
                          key={user.userId}
                          className={cn(
                            "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                            selectedUserIds.has(user.userId) && "bg-muted",
                          )}
                        >
                          <input
                            type="checkbox"
                            className="rounded border-input"
                            checked={selectedUserIds.has(user.userId)}
                            onChange={() => toggleUser(user.userId)}
                          />
                          <span className="truncate">{user.displayName}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    resetForm();
                    setShowForm(false);
                  }}
                  disabled={saving}
                >
                  취소
                </Button>
                <Button onClick={handleSave} loading={saving}>
                  저장
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Detail / Edit modal */}
      {detailLine && (
        <LineDetailModal
          line={detailLine}
          activityTypeName={detailLine.activityTypeName ?? activeType?.name ?? "-"}
          onClose={() => setDetailLineId(null)}
          onSaved={(message) => {
            setBanner({ kind: "success", message });
            setDetailLineId(null);
            fetchLines(activeTypeId, selectedWeekId);
            fetchWeekLines(selectedWeekId);
            fetchMeta();
          }}
        />
      )}
        </>
      )}

      {mainTab === "open" && (
        <div className="space-y-6">
          {/* 활동 유형 탭 (라인 개설 탭 — 섹션0 대상 활동유형 선택, activeTypeId 공유) */}
          <div className="flex flex-wrap gap-2 border-b pb-px">
            {orderedTypes.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => switchTab(t.id)}
                className={cn(
                  "relative -mb-px rounded-t-md border border-b-0 px-4 py-2 text-sm font-medium transition-colors",
                  activeTypeId === t.id
                    ? "border-input bg-background text-foreground"
                    : "border-transparent bg-muted/40 text-muted-foreground hover:text-foreground",
                )}
              >
                {t.name}
              </button>
            ))}
          </div>

          {/* [섹션 0] 상태창 + 개설/검수 기록 + 실제 개설 폼.
              개설 대상 주차 = isOpenTarget(금요일 경계 규칙, 서버 강제와 동일 함수). */}
          <PracticalInfoOpeningSection0
            currentWeek={currentWeek}
            openableWeek={weekOptions.find((o) => o.isOpenTarget) ?? null}
            weekOptions={weekOptions}
            exceptionWeeks={exceptionWeeks}
            activeType={activeType}
            // 라인명 드롭다운 후보 = 현재 상단 활동유형 탭의 유형만(탭별 필터링).
            activityTypes={activeType ? [{ id: activeType.id, name: activeType.name }] : []}
            users={users}
            onOpened={() => {
              // 개설 직후 메타·라인 목록·탭 dot 데이터 재조회(manage 탭과 동기화).
              void fetchMeta();
              void fetchLines(activeTypeId, selectedWeekId);
              void fetchWeekLines(selectedWeekId);
            }}
          />
        </div>
      )}
    </div>
  );
}
