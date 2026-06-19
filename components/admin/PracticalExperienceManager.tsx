"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Loader2,
  Plus,
  Search,
  Check,
  X,
  Upload,
  Trash2,
  Pencil,
  Eye,
  CheckCircle2,
  XCircle,
  ExternalLink,
} from "lucide-react";
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
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { readOrgParam } from "@/lib/adminOrgContext";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { buildLineOpeningTabs } from "@/lib/adminHeaderTabs";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import {
  ORGANIZATIONS,
  ORGANIZATION_LABEL,
  ORGANIZATION_COMMON_LABEL,
} from "@/lib/organizations";
import {
  type Cluster4OutputLink,
  buildOutputLinksFromForm,
  OUTPUT_LINK_LABEL_PLACEHOLDER,
  OUTPUT_LINK_URL_PLACEHOLDER,
  OUTPUT_LINK_LABEL_MAX_LENGTH,
} from "@/lib/cluster4OutputLinks";
import { OUTPUT_IMAGE_CAPTION_MAX_LENGTH } from "@/lib/cluster4OutputImages";
import type { Cluster4LineDetail } from "@/lib/adminCluster4LinesTypes";
import {
  EnhancementStatusBadge,
  SubmissionStatusBadge,
  ENHANCEMENT_FILTER_OPTIONS,
  matchesEnhancementFilter,
  type EnhancementFilter,
} from "@/components/admin/cluster4/enhancementBadges";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import LineOpeningStatusBoard from "@/components/admin/LineOpeningStatusBoard";
import ExperienceOpeningLogPanel from "@/components/admin/ExperienceOpeningLogPanel";
import ExperiencePartLeadInput from "@/components/admin/ExperiencePartLeadInput";
import ExperienceLineManageBoard from "@/components/admin/ExperienceLineManageBoard";

const ORG_OPTIONS: Array<{ value: string; label: string }> = [
  ...ORGANIZATIONS.map((slug) => ({ value: slug, label: ORGANIZATION_LABEL[slug] })),
  { value: "common", label: ORGANIZATION_COMMON_LABEL },
];

function formatOrgLabel(slug: string | null | undefined): string {
  if (!slug) return "-";
  if (slug === "common") return ORGANIZATION_COMMON_LABEL;
  return (ORGANIZATION_LABEL as Record<string, string>)[slug] ?? slug;
}

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
  id: string;             // weeks.id (UUID).
  label: string;          // "{year}년도 {season} {weekNumber}w".
  seasonKey: string;
  seasonName: string;
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isOfficialRest: boolean;
  canOpen: boolean;
  isCurrent: boolean;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

type TeamItem = {
  id: string;
  teamName: string;
  organizationSlug: string;
  isActive: boolean;
};

type ExperienceCategory =
  | "derivation"
  | "analysis"
  | "evaluation"
  | "extension"
  | "management";

type LineMasterItem = {
  id: string;
  organizationSlug: string;
  lineCode: string;
  lineName: string;
  mainTitle: string | null;
  teamId: string | null;
  teamName: string | null;
  sourceFileName: string | null;
  isActive: boolean;
  // 5슬롯 분류 (표시 전용). 미분류면 null.
  experienceCategory: ExperienceCategory | null;
  experienceSlotOrder: number | null;
  createdAt: string;
  updatedAt: string;
};

// 5슬롯 분류 한글 라벨 (slot 1~5 ↔ category 1:1).
const EXPERIENCE_CATEGORY_LABEL: Record<ExperienceCategory, string> = {
  derivation: "도출",
  analysis: "분석",
  evaluation: "평가",
  extension: "확장",
  management: "관리",
};

function formatExperienceSlotLabel(
  category: ExperienceCategory | null,
  slotOrder: number | null,
): string {
  if (!category || slotOrder == null) return "-";
  return `${slotOrder}. ${EXPERIENCE_CATEGORY_LABEL[category]}`;
}

type CrewItem = {
  userId: string;
  displayName: string;
  profileImg: string | null;
  organization: string | null;
  teamName: string | null;
  partName: string | null;
  membershipLevel: string | null;
  membershipState: string | null;
};

type ExperienceDraftDto = {
  id: string;
  weekId: string;
  organizationSlug: string;
  teamId: string | null;
  teamName: string | null;
  partName: string | null;
  targetUserId: string;
  targetUserName: string | null;
  experienceLineMasterId: string;
  lineCode: string;
  lineName: string | null;
  mainTitle: string;
  outputLink1: string | null;
  outputLink2: string | null;
  outputLinks: Cluster4OutputLink[];
  // outputImages 와 index 정렬 일치하는 캡션. 캡션 없으면 null.
  outputImages: string[];
  outputImageCaptions: (string | null)[];
  rating: number | null;
  memo: string | null;
  inputStatus: "draft" | "submitted";
  reviewStatus: "pending" | "approved" | "rejected";
  openStatus: "pending" | "opened";
  rejectionReason: string | null;
  enteredBy: string | null;
  enteredAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  openedBy: string | null;
  openedAt: string | null;
  openedLineId: string | null;
  createdAt: string;
  updatedAt: string;
};

type WorkflowSummary = {
  weekId: string;
  totalDrafts: number;
  draftCount: number;
  submittedCount: number;
  approvedCount: number;
  rejectedCount: number;
  openedCount: number;
};

type UploadedImage = { url: string; name: string };

type TabKey = "masters" | "input" | "review" | "open";

// [임시] 실무 경험 라인 관리 4탭(라인 등록/입력 관리/검수 관리/최종 개설)의 본문 콘텐츠를
// 전부 숨긴다. 탭 버튼 UI 와 클릭 동작은 유지되며, 탭 아래 렌더만 비활성화된다.
// mode(test/operating)·org 무관, 분기 없이 동일 적용. 복구 시 false 로 변경.
const TEMP_HIDE_EXPERIENCE_TAB_CONTENT = true;

// ──────────────────────────────────────────────────────────────
// Date formatting (KST locale, 12-hour clock with day-of-week)
// ──────────────────────────────────────────────────────────────

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

function fmtDateWithDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${DAY_NAMES[d.getDay()]})`;
}

function fmtDateTimeWithDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let h = d.getHours();
  const min = d.getMinutes();
  const ampm = h < 12 ? "오전" : "오후";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  const minStr = String(min).padStart(2, "0");
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${DAY_NAMES[d.getDay()]}) ${ampm} ${h}:${minStr}`;
}

function urlToImage(url: string): UploadedImage {
  const name = url.split("/").pop()?.split("?")[0] ?? "image";
  return { url, name };
}

// ──────────────────────────────────────────────────────────────
// Image Upload Slot
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
  caption?: string;
  onUpload: (img: UploadedImage) => void;
  onRemove: () => void;
  // 제공 시 캡션 입력 UI 노출 (draft output_images 전용). 미제공 시 캡션 미노출.
  onCaptionChange?: (caption: string) => void;
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
          {!disabled && (
            <Button variant="ghost" size="icon" className="shrink-0" onClick={onRemove}>
              <Trash2 className="h-4 w-4 text-red-500" />
            </Button>
          )}
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
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {uploading ? "업로드 중..." : "이미지 업로드"}
          </Button>
        </div>
      )}
      {/* 이미지 캡션 — 업로드 전/후 항상 노출. 이미지 없으면 payload 미포함. 비우면 null 저장. */}
      {onCaptionChange && (
        <Input
          value={caption ?? ""}
          onChange={(e) => onCaptionChange(e.target.value)}
          placeholder="이미지 캡션을 입력하세요"
          aria-label={`${label} 캡션`}
          maxLength={OUTPUT_IMAGE_CAPTION_MAX_LENGTH}
          disabled={disabled}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Tab Button / Summary Card / Status Badge
// ──────────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "rounded-t-md px-4 py-2 text-sm font-medium transition-colors",
        active
          ? "border-b-2 border-primary bg-background text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SummaryCard({
  title,
  count,
  variant = "default",
}: {
  title: string;
  count: number;
  variant?: "default" | "warning" | "success" | "error" | "info";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 text-center",
        variant === "warning" && "border-yellow-200 bg-yellow-50",
        variant === "success" && "border-green-200 bg-green-50",
        variant === "error" && "border-red-200 bg-red-50",
        variant === "info" && "border-blue-200 bg-blue-50",
        variant === "default" && "border-border bg-muted",
      )}
    >
      <p
        className={cn(
          "text-2xl font-bold",
          variant === "warning" && "text-yellow-800",
          variant === "success" && "text-green-800",
          variant === "error" && "text-red-800",
          variant === "info" && "text-blue-800",
          variant === "default" && "text-foreground",
        )}
      >
        {count}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{title}</p>
    </div>
  );
}

function InputStatusBadge({ value }: { value: "draft" | "submitted" }) {
  if (value === "draft") {
    return (
      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        임시저장
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
      제출완료
    </span>
  );
}

function ReviewStatusBadge({ value }: { value: "pending" | "approved" | "rejected" }) {
  if (value === "pending") {
    return (
      <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
        검수 대기
      </span>
    );
  }
  if (value === "approved") {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
        승인
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
      반려
    </span>
  );
}

function OpenStatusBadge({ value }: { value: "pending" | "opened" }) {
  if (value === "pending") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
        개설 대기
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
      개설완료
    </span>
  );
}

// 대상 주차 선택 — dev 모드(?dev=true) 전용. 일반 모드에서는 렌더하지 않으며,
// selectedWeekId 는 정책 주차(현재 주차)로 고정된다. 실무 정보(info) 와 동일 UX.
function DevWeekSelector({
  weekOptions,
  value,
  onChange,
}: {
  weekOptions: WeekOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (weekOptions.length === 0) return null;
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">
        대상 주차 <span className="text-amber-600">(dev)</span>
      </Label>
      <select
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">주차를 선택해주세요</option>
        {weekOptions.map((w) => (
          <option key={w.id} value={w.id} disabled={!w.canOpen}>
            {w.label} ({w.startDate} ~ {w.endDate})
            {w.isCurrent ? " · 현재" : ""}
            {!w.canOpen ? " · 휴식" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────────────────────

export default function PracticalExperienceManager() {
  // dev 모드(?dev=true): 주차 선택 UI 노출 + 과거 주차 검수/개설 허용 (테스트용).
  // 일반 모드: 주차 선택 UI 미렌더 + 정책 주차(현재 주차) 강제. 실무 정보(info) 와 동일 정책.
  const devMode = useAdminDevMode();
  const confirm = useConfirm();

  // 헤더 [라인 관리]/[라인 개설] 2탭은 **조직 분기 모드(?org 있음)** 에서만 적용한다 (실무 정보와 동일 UX).
  // 통합 검수 시스템(원본, ?org 없음)에서는 기존 단일 화면 그대로 — 헤더 탭/분기 없음.
  // 탭 UI 자체는 상단 Header title 영역(components/admin/Header.tsx)에 있고,
  // 본문은 URL ?tab 으로 어느 콘텐츠를 보일지만 결정한다 — 실무 정보(PracticalInfoManager)와 동일.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const orgScoped = readOrgParam(searchParams) != null;
  const mainTab: "manage" | "open" =
    orgScoped && searchParams?.get("tab") === "open" ? "open" : "manage";

  const [activeTab, setActiveTab] = useState<TabKey>("input");
  const [adminOrg, setAdminOrg] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [masters, setMasters] = useState<LineMasterItem[]>([]);
  const [currentWeek, setCurrentWeek] = useState<CurrentWeekData | null>(null);
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  const [crews, setCrews] = useState<CrewItem[]>([]);
  const [drafts, setDrafts] = useState<ExperienceDraftDto[]>([]);
  const [summary, setSummary] = useState<WorkflowSummary | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  // ── Master form state ──
  const [masterFormOpen, setMasterFormOpen] = useState(false);
  const [editingMasterId, setEditingMasterId] = useState<string | null>(null);
  const [mfOrgSlug, setMfOrgSlug] = useState("");
  const [mfLineCode, setMfLineCode] = useState("");
  const [mfLineName, setMfLineName] = useState("");
  const [mfDefaultTitle, setMfDefaultTitle] = useState("");
  const [mfTeamId, setMfTeamId] = useState("");
  const [mfSourceFile, setMfSourceFile] = useState("");

  // ── Draft form state (Input tab) ──
  const [draftFormOpen, setDraftFormOpen] = useState(false);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [dfTargetUserId, setDfTargetUserId] = useState("");
  const [dfMasterId, setDfMasterId] = useState("");
  const [dfLink1, setDfLink1] = useState("");
  const [dfLabel1, setDfLabel1] = useState("");
  const [dfLink2, setDfLink2] = useState("");
  const [dfLabel2, setDfLabel2] = useState("");
  const [dfImage1, setDfImage1] = useState<UploadedImage | null>(null);
  const [dfImage2, setDfImage2] = useState<UploadedImage | null>(null);
  // 이미지 캡션 — 이미지와 분리된 독립 state (업로드 전에도 입력 가능).
  const [dfCaption1, setDfCaption1] = useState("");
  const [dfCaption2, setDfCaption2] = useState("");
  const [dfRating, setDfRating] = useState<string>("");
  const [dfMemo, setDfMemo] = useState("");

  // ── Input tab filters ──
  const [inputFilterTeam, setInputFilterTeam] = useState("");
  const [inputFilterPart, setInputFilterPart] = useState("");
  const [inputFilterStatus, setInputFilterStatus] = useState("");
  const [inputFilterOrg, setInputFilterOrg] = useState("");
  const [inputSearch, setInputSearch] = useState("");
  const [inputLineSearch, setInputLineSearch] = useState("");

  // ── Review tab state ──
  const [reviewingDraftId, setReviewingDraftId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [reviewFilterStatus, setReviewFilterStatus] = useState("pending");

  // ── Open tab state ──
  const [openSelectedIds, setOpenSelectedIds] = useState<Set<string>>(new Set());
  // [라인 개설] 탭 상태창/로그창 갱신 신호 — 팀 총괄 검수/완료/취소·파트장 신청/취소 직후 증가.
  const [openRefresh, setOpenRefresh] = useState(0);
  // 개설된 experience line target 목록 (target 기반, ?detailed=1). draft 워크플로우와 독립.
  const [expLines, setExpLines] = useState<Cluster4LineDetail[]>([]);
  const [expLinesLoading, setExpLinesLoading] = useState(false);
  const [expLinesError, setExpLinesError] = useState<string | null>(null);
  const [expEnhancementFilter, setExpEnhancementFilter] =
    useState<EnhancementFilter>("all");

  // 개설된 experience 라인 목록 조회 (draft/검수/개설 로직과 완전 분리 — 읽기 전용).
  const fetchExperienceLines = useCallback(async () => {
    setExpLinesLoading(true);
    setExpLinesError(null);
    try {
      // 조직 컨텍스트(?org)를 organization 으로 변환 — 조직 모드면 (해당 조직 OR 공통) 라인만.
      const qs = new URLSearchParams({
        partType: "experience",
        detailed: "1",
        limit: "500",
      });
      const org = readOrgParam(new URLSearchParams(window.location.search));
      if (org) qs.set("organization", org);
      const res = await fetch(`/api/admin/cluster4/lines?${qs.toString()}`);
      const json = await res.json();
      if (json.success) {
        setExpLines(json.data.rows ?? []);
      } else {
        setExpLines([]);
        setExpLinesError(json.error ?? "개설 라인 목록을 불러오지 못했습니다");
      }
    } catch (e) {
      console.error("[experience open] detailed lines fetch failed", e);
      setExpLines([]);
      setExpLinesError("개설 라인 목록을 불러오지 못했습니다");
    } finally {
      setExpLinesLoading(false);
    }
  }, []);

  // 최종개설 탭에 진입할 때마다 최신 개설 라인을 다시 불러온다 (개설 직후 갱신 포함).
  useEffect(() => {
    if (activeTab !== "open") return;
    void (async () => {
      await fetchExperienceLines();
    })();
  }, [activeTab, fetchExperienceLines]);

  // 라인 × 대상자 평면화 — 각 line target 1행. 강화 상태 필터는 대상자 단위로 적용.
  const expTargetRows = useMemo(() => {
    const out: Array<{
      key: string;
      weekLabel: string | null;
      lineName: string;
      lineCode: string | null;
      target: Cluster4LineDetail["targets"][number];
    }> = [];
    for (const line of expLines) {
      for (const t of line.targets) {
        if (!matchesEnhancementFilter(expEnhancementFilter, t.enhancementStatus))
          continue;
        out.push({
          key: t.lineTargetId,
          weekLabel: line.weekLabel,
          lineName: line.mainTitle,
          lineCode: line.lineCode,
          target: t,
        });
      }
    }
    return out;
  }, [expLines, expEnhancementFilter]);

  // ──────────────────────────────────────────────────────────────
  // Computed
  // ──────────────────────────────────────────────────────────────

  const activeMasters = useMemo(() => masters.filter((m) => m.isActive), [masters]);

  const uniqueParts = useMemo(() => {
    const set = new Set<string>();
    for (const c of crews) if (c.partName) set.add(c.partName);
    for (const d of drafts) if (d.partName) set.add(d.partName);
    return Array.from(set).sort();
  }, [crews, drafts]);

  const uniqueOrgs = useMemo(() => {
    const set = new Set<string>();
    for (const d of drafts) if (d.organizationSlug) set.add(d.organizationSlug);
    return Array.from(set).sort();
  }, [drafts]);

  const editingDraft = useMemo(
    () => (editingDraftId ? drafts.find((d) => d.id === editingDraftId) ?? null : null),
    [drafts, editingDraftId],
  );

  const reviewingDraft = useMemo(
    () => (reviewingDraftId ? drafts.find((d) => d.id === reviewingDraftId) ?? null : null),
    [drafts, reviewingDraftId],
  );

  const selectedDraftMaster = useMemo(
    () => masters.find((m) => m.id === dfMasterId) ?? null,
    [masters, dfMasterId],
  );

  // Output asset count (links + images, max 2)
  const dfAssetCount = useMemo(() => {
    let c = 0;
    if (dfLink1.trim()) c++;
    if (dfLink2.trim()) c++;
    if (dfImage1) c++;
    if (dfImage2) c++;
    return c;
  }, [dfLink1, dfLink2, dfImage1, dfImage2]);

  const draftReadonly = useMemo(() => {
    if (!editingDraft) return false;
    return (
      editingDraft.reviewStatus === "approved" || editingDraft.openStatus === "opened"
    );
  }, [editingDraft]);

  // Filter helpers ────────────────────────────────────────────

  const inputDrafts = useMemo(() => {
    return drafts.filter((d) => {
      if (d.openStatus === "opened") return false;
      if (inputFilterOrg && d.organizationSlug !== inputFilterOrg) return false;
      if (inputFilterTeam && d.teamName !== inputFilterTeam) return false;
      if (inputFilterPart && d.partName !== inputFilterPart) return false;
      if (inputFilterStatus === "draft" && d.inputStatus !== "draft") return false;
      if (
        inputFilterStatus === "submitted" &&
        !(d.inputStatus === "submitted" && d.reviewStatus === "pending")
      )
        return false;
      if (inputFilterStatus === "approved" && d.reviewStatus !== "approved") return false;
      if (inputFilterStatus === "rejected" && d.reviewStatus !== "rejected") return false;
      if (inputSearch.trim()) {
        const q = inputSearch.trim().toLowerCase();
        if (!d.targetUserName?.toLowerCase().includes(q)) return false;
      }
      if (inputLineSearch.trim()) {
        const q = inputLineSearch.trim().toLowerCase();
        const hay = `${d.lineName ?? ""} ${d.lineCode ?? ""} ${d.mainTitle ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    drafts,
    inputFilterOrg,
    inputFilterTeam,
    inputFilterPart,
    inputFilterStatus,
    inputSearch,
    inputLineSearch,
  ]);

  const reviewDrafts = useMemo(() => {
    return drafts.filter((d) => {
      if (d.openStatus === "opened") return false;
      if (d.inputStatus !== "submitted") return false;
      if (reviewFilterStatus === "pending" && d.reviewStatus !== "pending") return false;
      if (reviewFilterStatus === "approved" && d.reviewStatus !== "approved") return false;
      if (reviewFilterStatus === "rejected" && d.reviewStatus !== "rejected") return false;
      return true;
    });
  }, [drafts, reviewFilterStatus]);

  const openDrafts = useMemo(() => {
    return drafts.filter(
      (d) => d.reviewStatus === "approved" || d.openStatus === "opened",
    );
  }, [drafts]);

  // Input tab summary counts ──────────────────────────────────
  const inputCounts = useMemo(() => {
    const usersWithDrafts = new Set(drafts.map((d) => d.targetUserId));
    const totalUserCount = crews.length;
    const noInput = Math.max(0, totalUserCount - usersWithDrafts.size);
    return {
      noInput,
      drafted: summary?.draftCount ?? 0,
      submitted: summary?.submittedCount ?? 0,
      rejected: summary?.rejectedCount ?? 0,
    };
  }, [drafts, crews, summary]);

  // ──────────────────────────────────────────────────────────────
  // 주차 결정 (week_id SoT)
  // ──────────────────────────────────────────────────────────────

  // 운영 정책 주차(현재 주차). 일반 모드에서 강제 사용하는 주차.
  const policyWeekId = useMemo(
    () => weekOptions.find((w) => w.isCurrent)?.id ?? currentWeek?.weekId ?? "",
    [weekOptions, currentWeek],
  );

  // 실제 사용 주차.
  //   - dev 모드: 사용자가 고른 주차(미선택 시 정책 주차 폴백).
  //   - 일반 모드: 항상 정책 주차 — selectedWeekId 의 dev 잔여값이 새지 않도록 강제.
  const activeWeekId = devMode ? selectedWeekId || policyWeekId : policyWeekId;

  // ──────────────────────────────────────────────────────────────
  // Data fetching
  // ──────────────────────────────────────────────────────────────

  const fetchInitialData = useCallback(async () => {
    setLoading(true);
    try {
      const [orgRes, weekRes, weeksRes] = await Promise.all([
        fetch("/api/admin/cluster4/admin-org"),
        fetch("/api/admin/cluster4/current-week"),
        fetch(
          appendModeQuery(
            "/api/admin/cluster4/weeks-options?limit=3",
            readScopeMode(new URLSearchParams(window.location.search)),
          ),
        ),
      ]);

      const orgJson = await orgRes.json();
      const org = orgJson.success ? orgJson.data.organization : null;
      setAdminOrg(org);

      const weekJson = await weekRes.json();
      const week = weekJson.success ? weekJson.data : null;
      setCurrentWeek(week);

      const weeksJson = await weeksRes.json();
      let initialWeekId: string | null = null;
      if (weeksJson.success) {
        const opts: WeekOption[] = weeksJson.data.weeks ?? [];
        setWeekOptions(opts);
        const current = opts.find((o) => o.isCurrent) ?? opts[0];
        if (current) initialWeekId = current.id;
      }
      const effectiveWeekId = selectedWeekId || initialWeekId || week?.weekId || null;
      if (initialWeekId && !selectedWeekId) setSelectedWeekId(initialWeekId);

      const orgParam = org ? `?organization=${org}` : "";
      // 팀 목록 스코프(operating=운영 팀만 / test=(T) 팀만) — URL ?mode 보존(서버 listTeams 가 filterTeamsByScope 적용).
      const scopeMode = readScopeMode(new URLSearchParams(window.location.search));
      const [teamsRes, mastersRes, crewsRes] = await Promise.all([
        fetch(appendModeQuery(`/api/admin/cluster4/teams${orgParam}`, scopeMode)),
        // 라인 등록 데이터는 조직별 권한 분리 전 단계라 전체 조직을 조회한다.
        fetch(`/api/admin/cluster4/experience-line-masters`),
        fetch(
          `/api/admin/cluster4/crews${orgParam ? orgParam + "&" : "?"}status=active`,
        ),
      ]);

      const teamsJson = await teamsRes.json();
      if (teamsJson.success) setTeams(teamsJson.data);

      const mastersJson = await mastersRes.json();
      if (mastersJson.success) setMasters(mastersJson.data);

      const crewsJson = await crewsRes.json();
      if (crewsJson.success) setCrews(crewsJson.data);

      if (effectiveWeekId) {
        const params = new URLSearchParams();
        params.set("week_id", effectiveWeekId);
        if (org) params.set("organization", org);
        const [draftsRes, summaryRes] = await Promise.all([
          fetch(`/api/admin/cluster4/experience-drafts?${params}`),
          fetch(`/api/admin/cluster4/experience-workflow-summary?${params}`),
        ]);
        const draftsJson = await draftsRes.json();
        if (draftsJson.success) setDrafts(draftsJson.data);
        const summaryJson = await summaryRes.json();
        if (summaryJson.success) setSummary(summaryJson.data);
      }
    } catch (error) {
      console.error("Failed to fetch data", error);
      setBanner({ kind: "error", message: "데이터를 불러오는데 실패했습니다" });
    } finally {
      setLoading(false);
    }
  }, []);

  const refetchDrafts = useCallback(async () => {
    const targetWeekId = activeWeekId || currentWeek?.weekId || null;
    if (!targetWeekId) return;
    setRefreshing(true);
    try {
      const params = new URLSearchParams();
      params.set("week_id", targetWeekId);
      if (adminOrg) params.set("organization", adminOrg);
      const [draftsRes, summaryRes] = await Promise.all([
        fetch(`/api/admin/cluster4/experience-drafts?${params}`),
        fetch(`/api/admin/cluster4/experience-workflow-summary?${params}`),
      ]);
      const draftsJson = await draftsRes.json();
      if (draftsJson.success) setDrafts(draftsJson.data);
      const summaryJson = await summaryRes.json();
      if (summaryJson.success) setSummary(summaryJson.data);
    } catch (error) {
      console.error("Failed to refetch drafts", error);
    } finally {
      setRefreshing(false);
    }
  }, [currentWeek, adminOrg, activeWeekId]);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  // 사용 주차가 바뀌면 drafts/summary 재조회 — 초기 fetch 와 중복되지 않도록 loading 가드.
  useEffect(() => {
    if (!loading && activeWeekId) {
      refetchDrafts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWeekId]);

  // ──────────────────────────────────────────────────────────────
  // Master form handlers
  // ──────────────────────────────────────────────────────────────

  const resetMasterForm = useCallback(() => {
    setMfOrgSlug("");
    setMfLineCode("");
    setMfLineName("");
    setMfDefaultTitle("");
    setMfTeamId("");
    setMfSourceFile("");
    setEditingMasterId(null);
    setMasterFormOpen(false);
  }, []);

  const openEditMaster = useCallback((m: LineMasterItem) => {
    setEditingMasterId(m.id);
    setMfOrgSlug(m.organizationSlug ?? "");
    setMfLineCode(m.lineCode);
    setMfLineName(m.lineName);
    setMfDefaultTitle(m.mainTitle ?? "");
    setMfTeamId(m.teamId ?? "");
    setMfSourceFile(m.sourceFileName ?? "");
    setMasterFormOpen(true);
  }, []);

  const handleSaveMaster = useCallback(async () => {
    const orgSlug = (mfOrgSlug || adminOrg || "").trim();
    if (!orgSlug) {
      setBanner({ kind: "error", message: "조직은 필수입니다" });
      return;
    }
    if (!mfLineCode.trim() || !mfLineName.trim()) {
      setBanner({ kind: "error", message: "라인 코드와 라인명은 필수입니다" });
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = {
        organization_slug: orgSlug,
        line_code: mfLineCode.trim(),
        line_name: mfLineName.trim(),
        main_title: mfDefaultTitle.trim() || null,
        team_id: mfTeamId || null,
        source_file_name: mfSourceFile.trim() || null,
      };
      const url = editingMasterId
        ? `/api/admin/cluster4/experience-line-masters/${editingMasterId}`
        : "/api/admin/cluster4/experience-line-masters";
      const method = editingMasterId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) {
        setBanner({ kind: "error", message: json.error ?? "저장 실패" });
        return;
      }
      setBanner({
        kind: "success",
        message: editingMasterId
          ? "라인이 수정되었습니다"
          : "라인이 등록되었습니다",
      });
      resetMasterForm();
      await fetchInitialData();
    } catch {
      setBanner({ kind: "error", message: "저장 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [
    mfOrgSlug,
    mfLineCode,
    mfLineName,
    mfDefaultTitle,
    mfTeamId,
    mfSourceFile,
    editingMasterId,
    adminOrg,
    resetMasterForm,
    fetchInitialData,
  ]);

  const handleDeleteMaster = useCallback(
    async (id: string) => {
      if (!(await confirm({ ...CONFIRM.delete, description: "이 라인을 삭제하시겠습니까?" }))) return;
      try {
        const res = await fetch(`/api/admin/cluster4/experience-line-masters/${id}`, {
          method: "DELETE",
        });
        const json = await res.json();
        if (!json.success) {
          setBanner({ kind: "error", message: json.error ?? "삭제 실패" });
          return;
        }
        setBanner({ kind: "success", message: "삭제되었습니다" });
        await fetchInitialData();
      } catch {
        setBanner({ kind: "error", message: "삭제 중 오류가 발생했습니다" });
      }
    },
    [fetchInitialData, confirm],
  );

  // ──────────────────────────────────────────────────────────────
  // Draft form handlers (Input tab)
  // ──────────────────────────────────────────────────────────────

  const resetDraftForm = useCallback(() => {
    setEditingDraftId(null);
    setDfTargetUserId("");
    setDfMasterId("");
    setDfLink1("");
    setDfLabel1("");
    setDfLink2("");
    setDfLabel2("");
    setDfImage1(null);
    setDfImage2(null);
    setDfCaption1("");
    setDfCaption2("");
    setDfRating("");
    setDfMemo("");
    setDraftFormOpen(false);
  }, []);

  const openNewDraft = useCallback(() => {
    resetDraftForm();
    setDraftFormOpen(true);
  }, [resetDraftForm]);

  const openEditDraft = useCallback((d: ExperienceDraftDto) => {
    setEditingDraftId(d.id);
    setDfTargetUserId(d.targetUserId);
    setDfMasterId(d.experienceLineMasterId);
    // output_links 우선 prefill (DTO 가 이미 jsonb→legacy fallback 해석). 슬롯 순서 보존.
    setDfLink1(d.outputLinks[0]?.url ?? d.outputLink1 ?? "");
    setDfLabel1(d.outputLinks[0]?.label ?? "");
    setDfLink2(d.outputLinks[1]?.url ?? d.outputLink2 ?? "");
    setDfLabel2(d.outputLinks[1]?.label ?? "");
    setDfImage1(d.outputImages[0] ? urlToImage(d.outputImages[0]) : null);
    setDfImage2(d.outputImages[1] ? urlToImage(d.outputImages[1]) : null);
    setDfCaption1(d.outputImageCaptions?.[0] ?? "");
    setDfCaption2(d.outputImageCaptions?.[1] ?? "");
    setDfRating(d.rating !== null ? String(d.rating) : "");
    setDfMemo(d.memo ?? "");
    setDraftFormOpen(true);
  }, []);

  const saveDraft = useCallback(
    async (asSubmit: boolean) => {
      // PATCH 경로 (editingDraftId 있음) 는 draft 의 기존 week_id 를 그대로 유지하므로
      // selectedWeekId 검증을 생략한다. POST (신규 작성) 경로에서만 weekId 가 필요하다.
      const isPatch = Boolean(editingDraftId);
      // POST 신규 작성만 week_id 필요. activeWeekId 가 일반 모드=정책 주차 / dev=선택 주차를
      // 이미 강제하므로, 일반 모드에서 dev 선택 잔여값이 payload 에 새지 않는다.
      const targetWeekId = isPatch
        ? null
        : activeWeekId || currentWeek?.weekId || null;
      if (!isPatch && !targetWeekId) {
        setBanner({ kind: "error", message: devMode ? "주차를 선택해주세요" : "현재 주차 정보를 확인할 수 없습니다" });
        return;
      }
      if (!editingDraftId && !dfTargetUserId) {
        setBanner({ kind: "error", message: "대상 사용자를 선택해주세요" });
        return;
      }
      if (!dfMasterId) {
        setBanner({ kind: "error", message: "라인을 선택해주세요" });
        return;
      }
      if (asSubmit) {
        if (dfAssetCount < 1) {
          setBanner({ kind: "error", message: "Output을 최소 1개 입력해주세요" });
          return;
        }
        if (dfAssetCount > 2) {
          setBanner({ kind: "error", message: "Output은 최대 2개까지 입력 가능합니다" });
          return;
        }
        if (dfRating === "") {
          setBanner({ kind: "error", message: "제출 시 평점은 필수입니다" });
          return;
        }
      }
      if (dfAssetCount > 2) {
        setBanner({ kind: "error", message: "Output은 최대 2개까지 입력 가능합니다" });
        return;
      }

      const master = selectedDraftMaster;
      if (!master) {
        setBanner({ kind: "error", message: "유효하지 않은 라인입니다" });
        return;
      }

      const built = buildOutputLinksFromForm([
        { url: dfLink1, label: dfLabel1 },
        { url: dfLink2, label: dfLabel2 },
      ]);
      if (!built.ok) {
        setBanner({ kind: "error", message: built.error });
        return;
      }
      const outputLinks = built.value;

      // output_images = [{url, caption}] — 이미지 있는 항목만 포함. 캡션 비우면 null.
      const outputImages: { url: string; caption: string | null }[] = [];
      for (const [img, cap] of [
        [dfImage1, dfCaption1],
        [dfImage2, dfCaption2],
      ] as const) {
        if (!img) continue;
        outputImages.push({
          url: img.url,
          caption: cap.trim() ? cap.trim() : null,
        });
      }
      const rating = dfRating === "" ? null : Number(dfRating);

      setSaving(true);
      setBanner(null);
      try {
        if (editingDraftId) {
          const patch: Record<string, unknown> = {
            experience_line_master_id: dfMasterId,
            line_code: master.lineCode,
            main_title: master.mainTitle ?? master.lineName,
            // output_links 우선 + 레거시 컬럼 backward-compat mirror.
            output_links: outputLinks,
            output_link_1: outputLinks[0]?.url ?? null,
            output_link_2: outputLinks[1]?.url ?? null,
            output_images: outputImages,
            rating,
            memo: dfMemo.trim() || null,
            input_status: asSubmit ? "submitted" : "draft",
          };
          const res = await fetch(
            `/api/admin/cluster4/experience-drafts/${editingDraftId}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            },
          );
          const json = await res.json();
          if (!json.success) {
            setBanner({ kind: "error", message: json.error ?? "저장 실패" });
            return;
          }
          setBanner({
            kind: "success",
            message: asSubmit ? "제출되었습니다" : "임시 저장되었습니다",
          });
        } else {
          const crew = crews.find((c) => c.userId === dfTargetUserId);
          const team = teams.find((t) => t.teamName === crew?.teamName);
          const payload = {
            week_id: targetWeekId,
            organization_slug: adminOrg ?? "oranke",
            team_id: team?.id ?? null,
            part_name: crew?.partName ?? null,
            target_user_id: dfTargetUserId,
            experience_line_master_id: dfMasterId,
            line_code: master.lineCode,
            main_title: master.mainTitle ?? master.lineName,
            // output_links 우선 + 레거시 컬럼 backward-compat mirror.
            output_links: outputLinks,
            output_link_1: outputLinks[0]?.url ?? null,
            output_link_2: outputLinks[1]?.url ?? null,
            output_images: outputImages,
            rating,
            memo: dfMemo.trim() || null,
            input_status: asSubmit ? "submitted" : "draft",
          };
          console.log("[experience draft create payload]", {
            selectedWeekId,
            selectedWeekOption: weekOptions.find((w) => w.id === selectedWeekId) ?? null,
            body: payload,
          });
          const res = await fetch("/api/admin/cluster4/experience-drafts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const json = await res.json();
          if (!json.success) {
            setBanner({ kind: "error", message: json.error ?? "저장 실패" });
            return;
          }
          setBanner({
            kind: "success",
            message: asSubmit ? "제출되었습니다" : "임시 저장되었습니다",
          });
        }
        resetDraftForm();
        await refetchDrafts();
      } catch {
        setBanner({ kind: "error", message: "저장 중 오류가 발생했습니다" });
      } finally {
        setSaving(false);
      }
    },
    [
      currentWeek,
      devMode,
      activeWeekId,
      selectedWeekId,
      weekOptions,
      editingDraftId,
      dfTargetUserId,
      dfMasterId,
      dfAssetCount,
      dfRating,
      selectedDraftMaster,
      dfImage1,
      dfImage2,
      dfCaption1,
      dfCaption2,
      dfLink1,
      dfLabel1,
      dfLink2,
      dfLabel2,
      dfMemo,
      crews,
      teams,
      adminOrg,
      resetDraftForm,
      refetchDrafts,
    ],
  );

  // ──────────────────────────────────────────────────────────────
  // Review handlers
  // ──────────────────────────────────────────────────────────────

  const openReviewDetail = useCallback((d: ExperienceDraftDto) => {
    setReviewingDraftId(d.id);
    setRejectionReason(d.rejectionReason ?? "");
  }, []);

  const closeReviewDetail = useCallback(() => {
    setReviewingDraftId(null);
    setRejectionReason("");
  }, []);

  const submitReview = useCallback(
    async (decision: "approved" | "rejected") => {
      if (!reviewingDraftId) return;
      if (decision === "rejected" && !rejectionReason.trim()) {
        setBanner({ kind: "error", message: "반려 시 사유는 필수입니다" });
        return;
      }
      setSaving(true);
      setBanner(null);
      try {
        const res = await fetch(
          `/api/admin/cluster4/experience-drafts/${reviewingDraftId}/review`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              review_status: decision,
              rejection_reason: decision === "rejected" ? rejectionReason.trim() : null,
            }),
          },
        );
        const json = await res.json();
        if (!json.success) {
          setBanner({ kind: "error", message: json.error ?? "검수 실패" });
          return;
        }
        setBanner({
          kind: "success",
          message: decision === "approved" ? "승인되었습니다" : "반려되었습니다",
        });
        closeReviewDetail();
        await refetchDrafts();
      } catch {
        setBanner({ kind: "error", message: "검수 중 오류가 발생했습니다" });
      } finally {
        setSaving(false);
      }
    },
    [reviewingDraftId, rejectionReason, closeReviewDetail, refetchDrafts],
  );

  // ──────────────────────────────────────────────────────────────
  // Open handlers
  // ──────────────────────────────────────────────────────────────

  const toggleOpenSelect = useCallback((id: string) => {
    setOpenSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleOpenDrafts = useCallback(async () => {
    if (openSelectedIds.size === 0) return;
    if (!(await confirm({ ...CONFIRM.complete, description: `선택한 ${openSelectedIds.size}건을 최종 개설하시겠습니까?`, confirmLabel: "최종 개설" }))) return;
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/cluster4/experience-drafts/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft_ids: Array.from(openSelectedIds) }),
      });
      const json = await res.json();
      if (!json.success) {
        setBanner({ kind: "error", message: json.error ?? "개설 실패" });
        return;
      }
      const data = json.data;
      const warnings: string[] = json.warnings ?? data?.warnings ?? [];
      let msg = `${data.openedCount}건 개설 완료 (라인 ${data.linesCreated}개, 대상 ${data.targetsCreated}명, 평가 ${data.evaluationsCreated}건)`;
      if (warnings.length > 0) {
        msg += ` · 경고 ${warnings.length}건: ${warnings.join(" / ")}`;
      }
      setBanner({ kind: warnings.length > 0 ? "error" : "success", message: msg });
      setOpenSelectedIds(new Set());
      await refetchDrafts();
    } catch {
      setBanner({ kind: "error", message: "개설 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [openSelectedIds, refetchDrafts, confirm]);

  // ──────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const weekAvailable = !!currentWeek?.weekId;

  // 실무경험 성장 상태 동기화 (success → fail 단방향). 서버 sync 가 DB SoT 를 확정한다.
  //
  // 개발자 모드 기준 (devMode = ?dev=true):
  //   - devMode=ON  → 서버가 scope 를 강제로 test 로 (테스트 사용자 %T% 만, 실사용자 보호).
  //   - devMode=OFF → 운영 모드. scope="all"(실사용자 포함)은 dry-run → confirm=true 흐름 필수.
  type SyncAllData = {
    usersScanned: number;
    usersFlipped: number;
    totalFlippedToFail: number;
    dryRun?: boolean;
  };

  const postSync = async (body: {
    devMode: boolean;
    scope: "test" | "all";
    confirm?: boolean;
  }) => {
    const res = await fetch("/api/admin/sync/experience-growth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as {
      success: boolean;
      error?: string;
      scope?: "test" | "all";
      dryRun?: boolean;
      data?: SyncAllData;
    };
  };

  const handleSyncExperienceGrowth = async (scope: "test" | "all") => {
    setSyncing(true);
    setBanner(null);
    try {
      // 운영 전체(실사용자 포함): devMode=OFF + scope=all → 1) dry-run 으로 영향 범위 확인.
      if (scope === "all" && !devMode) {
        const dry = await postSync({ devMode, scope: "all", confirm: false });
        if (!dry.success || !dry.data) {
          setBanner({ kind: "error", message: dry.error ?? "dry-run 실패" });
          return;
        }
        const d = dry.data;
        const ok = await confirm({
          ...CONFIRM.save,
          description: `운영 전체 동기화 — dry-run 결과\n\n대상 ${d.usersScanned}명 중 ${d.usersFlipped}명, ${d.totalFlippedToFail}개 주차가 성장(실패)로 변경됩니다.\n실사용자가 포함되며 되돌리기 어렵습니다.\n\n실제로 DB에 반영하시겠습니까?`,
        });
        if (!ok) {
          setBanner({
            kind: "success",
            message: `[dry-run · 미반영] 운영 전체 예상 변경 — 대상 ${d.usersScanned}명 중 ${d.usersFlipped}명, ${d.totalFlippedToFail}개 주차 (DB 변경 없음).`,
          });
          return;
        }
        // 2) confirm=true → 실제 반영.
        const real = await postSync({ devMode, scope: "all", confirm: true });
        if (!real.success || !real.data) {
          setBanner({ kind: "error", message: real.error ?? "동기화 실패" });
          return;
        }
        const r = real.data;
        setBanner({
          kind: "success",
          message: `[운영 전체 · 반영 완료] 대상 ${r.usersScanned}명 중 ${r.usersFlipped}명, ${r.totalFlippedToFail}개 주차를 성장(실패)로 반영했습니다.`,
        });
        return;
      }

      // 테스트 sync (devMode 무관, 서버가 test 로 처리). devMode=ON 에서 scope=all 도 서버가 test 강제.
      const json = await postSync({ devMode, scope });
      if (!json.success || !json.data) {
        setBanner({ kind: "error", message: json.error ?? "동기화 실패" });
        return;
      }
      const d = json.data;
      const label =
        json.scope === "all" ? "[운영 전체]" : "[테스트 사용자]";
      const dryNote = json.dryRun ? " (dry-run · DB 미반영)" : "";
      setBanner({
        kind: "success",
        message: `${label} 실무경험 성장 상태 동기화 완료${dryNote} — 대상 ${d.usersScanned}명 중 ${d.usersFlipped}명, ${d.totalFlippedToFail}개 주차.`,
      });
    } catch {
      setBanner({ kind: "error", message: "동기화 중 오류가 발생했습니다" });
    } finally {
      setSyncing(false);
    }
  };

  return (
    // 본문 폭: 조직 분기 모드(?org)에서는 전체 폭 사용(섹션0/섹션1 동일 기준 — practical-info 미러).
    // 통합 모드(?org 없음)에서는 기존 폭(max-w-[1440px] 가운데 정렬) 유지.
    <div
      className={cn(
        "space-y-6",
        orgScoped
          ? "w-full min-w-0"
          : "mx-auto w-full max-w-[1440px] px-4 py-6",
      )}
    >
      <AdminPageHeader
        title="실무 경험 라인"
        description="허브와 라인 · 라인 관리 / 라인 개설"
        tabs={
          orgScoped
            ? buildLineOpeningTabs(pathname, searchParams, mainTab)
            : undefined
        }
      />

      <div className="flex items-center justify-end gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleSyncExperienceGrowth("test")}
            disabled={syncing}
            title="테스트 계정만 대상으로 성장 상태 동기화 (성공→실패 단방향)"
          >
            {syncing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            성장 동기화(테스트)
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => handleSyncExperienceGrowth("all")}
            disabled={syncing || devMode}
            title={
              devMode
                ? "개발자 모드(ON)에서는 운영 전체 동기화가 비활성화됩니다. ?dev=true 를 끄면 dry-run→confirm 흐름으로 사용할 수 있습니다."
                : "운영 전체(실사용자 포함). dry-run 후 confirm 시 반영 — success→fail 단방향, 되돌리기 주의"
            }
          >
            전체 동기화(운영)
          </Button>
        </div>
      </div>

      {banner && (
        <div
          className={cn(
            "whitespace-pre-wrap rounded-md border px-4 py-3 text-sm",
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

      {/* 헤더 2탭(라인 관리/라인 개설)은 상단 Header title 영역으로 이동 — 본문에는 두지 않는다.
          [라인 관리] = 기존 실무 경험 워크플로우 화면(아래 내부 탭 4종) 그대로. */}
      {mainTab === "manage" && (
        <>
      {/* 카드형 팀 요약 보드(표시 전용) — 팀별 개설 완료/필요·파트 신청 색칸·라인별 강화 결과.
          조직 분기 모드(?org)에서만 노출. 개설 완료/취소 직후 openRefresh 로 갱신. */}
      {orgScoped && (
        <ExperienceLineManageBoard refreshKey={openRefresh} />
      )}

      {/* [임시] 탭 strip + 탭 아래 본문 콘텐츠 전부 숨김 — TEMP_HIDE_EXPERIENCE_TAB_CONTENT 가드. */}
      {!TEMP_HIDE_EXPERIENCE_TAB_CONTENT && (
        <>
      {/* Tabs */}
      <div className="flex gap-1 border-b">
        <TabButton
          label="라인 등록"
          active={activeTab === "masters"}
          onClick={() => setActiveTab("masters")}
        />
        <TabButton
          label="입력 관리"
          active={activeTab === "input"}
          onClick={() => setActiveTab("input")}
        />
        <TabButton
          label="검수 관리"
          active={activeTab === "review"}
          onClick={() => setActiveTab("review")}
        />
        <TabButton
          label="최종 개설"
          active={activeTab === "open"}
          onClick={() => setActiveTab("open")}
        />
      </div>

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab: 라인 등록 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "masters" && (
        <div className="space-y-4">
          {/* 2E-2 drift 가드 안내 — 신규 생성/삭제는 API 에서 차단되며 통합 등록 경로로 유도된다. */}
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="font-semibold">[Deprecated · read-mirror]</span> 이 목록은 통합 등록(line_registrations) 기준으로
            제공되며 읽기 전용입니다. 신규 등록은{" "}
            <a href="/admin/lines/register" className="font-semibold underline underline-offset-2">통합 라인 등록</a>
            , 수정/비활성은{" "}
            <a href="/admin/lines/info" className="font-semibold underline underline-offset-2">라인 정보</a>
            의 &quot;수정&quot;을 사용하세요.
          </div>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">라인 등록</CardTitle>
                  <CardDescription>
                    등록된 라인 {masters.length}개
                  </CardDescription>
                </div>
{/* (2E-6) 신규 생성 버튼 제거 — 통합 라인 등록 경로로 일원화 */}
              </div>
            </CardHeader>
            <CardContent>
              {masters.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  등록된 라인이 없습니다
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>조직</TableHead>
                      <TableHead>라인 코드</TableHead>
                      <TableHead>유형/슬롯</TableHead>
                      <TableHead>라인명</TableHead>
                      <TableHead>메인 타이틀</TableHead>
                      <TableHead>팀</TableHead>
                      <TableHead className="text-center">활성</TableHead>
                      <TableHead className="w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {masters.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs">{formatOrgLabel(m.organizationSlug)}</TableCell>
                        <TableCell className="font-mono text-xs">{m.lineCode}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {formatExperienceSlotLabel(m.experienceCategory, m.experienceSlotOrder)}
                        </TableCell>
                        <TableCell className="font-medium">{m.lineName}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {m.mainTitle ?? "-"}
                        </TableCell>
                        <TableCell>{m.teamName ?? "-"}</TableCell>
                        <TableCell className="text-center">
                          {m.isActive ? (
                            <Check className="mx-auto h-4 w-4 text-green-600" />
                          ) : (
                            <X className="mx-auto h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell>
                          {/* (2E-6) read-mirror — 편집/삭제는 라인 정보(/admin/lines/info)의 수정으로 일원화 */}
                          <a
                            href="/admin/lines/info"
                            className="text-xs text-sky-700 underline underline-offset-2 hover:text-sky-900"
                            title="라인 정보에서 수정"
                          >
                            라인 정보에서 수정
                          </a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {masterFormOpen && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  {editingMasterId ? "라인 등록 수정" : "새 라인 등록"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>
                    조직 <span className="text-red-500">*</span>
                  </Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={mfOrgSlug}
                    onChange={(e) => setMfOrgSlug(e.target.value)}
                  >
                    <option value="">조직을 선택하세요</option>
                    {ORG_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>
                      라인 코드 <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      value={mfLineCode}
                      onChange={(e) => setMfLineCode(e.target.value)}
                      placeholder="EXEC-EN0001"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>
                      라인명 <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      value={mfLineName}
                      onChange={(e) => setMfLineName(e.target.value)}
                      placeholder="[기획] 엔터테인먼트/미디어 콘텐츠 제작"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>메인 타이틀</Label>
                  <Input
                    value={mfDefaultTitle}
                    onChange={(e) => setMfDefaultTitle(e.target.value)}
                    placeholder="메인 타이틀을 입력하세요"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>팀</Label>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={mfTeamId}
                      onChange={(e) => setMfTeamId(e.target.value)}
                    >
                      <option value="">팀 선택 안함</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.teamName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>원본 파일명</Label>
                    <Input
                      value={mfSourceFile}
                      onChange={(e) => setMfSourceFile(e.target.value)}
                      placeholder="source.xlsx"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <Button variant="outline" onClick={resetMasterForm} disabled={saving}>
                    취소
                  </Button>
                  <Button onClick={handleSaveMaster} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {editingMasterId ? "수정" : "저장"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab: 입력 관리 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "input" && (
        <div className="space-y-4">
          {/* Week selector + info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">대상 주차</CardTitle>
              <CardDescription>운영 기본값은 현재 주차이며, 테스트/검증 목적으로 직전 주차도 선택할 수 있습니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {/* 주차 선택은 dev 모드에서만 노출. 일반 모드는 정책 주차(현재 주차) 자동 사용. */}
              {devMode && (
                <DevWeekSelector
                  weekOptions={weekOptions}
                  value={selectedWeekId}
                  onChange={setSelectedWeekId}
                />
              )}
              {currentWeek ? (
                <>
                  <p>
                    <span className="font-medium">
                      {currentWeek.year} {currentWeek.seasonName} W{currentWeek.weekNumber}
                    </span>{" "}
                    ({fmtDateWithDay(currentWeek.startDate)} ~{" "}
                    {fmtDateWithDay(currentWeek.endDate)})
                  </p>
                  <p className="text-muted-foreground">
                    입력 권장 마감: 월요일 오후 2:00
                  </p>
                  {!weekAvailable && (
                    <p className="font-medium text-orange-600">
                      현재 주차 데이터가 없습니다
                    </p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">주차 정보를 불러올 수 없습니다</p>
              )}
            </CardContent>
          </Card>

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard title="미입력" count={inputCounts.noInput} variant="default" />
            <SummaryCard title="임시저장" count={inputCounts.drafted} variant="info" />
            <SummaryCard
              title="제출완료"
              count={inputCounts.submitted}
              variant="success"
            />
            <SummaryCard title="반려" count={inputCounts.rejected} variant="error" />
          </div>

          {/* Filters */}
          <Card>
            <CardContent className="py-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {uniqueOrgs.length > 0 && (
                  <select
                    className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    value={inputFilterOrg}
                    onChange={(e) => setInputFilterOrg(e.target.value)}
                  >
                    <option value="">전체 조직</option>
                    {uniqueOrgs.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  value={inputFilterTeam}
                  onChange={(e) => setInputFilterTeam(e.target.value)}
                >
                  <option value="">전체 팀</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.teamName}>
                      {t.teamName}
                    </option>
                  ))}
                </select>
                <select
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  value={inputFilterPart}
                  onChange={(e) => setInputFilterPart(e.target.value)}
                >
                  <option value="">전체 파트</option>
                  {uniqueParts.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <select
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  value={inputFilterStatus}
                  onChange={(e) => setInputFilterStatus(e.target.value)}
                >
                  <option value="">전체 상태</option>
                  <option value="draft">임시저장</option>
                  <option value="submitted">제출완료</option>
                  <option value="approved">승인</option>
                  <option value="rejected">반려</option>
                </select>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="대상자 검색..."
                    value={inputSearch}
                    onChange={(e) => setInputSearch(e.target.value)}
                  />
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="라인명 검색..."
                    value={inputLineSearch}
                    onChange={(e) => setInputLineSearch(e.target.value)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Draft list */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Draft 목록 ({inputDrafts.length}건)
                </CardTitle>
                {weekAvailable && !draftFormOpen && (
                  <Button size="sm" onClick={openNewDraft}>
                    <Plus className="mr-1 h-4 w-4" /> 새 입력
                  </Button>
                )}
                {refreshing && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!weekAvailable ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  현재 주차 데이터가 없습니다
                </p>
              ) : inputDrafts.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  표시할 항목이 없습니다
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>사용자명</TableHead>
                      <TableHead>팀</TableHead>
                      <TableHead>파트</TableHead>
                      <TableHead>라인</TableHead>
                      <TableHead className="text-center">평점</TableHead>
                      <TableHead>입력</TableHead>
                      <TableHead>검수</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inputDrafts.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">
                          {d.targetUserName ?? "-"}
                        </TableCell>
                        <TableCell>{d.teamName ?? "-"}</TableCell>
                        <TableCell>{d.partName ?? "-"}</TableCell>
                        <TableCell>
                          <div>
                            <p className="font-medium">{d.lineName ?? d.lineCode}</p>
                            <p className="font-mono text-xs text-muted-foreground">
                              {d.lineCode}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          {d.rating !== null ? `${d.rating}/10` : "-"}
                        </TableCell>
                        <TableCell>
                          <InputStatusBadge value={d.inputStatus} />
                        </TableCell>
                        <TableCell>
                          <ReviewStatusBadge value={d.reviewStatus} />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => openEditDraft(d)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Draft form */}
          {draftFormOpen && weekAvailable && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {editingDraftId
                    ? draftReadonly
                      ? "Draft 조회 (수정 불가)"
                      : "Draft 수정"
                    : "새 Draft 입력"}
                </CardTitle>
                {editingDraft?.rejectionReason && (
                  <CardDescription className="text-red-600">
                    반려 사유: {editingDraft.rejectionReason}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Target user */}
                <div className="space-y-2">
                  <Label>
                    대상 사용자 <span className="text-red-500">*</span>
                  </Label>
                  {editingDraftId ? (
                    <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                      {editingDraft?.targetUserName ?? "-"}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {[editingDraft?.teamName, editingDraft?.partName]
                          .filter(Boolean)
                          .join(" / ")}
                      </span>
                    </div>
                  ) : (
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={dfTargetUserId}
                      onChange={(e) => setDfTargetUserId(e.target.value)}
                      disabled={saving}
                    >
                      <option value="">사용자를 선택해주세요</option>
                      {teams.map((team) => {
                        const teamCrews = crews.filter((c) => c.teamName === team.teamName);
                        if (teamCrews.length === 0) return null;
                        return (
                          <optgroup key={team.id} label={team.teamName}>
                            {teamCrews.map((c) => (
                              <option key={c.userId} value={c.userId}>
                                {c.displayName}
                                {c.partName ? ` (${c.partName})` : ""}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                      {(() => {
                        const noTeam = crews.filter(
                          (c) => !c.teamName || !teams.some((t) => t.teamName === c.teamName),
                        );
                        if (noTeam.length === 0) return null;
                        return (
                          <optgroup label="(팀 미지정)">
                            {noTeam.map((c) => (
                              <option key={c.userId} value={c.userId}>
                                {c.displayName}
                                {c.partName ? ` (${c.partName})` : ""}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })()}
                    </select>
                  )}
                </div>

                {/* Master selection */}
                <div className="space-y-2">
                  <Label>
                    라인 <span className="text-red-500">*</span>
                  </Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={dfMasterId}
                    onChange={(e) => setDfMasterId(e.target.value)}
                    disabled={saving || draftReadonly}
                  >
                    <option value="">라인을 선택해주세요</option>
                    {activeMasters.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.lineName}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Auto-populated fields */}
                {selectedDraftMaster && (
                  <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                    <div>
                      <Label className="text-xs text-muted-foreground">라인 코드</Label>
                      <p className="font-mono">{selectedDraftMaster.lineCode}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">메인 타이틀</Label>
                      <p>
                        {selectedDraftMaster.mainTitle ?? selectedDraftMaster.lineName}
                      </p>
                    </div>
                  </div>
                )}

                {/* Output assets */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>
                      Output <span className="text-red-500">*</span>
                    </Label>
                    <span
                      className={cn(
                        "text-xs",
                        dfAssetCount === 0
                          ? "text-red-500"
                          : dfAssetCount <= 2
                            ? "text-green-600"
                            : "text-red-500",
                      )}
                    >
                      {dfAssetCount}/2 (최소 1, 최대 2)
                    </span>
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Output Link 1 URL</Label>
                      <Input
                        value={dfLink1}
                        onChange={(e) => setDfLink1(e.target.value)}
                        placeholder={OUTPUT_LINK_URL_PLACEHOLDER}
                        disabled={
                          saving ||
                          draftReadonly ||
                          (!dfLink1.trim() && dfAssetCount >= 2)
                        }
                      />
                      <Input
                        value={dfLabel1}
                        onChange={(e) => setDfLabel1(e.target.value)}
                        placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER}
                        aria-label="Link 1 설명"
                        maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH}
                        disabled={saving || draftReadonly}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Output Link 2 URL</Label>
                      <Input
                        value={dfLink2}
                        onChange={(e) => setDfLink2(e.target.value)}
                        placeholder={OUTPUT_LINK_URL_PLACEHOLDER}
                        disabled={
                          saving ||
                          draftReadonly ||
                          (!dfLink2.trim() && dfAssetCount >= 2)
                        }
                      />
                      <Input
                        value={dfLabel2}
                        onChange={(e) => setDfLabel2(e.target.value)}
                        placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER}
                        aria-label="Link 2 설명"
                        maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH}
                        disabled={saving || draftReadonly}
                      />
                    </div>
                    <ImageUploadSlot
                      label="Output Image 1"
                      image={dfImage1}
                      caption={dfCaption1}
                      onUpload={setDfImage1}
                      onRemove={() => { setDfImage1(null); setDfCaption1(""); }}
                      onCaptionChange={setDfCaption1}
                      disabled={
                        saving || draftReadonly || (!dfImage1 && dfAssetCount >= 2)
                      }
                    />
                    <ImageUploadSlot
                      label="Output Image 2"
                      image={dfImage2}
                      caption={dfCaption2}
                      onUpload={setDfImage2}
                      onRemove={() => { setDfImage2(null); setDfCaption2(""); }}
                      onCaptionChange={setDfCaption2}
                      disabled={
                        saving || draftReadonly || (!dfImage2 && dfAssetCount >= 2)
                      }
                    />
                  </div>
                </div>

                {/* Rating */}
                <div className="space-y-2">
                  <Label>
                    평점 (0~10) <span className="text-red-500">*</span>
                  </Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={dfRating}
                    onChange={(e) => setDfRating(e.target.value)}
                    disabled={saving || draftReadonly}
                  >
                    <option value="">선택해주세요</option>
                    {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Memo */}
                <div className="space-y-2">
                  <Label>메모 (선택)</Label>
                  <textarea
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    rows={3}
                    value={dfMemo}
                    onChange={(e) => setDfMemo(e.target.value)}
                    placeholder="추가 메모를 입력하세요"
                    disabled={saving || draftReadonly}
                  />
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-3 pt-2">
                  <Button variant="outline" onClick={resetDraftForm} disabled={saving}>
                    취소
                  </Button>
                  {!draftReadonly && (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => saveDraft(false)}
                        disabled={saving}
                      >
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        임시 저장
                      </Button>
                      <Button onClick={() => saveDraft(true)} disabled={saving}>
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        제출
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab: 검수 관리 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "review" && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">현재 주차</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {currentWeek && (
                <p>
                  <span className="font-medium">
                    {currentWeek.year} {currentWeek.seasonName} W{currentWeek.weekNumber}
                  </span>{" "}
                  ({fmtDateWithDay(currentWeek.startDate)} ~{" "}
                  {fmtDateWithDay(currentWeek.endDate)})
                </p>
              )}
              <p className="text-muted-foreground">검수 권장 마감: 월요일 오후 8:00</p>
              {/* dev 모드 전용: 검수 대상 주차 override (과거 주차 검수 허용). */}
              {devMode && (
                <DevWeekSelector
                  weekOptions={weekOptions}
                  value={selectedWeekId}
                  onChange={setSelectedWeekId}
                />
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-3 gap-3">
            <SummaryCard
              title="검수 대기"
              count={summary?.submittedCount ?? 0}
              variant="warning"
            />
            <SummaryCard
              title="승인"
              count={(summary?.approvedCount ?? 0) + (summary?.openedCount ?? 0)}
              variant="success"
            />
            <SummaryCard title="반려" count={summary?.rejectedCount ?? 0} variant="error" />
          </div>

          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-2">
                <Label className="text-sm">상태 필터:</Label>
                <select
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  value={reviewFilterStatus}
                  onChange={(e) => setReviewFilterStatus(e.target.value)}
                >
                  <option value="pending">검수 대기</option>
                  <option value="approved">승인</option>
                  <option value="rejected">반려</option>
                  <option value="all">전체</option>
                </select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">검수 목록 ({reviewDrafts.length}건)</CardTitle>
                {refreshing && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!weekAvailable ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  현재 주차 데이터가 없습니다
                </p>
              ) : reviewDrafts.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  검수할 항목이 없습니다
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>사용자명</TableHead>
                      <TableHead>팀</TableHead>
                      <TableHead>파트</TableHead>
                      <TableHead>라인</TableHead>
                      <TableHead className="text-center">평점</TableHead>
                      <TableHead>입력 시간</TableHead>
                      <TableHead>검수</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reviewDrafts.map((d) => (
                      <TableRow
                        key={d.id}
                        className={cn(reviewingDraftId === d.id && "bg-muted/40")}
                      >
                        <TableCell className="font-medium">
                          {d.targetUserName ?? "-"}
                        </TableCell>
                        <TableCell>{d.teamName ?? "-"}</TableCell>
                        <TableCell>{d.partName ?? "-"}</TableCell>
                        <TableCell>
                          <div>
                            <p className="font-medium">{d.lineName ?? d.lineCode}</p>
                            <p className="font-mono text-xs text-muted-foreground">
                              {d.lineCode}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          {d.rating !== null ? `${d.rating}/10` : "-"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {d.enteredAt ? fmtDateTimeWithDay(d.enteredAt) : "-"}
                        </TableCell>
                        <TableCell>
                          <ReviewStatusBadge value={d.reviewStatus} />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => openReviewDetail(d)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Review detail panel */}
          {reviewingDraft && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">검수 상세</CardTitle>
                    <CardDescription>
                      {reviewingDraft.targetUserName} ·{" "}
                      {[reviewingDraft.teamName, reviewingDraft.partName]
                        .filter(Boolean)
                        .join(" / ")}
                    </CardDescription>
                  </div>
                  <Button variant="ghost" size="icon" onClick={closeReviewDetail}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Line info */}
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="font-medium">{reviewingDraft.lineName ?? "-"}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {reviewingDraft.lineCode}
                  </p>
                  <p className="mt-2">
                    <span className="text-xs text-muted-foreground">메인 타이틀: </span>
                    {reviewingDraft.mainTitle}
                  </p>
                </div>

                {/* Outputs */}
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Output</Label>
                  <div className="space-y-2">
                    {reviewingDraft.outputLink1 && (
                      <a
                        href={reviewingDraft.outputLink1}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 rounded-md border p-2 text-sm hover:bg-muted"
                      >
                        <ExternalLink className="h-4 w-4 text-blue-600" />
                        <span className="truncate">{reviewingDraft.outputLink1}</span>
                      </a>
                    )}
                    {reviewingDraft.outputLink2 && (
                      <a
                        href={reviewingDraft.outputLink2}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 rounded-md border p-2 text-sm hover:bg-muted"
                      >
                        <ExternalLink className="h-4 w-4 text-blue-600" />
                        <span className="truncate">{reviewingDraft.outputLink2}</span>
                      </a>
                    )}
                    {reviewingDraft.outputImages.map((url, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 rounded-md border p-2"
                      >
                        <img
                          src={url}
                          alt={`output ${i + 1}`}
                          className="h-16 w-16 shrink-0 rounded object-cover"
                        />
                        <p className="truncate text-xs text-muted-foreground">{url}</p>
                      </div>
                    ))}
                    {!reviewingDraft.outputLink1 &&
                      !reviewingDraft.outputLink2 &&
                      reviewingDraft.outputImages.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          Output 정보가 없습니다
                        </p>
                      )}
                  </div>
                </div>

                {/* Rating */}
                <div>
                  <Label className="text-xs text-muted-foreground">평점</Label>
                  <p className="text-lg font-semibold">
                    {reviewingDraft.rating !== null ? `${reviewingDraft.rating}/10` : "-"}
                  </p>
                </div>

                {/* Memo */}
                <div>
                  <Label className="text-xs text-muted-foreground">메모</Label>
                  <p className="whitespace-pre-wrap text-sm">
                    {reviewingDraft.memo || "-"}
                  </p>
                </div>

                {/* Rejection reason input */}
                {reviewingDraft.reviewStatus === "pending" && (
                  <div className="space-y-2">
                    <Label>반려 사유 (반려 시 필수)</Label>
                    <textarea
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      rows={3}
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      placeholder="반려 사유를 입력하세요"
                      disabled={saving}
                    />
                  </div>
                )}

                {reviewingDraft.reviewStatus === "rejected" &&
                  reviewingDraft.rejectionReason && (
                    <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm">
                      <Label className="text-xs text-red-700">기존 반려 사유</Label>
                      <p className="text-red-800">{reviewingDraft.rejectionReason}</p>
                    </div>
                  )}

                {/* Action buttons */}
                {reviewingDraft.reviewStatus === "pending" && (
                  <div className="flex justify-end gap-3 pt-2">
                    <Button
                      variant="outline"
                      className="border-red-300 text-red-700 hover:bg-red-50"
                      onClick={() => submitReview("rejected")}
                      disabled={saving}
                    >
                      {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      <XCircle className="mr-1 h-4 w-4" /> 반려
                    </Button>
                    <Button
                      className="bg-green-600 hover:bg-green-700"
                      onClick={() => submitReview("approved")}
                      disabled={saving}
                    >
                      {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      <CheckCircle2 className="mr-1 h-4 w-4" /> 승인
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab: 최종 개설 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "open" && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">현재 주차</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {currentWeek && (
                <p>
                  <span className="font-medium">
                    {currentWeek.year} {currentWeek.seasonName} W{currentWeek.weekNumber}
                  </span>{" "}
                  ({fmtDateWithDay(currentWeek.startDate)} ~{" "}
                  {fmtDateWithDay(currentWeek.endDate)})
                </p>
              )}
              <p className="text-muted-foreground">
                라인 개설 권장 마감: 월요일 오후 10:00
              </p>
              {currentWeek?.canOpen && currentWeek.submissionClosesAt && (
                <p className="text-xs text-muted-foreground">
                  실제 기입 마감: {fmtDateTimeWithDay(currentWeek.submissionClosesAt)}
                </p>
              )}
              {/* dev 모드 전용: 개설 대상 주차 override (과거 주차 개설 허용).
                  open payload 는 draft_ids 만 전송하며, 서버가 각 draft.week_id 로 개설한다. */}
              {devMode && (
                <DevWeekSelector
                  weekOptions={weekOptions}
                  value={selectedWeekId}
                  onChange={setSelectedWeekId}
                />
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard
              title="승인 완료"
              count={(summary?.approvedCount ?? 0) + (summary?.openedCount ?? 0)}
              variant="success"
            />
            <SummaryCard
              title="개설 대기"
              count={summary?.approvedCount ?? 0}
              variant="warning"
            />
            <SummaryCard
              title="개설 완료"
              count={summary?.openedCount ?? 0}
              variant="info"
            />
            <SummaryCard
              title="미검수 경고"
              count={summary?.submittedCount ?? 0}
              variant="error"
            />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  최종 개설 목록 ({openDrafts.length}건)
                </CardTitle>
                <div className="flex items-center gap-2">
                  {refreshing && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                  <Button
                    size="sm"
                    onClick={handleOpenDrafts}
                    disabled={saving || openSelectedIds.size === 0}
                  >
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    선택 일괄 개설 ({openSelectedIds.size}건)
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {!weekAvailable ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  현재 주차 데이터가 없습니다
                </p>
              ) : openDrafts.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  개설할 항목이 없습니다 (검수 승인 완료 시 표시됩니다)
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead>사용자명</TableHead>
                      <TableHead>팀</TableHead>
                      <TableHead>파트</TableHead>
                      <TableHead>라인</TableHead>
                      <TableHead className="text-center">평점</TableHead>
                      <TableHead>검수일시</TableHead>
                      <TableHead>개설 상태</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {openDrafts.map((d) => {
                      const opened = d.openStatus === "opened";
                      return (
                        <TableRow key={d.id} className={cn(opened && "opacity-70")}>
                          <TableCell>
                            <input
                              type="checkbox"
                              className="rounded border-input"
                              checked={openSelectedIds.has(d.id)}
                              disabled={opened || saving}
                              onChange={() => toggleOpenSelect(d.id)}
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            {d.targetUserName ?? "-"}
                          </TableCell>
                          <TableCell>{d.teamName ?? "-"}</TableCell>
                          <TableCell>{d.partName ?? "-"}</TableCell>
                          <TableCell>
                            <div>
                              <p className="font-medium">{d.lineName ?? d.lineCode}</p>
                              <p className="font-mono text-xs text-muted-foreground">
                                {d.lineCode}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="text-center">
                            {d.rating !== null ? `${d.rating}/10` : "-"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {d.reviewedAt ? fmtDateTimeWithDay(d.reviewedAt) : "-"}
                          </TableCell>
                          <TableCell>
                            <OpenStatusBadge value={d.openStatus} />
                            {opened && d.openedLineId && (
                              <p
                                className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                                title={d.openedLineId}
                              >
                                line: {d.openedLineId.slice(0, 8)}…
                              </p>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* 개설된 경험 라인 목록 — target 기반(?detailed=1). 강화/기입 상태 표시 (읽기 전용). */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">
                    개설된 경험 라인 목록 ({expTargetRows.length}건)
                  </CardTitle>
                  <CardDescription>
                    개설 완료된 라인의 대상자별 강화 상태 · 라인칸 기입 상태 (서버 계산값)
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    value={expEnhancementFilter}
                    onChange={(e) =>
                      setExpEnhancementFilter(e.target.value as EnhancementFilter)
                    }
                  >
                    {ENHANCEMENT_FILTER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void fetchExperienceLines()}
                    disabled={expLinesLoading}
                  >
                    {expLinesLoading && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    새로고침
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {expLinesError ? (
                <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {expLinesError}
                </p>
              ) : expLinesLoading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : expTargetRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {expLines.length === 0
                    ? "개설된 경험 라인이 없습니다."
                    : "필터 결과가 없습니다."}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap">주차</TableHead>
                        <TableHead>경험 라인명</TableHead>
                        <TableHead>대상자</TableHead>
                        <TableHead className="text-center">라인칸 기입 상태</TableHead>
                        <TableHead className="text-center">강화 상태</TableHead>
                        {devMode && (
                          <>
                            <TableHead className="font-mono text-[11px]">
                              submissionStatus
                            </TableHead>
                            <TableHead className="font-mono text-[11px]">
                              enhancementStatus
                            </TableHead>
                            <TableHead className="font-mono text-[11px]">
                              enhancementReason
                            </TableHead>
                            <TableHead className="font-mono text-[11px]">
                              lineTargetId
                            </TableHead>
                          </>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {expTargetRows.map((r) => (
                        <TableRow key={r.key}>
                          <TableCell className="whitespace-nowrap text-xs">
                            {r.weekLabel ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-[220px]">
                            <div className="truncate font-medium">{r.lineName}</div>
                            {r.lineCode && (
                              <div className="truncate font-mono text-[10px] text-muted-foreground">
                                {r.lineCode}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="font-medium">
                            {r.target.displayName}
                          </TableCell>
                          <TableCell className="text-center">
                            <SubmissionStatusBadge status={r.target.submissionStatus} />
                          </TableCell>
                          <TableCell className="text-center">
                            <EnhancementStatusBadge
                              status={r.target.enhancementStatus}
                              reason={r.target.enhancementReason}
                            />
                          </TableCell>
                          {devMode && (
                            <>
                              <TableCell className="font-mono text-[11px] text-muted-foreground">
                                {r.target.submissionStatus}
                              </TableCell>
                              <TableCell className="font-mono text-[11px] text-muted-foreground">
                                {r.target.enhancementStatus}
                              </TableCell>
                              <TableCell className="font-mono text-[11px] text-muted-foreground">
                                {r.target.enhancementReason}
                              </TableCell>
                              <TableCell className="font-mono text-[10px] text-muted-foreground">
                                <span className="block max-w-[140px] truncate" title={r.target.lineTargetId}>
                                  {r.target.lineTargetId}
                                </span>
                              </TableCell>
                            </>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
        </>
      )}
        </>
      )}

      {/* [라인 개설] 탭 — 실무 경험 라인 개설 운영 대시보드(상태창).
          오늘/이번 주 + 지난 주(개설 대상) 확장 기간 + 팀별 개설 현황을 표시한다.
          공용 엔진/컴포넌트(LineOpeningStatusBoard) 재사용 — 표시 전용(DB/snapshot/DTO 무관).
          개설 워크플로우(입력→검수→최종 개설)는 [라인 관리] 내부 탭에서 진행한다. */}
      {mainTab === "open" && (
        <div className="space-y-4">
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <LineOpeningStatusBoard hub="experience" refreshKey={openRefresh} />
            <ExperienceOpeningLogPanel refreshKey={openRefresh} />
          </div>
          {/* 파트장 입력 그리드 + 팀 총괄 보드 (additive — 신규 전용 저장, 기존 워크플로우/snapshot 무관).
              검수/완료/취소·신청/취소 직후 상태창·로그창을 갱신한다. */}
          <ExperiencePartLeadInput onActivity={() => setOpenRefresh((k) => k + 1)} />
        </div>
      )}
    </div>
  );
}
