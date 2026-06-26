"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Search,
  Check,
  X,
  Upload,
  Trash2,
  Pencil,
} from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";
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
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import Cluster4LineTable from "@/components/admin/cluster4/Cluster4LineTable";
import CareerEvaluationTab from "@/components/admin/cluster4/CareerEvaluationTab";
import {
  buildOutputLinksFromForm,
  OUTPUT_LINK_LABEL_PLACEHOLDER,
  OUTPUT_LINK_URL_PLACEHOLDER,
  OUTPUT_LINK_LABEL_MAX_LENGTH,
} from "@/lib/cluster4OutputLinks";
import { OUTPUT_IMAGE_CAPTION_MAX_LENGTH } from "@/lib/cluster4OutputImages";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

type Banner = { kind: "success" | "error"; message: string } | null;

type TeamItem = {
  id: string;
  teamName: string;
  organizationSlug: string;
  isActive: boolean;
};

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

type CareerProjectOption = {
  id: string;
  lineCode: string;
  lineName: string | null;
  // 기업명 SoT = career_projects.company_name.
  companyName: string | null;
  // companyLogoUrl 는 업로드된 이미지 URL (URL input 값 아님).
  companyLogoUrl: string | null;
  // sponsor-card 감독자 메타 6필드 — weekly-cards DTO 와 동일.
  supervisorName: string | null;
  supervisorDepartment: string | null;
  supervisorPosition: string | null;
  supervisorPhotoUrl: string | null;
  defaultMainTitle: string | null;
  defaultOutputLink1: string | null;
  defaultOutputLink2: string | null;
  defaultOutputImages: string[];
  defaultTargetUserIds: string[];
  startDate: string | null;
  endDate: string | null;
};

type CurrentWeekData = {
  weekId: string;
  weekNumber: number;
  weekStart: string;
  weekEnd: string;
  submissionOpensAt: string;
  submissionClosesAt: string;
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
  isOpenTarget?: boolean; // 개설 대상 주차(금요일 경계; 테스트 휴식꼬리=W13).
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

type CareerProjectDto = {
  id: string;
  lineCode: string | null;
  lineName: string | null;
  // 기업명 SoT = career_projects.company_name. (supervisor_company 는 sponsor-card 표시에 미사용)
  companyName: string | null;
  companyLogoUrl: string | null;
  supervisorName: string | null;
  supervisorDepartment: string | null;
  supervisorPosition: string | null;
  supervisorProfileImg: string | null;
  startDate: string | null;
  endDate: string | null;
  defaultMainTitle: string | null;
  defaultOutputLink1: string | null;
  defaultOutputLink2: string | null;
  defaultOutputImages: string[];
  defaultTargetUserIds: string[];
  organizationSlug: string;
  createdAt: string;
};

type ExistingLineDto = {
  id: string;
  lineCode: string | null;
  mainTitle: string;
  outputLink1: string | null;
  outputLink2: string | null;
  outputImages: string[];
  submissionOpensAt: string;
  submissionClosesAt: string;
  isActive: boolean;
  targetCount: number;
  submissionCount: number;
  createdAt: string;
};

type UploadedImage = {
  url: string;
  name: string;
};

type TabKey = "registration" | "opening" | "evaluation";

// ──────────────────────────────────────────────────────────────
// Date formatting
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

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
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
  caption?: string;
  onUpload: (img: UploadedImage) => void;
  onRemove: () => void;
  // 제공 시 캡션 입력 UI 노출 (라인 개설 output_images 전용). 미제공 시 캡션 미노출.
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
          <Button variant="ghost" size="icon" className="shrink-0" onClick={onRemove}>
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
// Logo Upload Field (단일 URL 문자열 ↔ 이미지 업로드)
// company_logo_url(text) 그대로 저장. 캡션 없음.
// ──────────────────────────────────────────────────────────────

function LogoUploadField({
  value,
  onChange,
  onRemove,
  disabled,
  label = "기업 로고",
  required = true,
  altText = "기업 로고",
  emptyButtonLabel = "로고 이미지 업로드",
}: {
  value: string;
  onChange: (url: string) => void;
  onRemove: () => void;
  disabled?: boolean;
  // 동일 업로드 패턴을 기업 로고 / 감독자 사진에서 공용으로 쓰기 위한 라벨 커스터마이즈.
  label?: string;
  required?: boolean;
  altText?: string;
  emptyButtonLabel?: string;
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
      <Label>{label} {required && <span className="text-red-500">*</span>}</Label>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled || uploading}
      />
      {value ? (
        <div className="flex items-center gap-3 rounded-md border p-2">
          <img
            src={value}
            alt={altText}
            className="h-12 w-12 shrink-0 rounded object-cover"
          />
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
          loading={uploading}
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="mr-2 h-4 w-4" />
          {emptyButtonLabel}
        </Button>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Tab Button
// ──────────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={cn(
        "rounded-t-md px-4 py-2 text-sm font-medium transition-colors",
        active
          ? "border-b-2 border-primary bg-background text-primary"
          : "text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────────────────────

export default function PracticalCareerManager() {
  const [activeTab, setActiveTab] = useState<TabKey>("registration");
  const [adminOrg, setAdminOrg] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [crews, setCrews] = useState<CrewItem[]>([]);
  const [projects, setProjects] = useState<CareerProjectDto[]>([]);
  const [careerOptions, setCareerOptions] = useState<CareerProjectOption[]>([]);
  const [currentWeek, setCurrentWeek] = useState<CurrentWeekData | null>(null);
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  const [existingLines, setExistingLines] = useState<ExistingLineDto[]>([]);
  const [lineRefreshKey, setLineRefreshKey] = useState(0);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  // ── Registration form state ──
  const [regFormOpen, setRegFormOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [rfLineCode, setRfLineCode] = useState("");
  const [rfLineName, setRfLineName] = useState("");
  const [rfStartDate, setRfStartDate] = useState("");
  const [rfEndDate, setRfEndDate] = useState("");
  const [rfCompanyName, setRfCompanyName] = useState("");
  const [rfCompanyLogo, setRfCompanyLogo] = useState("");
  const [rfSupervisorName, setRfSupervisorName] = useState("");
  const [rfSupervisorDepartment, setRfSupervisorDepartment] = useState("");
  const [rfSupervisorPosition, setRfSupervisorPosition] = useState("");
  const [rfSupervisorPhoto, setRfSupervisorPhoto] = useState("");
  const [rfDefaultTitle, setRfDefaultTitle] = useState("");
  const [rfOutputLink1, setRfOutputLink1] = useState("");
  const [rfOutputLink2, setRfOutputLink2] = useState("");
  const [rfOutputImage, setRfOutputImage] = useState<UploadedImage | null>(null);
  const [rfSelectedUserIds, setRfSelectedUserIds] = useState<Set<string>>(new Set());

  // ── Registration crew filters ──
  const [rfCrewFilterTeam, setRfCrewFilterTeam] = useState("");
  const [rfCrewFilterPart, setRfCrewFilterPart] = useState("");
  const [rfCrewFilterLevel, setRfCrewFilterLevel] = useState("");
  const [rfCrewFilterStatus, setRfCrewFilterStatus] = useState("active");
  const [rfCrewSearch, setRfCrewSearch] = useState("");

  // ── Line opening form state ──
  const [lineFormOpen, setLineFormOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [lineMainTitle, setLineMainTitle] = useState("");
  const [lineLink1, setLineLink1] = useState("");
  const [lineLabel1, setLineLabel1] = useState("");
  const [lineLink2, setLineLink2] = useState("");
  const [lineLabel2, setLineLabel2] = useState("");
  const [lineImage1, setLineImage1] = useState<UploadedImage | null>(null);
  const [lineImage2, setLineImage2] = useState<UploadedImage | null>(null);
  // 이미지 캡션 — 이미지와 분리된 독립 state (업로드 전에도 입력 가능).
  const [lineCaption1, setLineCaption1] = useState("");
  const [lineCaption2, setLineCaption2] = useState("");
  const [lineSelectedUserIds, setLineSelectedUserIds] = useState<Set<string>>(new Set());

  // ── 라인 개설 화면의 기업/감독자(sponsor-card) 편집 state ──
  // 선택한 career project 의 현재 6필드를 prefill, 수정 후 개설 시 career_projects 에 PATCH.
  const [loCompanyName, setLoCompanyName] = useState("");
  const [loCompanyLogo, setLoCompanyLogo] = useState("");
  const [loSupervisorName, setLoSupervisorName] = useState("");
  const [loSupervisorDept, setLoSupervisorDept] = useState("");
  const [loSupervisorPos, setLoSupervisorPos] = useState("");
  const [loSupervisorPhoto, setLoSupervisorPhoto] = useState("");

  // ── Line opening crew filters ──
  const [lineCrewFilterTeam, setLineCrewFilterTeam] = useState("");
  const [lineCrewFilterPart, setLineCrewFilterPart] = useState("");
  const [lineCrewFilterLevel, setLineCrewFilterLevel] = useState("");
  const [lineCrewFilterStatus, setLineCrewFilterStatus] = useState("active");
  const [lineCrewSearch, setLineCrewSearch] = useState("");

  // ── Computed: registration ──
  const rfAssetCount = useMemo(() => {
    let count = 0;
    if (rfOutputLink1.trim()) count++;
    if (rfOutputLink2.trim()) count++;
    if (rfOutputImage) count++;
    return count;
  }, [rfOutputLink1, rfOutputLink2, rfOutputImage]);

  const rfUniqueParts = useMemo(() => {
    const set = new Set<string>();
    for (const c of crews) { if (c.partName) set.add(c.partName); }
    return Array.from(set).sort();
  }, [crews]);

  const rfUniqueLevels = useMemo(() => {
    const set = new Set<string>();
    for (const c of crews) { if (c.membershipLevel) set.add(c.membershipLevel); }
    return Array.from(set).sort();
  }, [crews]);

  const rfFilteredCrews = useMemo(() => {
    let result = crews;
    if (rfCrewFilterTeam) result = result.filter((c) => c.teamName === rfCrewFilterTeam);
    if (rfCrewFilterPart) result = result.filter((c) => c.partName === rfCrewFilterPart);
    if (rfCrewFilterLevel) result = result.filter((c) => c.membershipLevel === rfCrewFilterLevel);
    if (rfCrewSearch.trim()) {
      const q = rfCrewSearch.trim().toLowerCase();
      result = result.filter((c) => c.displayName.toLowerCase().includes(q));
    }
    return result;
  }, [crews, rfCrewFilterTeam, rfCrewFilterPart, rfCrewFilterLevel, rfCrewSearch]);

  // ── Computed: line opening ──
  const lineAssetCount = useMemo(() => {
    let count = 0;
    if (lineLink1.trim()) count++;
    if (lineLink2.trim()) count++;
    if (lineImage1) count++;
    if (lineImage2) count++;
    return count;
  }, [lineLink1, lineLink2, lineImage1, lineImage2]);

  const lineAssetValid = lineAssetCount >= 1 && lineAssetCount <= 2;

  const selectedOption = useMemo(
    () => careerOptions.find((o) => o.id === selectedProjectId) ?? null,
    [careerOptions, selectedProjectId],
  );

  const lineFilteredCrews = useMemo(() => {
    let result = crews;
    if (lineCrewFilterTeam) result = result.filter((c) => c.teamName === lineCrewFilterTeam);
    if (lineCrewFilterPart) result = result.filter((c) => c.partName === lineCrewFilterPart);
    if (lineCrewFilterLevel) result = result.filter((c) => c.membershipLevel === lineCrewFilterLevel);
    if (lineCrewSearch.trim()) {
      const q = lineCrewSearch.trim().toLowerCase();
      result = result.filter((c) => c.displayName.toLowerCase().includes(q));
    }
    return result;
  }, [crews, lineCrewFilterTeam, lineCrewFilterPart, lineCrewFilterLevel, lineCrewSearch]);

  // ── Data fetching ──
  const fetchInitialData = useCallback(async () => {
    setLoading(true);
    try {
      const orgRes = await fetch("/api/admin/cluster4/admin-org");
      const orgJson = await orgRes.json();
      const org = orgJson.success ? orgJson.data.organization : null;
      setAdminOrg(org);

      const orgParam = org ? `?organization=${org}` : "";
      // 팀 목록 스코프(operating=운영 팀만 / test=(T) 팀만) — URL ?mode 보존(서버 listTeams 가 filterTeamsByScope 적용).
      const scopeMode = readScopeMode(new URLSearchParams(window.location.search));
      const [teamsRes, projectsRes, optionsRes, linesRes, crewsRes, weeksRes] = await Promise.all([
        fetch(appendModeQuery(`/api/admin/cluster4/teams${orgParam}`, scopeMode)),
        fetch(`/api/admin/career-projects?limit=200`),
        fetch(`/api/admin/cluster4/career-line-options${orgParam}`),
        fetch("/api/admin/cluster4/lines?partType=career&limit=100"),
        fetch(`/api/admin/cluster4/crews${orgParam ? orgParam + "&" : "?"}status=active`),
        // 테스트 모드는 ?mode=test 전달 → 휴식꼬리에서 W13 을 드롭다운에 포함(operating 미부착=불변).
        fetch(appendModeQuery("/api/admin/cluster4/weeks-options?limit=3", scopeMode)),
      ]);

      const teamsJson = await teamsRes.json();
      if (teamsJson.success) setTeams(teamsJson.data);

      // /api/admin/career-projects 응답은 { success, data: { rows, total, ... } } 형태.
      // rows 는 data.rows 에 있다(과거 projectsJson.rows 직접 참조 → 항상 undefined → 목록이 빈 채로 표시되던 버그).
      // career_projects 마스터 목록은 개설(cluster4_lines) 여부와 무관하게 그대로 노출한다.
      const projectsJson = await projectsRes.json();
      if (projectsJson.success && Array.isArray(projectsJson.data?.rows)) {
        setProjects(projectsJson.data.rows);
      }

      const optionsJson = await optionsRes.json();
      if (optionsJson.success) {
        setCareerOptions(optionsJson.data.options);
        setCurrentWeek(optionsJson.data.currentWeek);
      }

      const weeksJson = await weeksRes.json();
      if (weeksJson.success) {
        const opts: WeekOption[] = weeksJson.data.weeks ?? [];
        setWeekOptions(opts);
        // 기본 선택 = 개설 대상(isOpenTarget; 테스트 휴식꼬리=W13) → 현재(N) → 첫 항목.
        const current =
          opts.find((o) => o.isOpenTarget) ??
          opts.find((o) => o.isCurrent) ??
          opts[0];
        if (current) setSelectedWeekId((prev) => prev || current.id);
      }

      const linesJson = await linesRes.json();
      if (linesJson.success) setExistingLines(linesJson.data?.rows ?? linesJson.data ?? []);

      const crewsJson = await crewsRes.json();
      if (crewsJson.success) setCrews(crewsJson.data);
    } catch (error) {
      console.error("Failed to fetch data", error);
      setBanner({ kind: "error", message: "데이터를 불러오는데 실패했습니다" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  const refetchCrews = useCallback(async (status: string) => {
    if (!adminOrg) return;
    try {
      const params = new URLSearchParams();
      params.set("organization", adminOrg);
      if (status) params.set("status", status);
      const res = await fetch(`/api/admin/cluster4/crews?${params}`);
      const json = await res.json();
      if (json.success) setCrews(json.data);
    } catch { /* silent */ }
  }, [adminOrg]);

  useEffect(() => {
    if (!loading) refetchCrews(rfCrewFilterStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfCrewFilterStatus]);

  useEffect(() => {
    if (!loading) refetchCrews(lineCrewFilterStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineCrewFilterStatus]);

  // ── Registration form helpers ──
  const resetRegForm = useCallback(() => {
    setRfLineCode("");
    setRfLineName("");
    setRfStartDate("");
    setRfEndDate("");
    setRfCompanyName("");
    setRfCompanyLogo("");
    setRfSupervisorName("");
    setRfSupervisorDepartment("");
    setRfSupervisorPosition("");
    setRfSupervisorPhoto("");
    setRfDefaultTitle("");
    setRfOutputLink1("");
    setRfOutputLink2("");
    setRfOutputImage(null);
    setRfSelectedUserIds(new Set());
    setRfCrewSearch("");
    setEditingProjectId(null);
    setRegFormOpen(false);
  }, []);

  const openEditProject = useCallback((p: CareerProjectDto) => {
    setEditingProjectId(p.id);
    setRfLineCode(p.lineCode ?? "");
    setRfLineName(p.lineName ?? "");
    setRfStartDate(p.startDate ?? "");
    setRfEndDate(p.endDate ?? "");
    setRfCompanyName(p.companyName ?? "");
    setRfCompanyLogo(p.companyLogoUrl ?? "");
    setRfSupervisorName(p.supervisorName ?? "");
    setRfSupervisorDepartment(p.supervisorDepartment ?? "");
    setRfSupervisorPosition(p.supervisorPosition ?? "");
    setRfSupervisorPhoto(p.supervisorProfileImg ?? "");
    setRfDefaultTitle(p.defaultMainTitle ?? "");
    setRfOutputLink1(p.defaultOutputLink1 ?? "");
    setRfOutputLink2(p.defaultOutputLink2 ?? "");
    setRfOutputImage(
      p.defaultOutputImages.length > 0
        ? { url: p.defaultOutputImages[0], name: "기존 이미지" }
        : null,
    );
    setRfSelectedUserIds(new Set(p.defaultTargetUserIds));
    setRegFormOpen(true);
  }, []);

  const handleSaveProject = useCallback(async () => {
    if (!rfLineCode.trim()) { setBanner({ kind: "error", message: "라인 코드를 입력해주세요" }); return; }
    if (!rfLineName.trim()) { setBanner({ kind: "error", message: "라인명을 입력해주세요" }); return; }
    if (!rfStartDate) { setBanner({ kind: "error", message: "시작일을 입력해주세요" }); return; }
    if (!rfEndDate) { setBanner({ kind: "error", message: "종료일을 입력해주세요" }); return; }
    if (rfEndDate < rfStartDate) { setBanner({ kind: "error", message: "종료일은 시작일 이후여야 합니다" }); return; }
    if (!rfCompanyName.trim()) { setBanner({ kind: "error", message: "기업명을 입력해주세요" }); return; }
    if (!rfCompanyLogo.trim()) { setBanner({ kind: "error", message: "기업 로고를 등록해주세요" }); return; }
    if (!rfSupervisorName.trim()) { setBanner({ kind: "error", message: "담당자명을 입력해주세요" }); return; }
    if (rfSelectedUserIds.size === 0) { setBanner({ kind: "error", message: "선발 크루를 최소 1명 이상 선택해주세요" }); return; }
    if (rfAssetCount > 2) { setBanner({ kind: "error", message: "Output은 최대 2개까지 입력 가능합니다" }); return; }

    setSaving(true);
    setBanner(null);
    try {
      const defaultOutputImages: string[] = [];
      if (rfOutputImage) defaultOutputImages.push(rfOutputImage.url);

      const payload: Record<string, unknown> = {
        line_code: rfLineCode.trim(),
        line_name: rfLineName.trim(),
        start_date: rfStartDate,
        end_date: rfEndDate,
        // 기업명 SoT = career_projects.company_name (supervisor_company 아님).
        company_name: rfCompanyName.trim(),
        company_logo_url: rfCompanyLogo.trim(),
        supervisor_name: rfSupervisorName.trim(),
        supervisor_department: rfSupervisorDepartment.trim() || null,
        supervisor_position: rfSupervisorPosition.trim() || null,
        supervisor_profile_img: rfSupervisorPhoto.trim() || null,
        default_main_title: rfDefaultTitle.trim() || null,
        default_output_link_1: rfOutputLink1.trim() || null,
        default_output_link_2: rfOutputLink2.trim() || null,
        default_output_images: defaultOutputImages,
        default_target_user_ids: Array.from(rfSelectedUserIds),
        organization_slug: adminOrg ?? "oranke",
      };

      const url = editingProjectId
        ? `/api/admin/career-projects/${editingProjectId}`
        : "/api/admin/career-projects";
      const method = editingProjectId ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success && !json.data) {
        setBanner({ kind: "error", message: json.error ?? "저장 실패" });
        return;
      }
      setBanner({
        kind: "success",
        message: editingProjectId ? "경력 라인이 수정되었습니다" : "경력 라인이 등록되었습니다",
      });
      resetRegForm();
      await fetchInitialData();
    } catch {
      setBanner({ kind: "error", message: "저장 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [
    rfLineCode, rfLineName, rfStartDate, rfEndDate,
    rfCompanyName, rfCompanyLogo, rfSupervisorName,
    rfSupervisorDepartment, rfSupervisorPosition, rfSupervisorPhoto,
    rfDefaultTitle, rfOutputLink1, rfOutputLink2, rfOutputImage,
    rfSelectedUserIds, rfAssetCount, adminOrg, editingProjectId,
    resetRegForm, fetchInitialData,
  ]);

  const handleDeleteProject = useCallback(async (id: string) => {
    if (!confirm("이 경력 라인을 삭제하시겠습니까?")) return;
    try {
      const res = await fetch(`/api/admin/career-projects/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.success) { setBanner({ kind: "error", message: json.error ?? "삭제 실패" }); return; }
      setBanner({ kind: "success", message: "삭제되었습니다" });
      await fetchInitialData();
    } catch {
      setBanner({ kind: "error", message: "삭제 중 오류가 발생했습니다" });
    }
  }, [fetchInitialData]);

  // ── Line opening helpers ──
  const resetLineForm = useCallback(() => {
    setSelectedProjectId("");
    setLineMainTitle("");
    setLineLink1("");
    setLineLabel1("");
    setLineLink2("");
    setLineLabel2("");
    setLineImage1(null);
    setLineImage2(null);
    setLineCaption1("");
    setLineCaption2("");
    setLineSelectedUserIds(new Set());
    setLineCrewSearch("");
    setLoCompanyName("");
    setLoCompanyLogo("");
    setLoSupervisorName("");
    setLoSupervisorDept("");
    setLoSupervisorPos("");
    setLoSupervisorPhoto("");
    setLineFormOpen(false);
  }, []);

  // Auto-populate when career project is selected
  useEffect(() => {
    if (!selectedOption) return;
    setLineMainTitle(selectedOption.defaultMainTitle ?? selectedOption.lineName ?? "");
    setLineLink1(selectedOption.defaultOutputLink1 ?? "");
    setLineLabel1("");
    setLineLink2(selectedOption.defaultOutputLink2 ?? "");
    setLineLabel2("");
    if (selectedOption.defaultOutputImages.length > 0) {
      setLineImage1({ url: selectedOption.defaultOutputImages[0], name: "기존 이미지" });
    } else {
      setLineImage1(null);
    }
    setLineImage2(null);
    // default 이미지는 캡션을 저장하지 않으므로 초기화.
    setLineCaption1("");
    setLineCaption2("");
    // 선택한 career project 의 sponsor-card 6필드 prefill (수정 가능).
    setLoCompanyName(selectedOption.companyName ?? "");
    setLoCompanyLogo(selectedOption.companyLogoUrl ?? "");
    setLoSupervisorName(selectedOption.supervisorName ?? "");
    setLoSupervisorDept(selectedOption.supervisorDepartment ?? "");
    setLoSupervisorPos(selectedOption.supervisorPosition ?? "");
    setLoSupervisorPhoto(selectedOption.supervisorPhotoUrl ?? "");
    const validCrewIds = new Set(
      selectedOption.defaultTargetUserIds.filter((uid) =>
        crews.some((c) => c.userId === uid),
      ),
    );
    setLineSelectedUserIds(validCrewIds);
  }, [selectedOption, crews]);

  const selectedWeek = useMemo(
    () => weekOptions.find((w) => w.id === selectedWeekId) ?? null,
    [weekOptions, selectedWeekId],
  );
  const canOpenSelected = selectedWeek ? selectedWeek.canOpen : !!currentWeek?.weekId;

  const handleSaveLine = useCallback(async () => {
    if (!selectedWeekId) { setBanner({ kind: "error", message: "주차를 선택해주세요" }); return; }
    const targetWeekId = selectedWeek?.id ?? null;
    if (!targetWeekId) { setBanner({ kind: "error", message: "선택한 주차 정보를 확인할 수 없습니다" }); return; }
    if (!selectedWeek?.canOpen) { setBanner({ kind: "error", message: "선택한 주차는 라인 개설이 불가합니다" }); return; }
    if (!selectedOption) { setBanner({ kind: "error", message: "경력 라인을 선택해주세요" }); return; }
    if (!lineMainTitle.trim()) { setBanner({ kind: "error", message: "메인 타이틀을 입력해주세요" }); return; }
    if (!lineAssetValid) {
      setBanner({
        kind: "error",
        message: lineAssetCount < 1
          ? "Output을 최소 1개 입력해주세요"
          : "Output은 최대 2개까지 입력 가능합니다",
      });
      return;
    }
    if (lineSelectedUserIds.size === 0) { setBanner({ kind: "error", message: "개설 대상을 최소 1명 이상 선택해주세요" }); return; }
    if (!loCompanyName.trim()) { setBanner({ kind: "error", message: "기업명을 입력해주세요" }); return; }
    const built = buildOutputLinksFromForm([
      { url: lineLink1, label: lineLabel1 },
      { url: lineLink2, label: lineLabel2 },
    ]);
    if (!built.ok) { setBanner({ kind: "error", message: built.error }); return; }
    const outputLinks = built.value;

    setSaving(true);
    setBanner(null);
    try {
      // 1) 기업/감독자(sponsor-card) 6필드를 연결된 career_project 에 먼저 PATCH.
      //    target/line 생성 로직은 아래에서 기존대로 수행한다(분리 유지).
      const metaRes = await fetch(
        `/api/admin/career-projects/${selectedOption.id}/sponsor-meta`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company_name: loCompanyName.trim() || null,
            // 로고/사진은 업로드 후 반환 URL 만 저장 (URL input 아님).
            company_logo_url: loCompanyLogo.trim() || null,
            supervisor_name: loSupervisorName.trim() || null,
            supervisor_department: loSupervisorDept.trim() || null,
            supervisor_position: loSupervisorPos.trim() || null,
            supervisor_profile_img: loSupervisorPhoto.trim() || null,
          }),
        },
      );
      const metaJson = await metaRes.json();
      if (!metaJson.success) {
        setBanner({ kind: "error", message: metaJson.error ?? "기업/감독자 정보 저장에 실패했습니다" });
        return;
      }
      // output_images = [{url, caption}] — 이미지 있는 항목만 포함. 캡션 비우면 null.
      const outputImages: { url: string; caption: string | null }[] = [];
      for (const [img, cap] of [
        [lineImage1, lineCaption1],
        [lineImage2, lineCaption2],
      ] as const) {
        if (!img) continue;
        outputImages.push({
          url: img.url,
          caption: cap.trim() ? cap.trim() : null,
        });
      }

      const payload = {
        career_project_id: selectedOption.id,
        main_title: lineMainTitle.trim(),
        // output_links 우선 + 레거시 컬럼 backward-compat mirror.
        output_links: outputLinks,
        output_link_1: outputLinks[0]?.url ?? null,
        output_link_2: outputLinks[1]?.url ?? null,
        output_images: outputImages,
        target_user_ids: Array.from(lineSelectedUserIds),
        week_id: targetWeekId,
        // 기입 기간 = 귀속 주차(week_id)의 "다음 주". selectedWeek 는 주차정책 공통
        // helper(submissionWindowForWeekStartMs) 로 이미 다음 주 기간을 담고 있으므로
        // 그대로 전송한다(서버도 동일 규칙으로 강제 저장).
        submission_opens_at: selectedWeek.submissionOpensAt ?? currentWeek?.submissionOpensAt,
        submission_closes_at: selectedWeek.submissionClosesAt ?? currentWeek?.submissionClosesAt,
      };
      console.log("[career line open payload]", {
        selectedWeekId,
        selectedWeekOption: selectedWeek,
        body: payload,
      });
      const res = await fetch("/api/admin/cluster4/career-lines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!json.success) { setBanner({ kind: "error", message: json.error ?? "저장에 실패했습니다" }); return; }
      setBanner({
        kind: "success",
        message: `실무 경력 라인이 개설되었습니다 (대상: ${json.data?.targetCount ?? 0}명)`,
      });
      resetLineForm();
      setLineRefreshKey((k) => k + 1);
      await fetchInitialData();
    } catch {
      setBanner({ kind: "error", message: "저장 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [
    currentWeek, selectedWeek, selectedWeekId, selectedOption, lineMainTitle, lineAssetValid, lineAssetCount,
    lineLink1, lineLabel1, lineLink2, lineLabel2, lineImage1, lineImage2,
    lineCaption1, lineCaption2, lineSelectedUserIds,
    loCompanyName, loCompanyLogo, loSupervisorName, loSupervisorDept, loSupervisorPos, loSupervisorPhoto,
    resetLineForm, fetchInitialData,
  ]);

  // ── Crew selection helpers (shared) ──
  function CrewSelector({
    crews: crewList,
    teams: teamList,
    selectedIds,
    onToggle,
    onSelectAll,
    onDeselectAll,
    filterTeam,
    setFilterTeam,
    filterPart,
    setFilterPart,
    filterLevel,
    setFilterLevel,
    filterStatus,
    setFilterStatus,
    search,
    setSearch,
    uniqueParts,
    uniqueLevels,
    filteredCrews: filtered,
  }: {
    crews: CrewItem[];
    teams: TeamItem[];
    selectedIds: Set<string>;
    onToggle: (id: string) => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    filterTeam: string;
    setFilterTeam: (v: string) => void;
    filterPart: string;
    setFilterPart: (v: string) => void;
    filterLevel: string;
    setFilterLevel: (v: string) => void;
    filterStatus: string;
    setFilterStatus: (v: string) => void;
    search: string;
    setSearch: (v: string) => void;
    uniqueParts: string[];
    uniqueLevels: string[];
    filteredCrews: CrewItem[];
  }) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>
            크루 선택 <span className="text-red-500">*</span>
          </Label>
          <span className="text-xs text-muted-foreground">
            선택됨: {selectedIds.size}명
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <select
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            value={filterTeam}
            onChange={(e) => setFilterTeam(e.target.value)}
          >
            <option value="">전체 팀</option>
            {teamList.map((t) => (
              <option key={t.id} value={t.teamName}>{t.teamName}</option>
            ))}
          </select>
          <select
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            value={filterPart}
            onChange={(e) => setFilterPart(e.target.value)}
          >
            <option value="">전체 파트</option>
            {uniqueParts.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value)}
          >
            <option value="">전체 레벨</option>
            {uniqueLevels.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <select
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="active">활동중</option>
            <option value="rest">휴식중</option>
            <option value="">전체</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" placeholder="이름 검색..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" onClick={onSelectAll}>전체 선택</Button>
          <Button variant="outline" size="sm" onClick={onDeselectAll}>선택 해제</Button>
        </div>
        <div className="max-h-60 overflow-y-auto rounded-md border p-2">
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {crewList.length === 0 ? "등록된 크루가 없습니다" : "검색 결과가 없습니다"}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {filtered.map((crew) => (
                <label
                  key={crew.userId}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                    selectedIds.has(crew.userId) && "bg-muted",
                  )}
                >
                  <input
                    type="checkbox"
                    className="rounded border-input"
                    checked={selectedIds.has(crew.userId)}
                    onChange={() => onToggle(crew.userId)}
                  />
                  <span className="truncate">{crew.displayName}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {[crew.teamName, crew.partName].filter(Boolean).join(" / ") || ""}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Render ──
  if (loading) {
    return <LoadingState active />;
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6">
      <h1 className="text-2xl font-bold">실무 경력 라인 관리</h1>

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

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        <TabButton
          label="라인 등록"
          active={activeTab === "registration"}
          onClick={() => setActiveTab("registration")}
        />
        <TabButton
          label="경력 라인 개설"
          active={activeTab === "opening"}
          onClick={() => setActiveTab("opening")}
        />
        <TabButton
          label="경력 기록/평가 관리"
          active={activeTab === "evaluation"}
          onClick={() => setActiveTab("evaluation")}
        />
      </div>

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab: 라인 등록 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "registration" && (
        <div className="space-y-4">
          {/* 2E-2 soft 안내 — career 는 기존 경로 유지(차단 없음), 통합 등록 경로 권장만. */}
          <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            안내: 라인 정의 통합(2E) 진행 중입니다. 신규 경력 라인은{" "}
            <a href="/admin/lines/register" className="font-semibold underline underline-offset-2">통합 라인 등록</a>
            {" "}경로 사용을 권장합니다. 이 화면의 기존 등록/수정 기능은 그대로 사용할 수 있습니다.
          </div>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">등록된 경력 라인</CardTitle>
                  <CardDescription>
                    총 {projects.filter((p) => p.lineCode).length}개
                    {adminOrg && <span className="ml-1">({adminOrg})</span>}
                  </CardDescription>
                </div>
                {!regFormOpen && (
                  <Button size="sm" onClick={() => setRegFormOpen(true)}>
                    <Plus className="mr-1 h-4 w-4" /> 새 경력 라인
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {projects.filter((p) => p.lineCode).length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  등록된 경력 라인이 없습니다
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>라인 코드</TableHead>
                      <TableHead>라인명</TableHead>
                      <TableHead>기업</TableHead>
                      <TableHead>담당자</TableHead>
                      <TableHead className="text-center">크루</TableHead>
                      <TableHead>기간</TableHead>
                      <TableHead className="w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {projects
                      .filter((p) => p.lineCode)
                      .map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="font-mono text-xs">{p.lineCode}</TableCell>
                          <TableCell className="font-medium">{p.lineName ?? "-"}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {p.companyLogoUrl && (
                                <img src={p.companyLogoUrl} alt="" className="h-5 w-5 rounded object-cover" />
                              )}
                              <span className="text-sm">{p.companyName ?? "-"}</span>
                            </div>
                          </TableCell>
                          <TableCell>{p.supervisorName ?? "-"}</TableCell>
                          <TableCell className="text-center">{p.defaultTargetUserIds.length}명</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {p.startDate && p.endDate
                              ? `${p.startDate} ~ ${p.endDate}`
                              : "-"}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditProject(p)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDeleteProject(p.id)}>
                                <Trash2 className="h-3.5 w-3.5 text-red-500" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Registration Form */}
          {regFormOpen && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  {editingProjectId ? "경력 라인 수정" : "새 경력 라인 등록"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 기본 정보 */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>라인 코드 <span className="text-red-500">*</span></Label>
                    <Input value={rfLineCode} onChange={(e) => setRfLineCode(e.target.value)} placeholder="CP-001" />
                  </div>
                  <div className="space-y-2">
                    <Label>라인명 <span className="text-red-500">*</span></Label>
                    <Input value={rfLineName} onChange={(e) => setRfLineName(e.target.value)} placeholder="마케팅 전략 프로젝트" />
                  </div>
                </div>

                {/* 기간 */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>시작일 <span className="text-red-500">*</span></Label>
                    <Input type="date" value={rfStartDate} onChange={(e) => setRfStartDate(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>종료일 <span className="text-red-500">*</span></Label>
                    <Input type="date" value={rfEndDate} onChange={(e) => setRfEndDate(e.target.value)} />
                  </div>
                </div>

                {/* 기업 정보 */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>기업명 <span className="text-red-500">*</span></Label>
                    <Input value={rfCompanyName} onChange={(e) => setRfCompanyName(e.target.value)} placeholder="브랙시움" />
                  </div>
                  <div className="space-y-2">
                    <LogoUploadField
                      value={rfCompanyLogo}
                      onChange={setRfCompanyLogo}
                      onRemove={() => setRfCompanyLogo("")}
                      disabled={saving}
                    />
                  </div>
                </div>

                {/* 감독자 정보 */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>감독자명 <span className="text-red-500">*</span></Label>
                    <Input value={rfSupervisorName} onChange={(e) => setRfSupervisorName(e.target.value)} placeholder="김담당" />
                  </div>
                  <div className="space-y-2">
                    <Label>감독자 부서 (선택)</Label>
                    <Input value={rfSupervisorDepartment} onChange={(e) => setRfSupervisorDepartment(e.target.value)} placeholder="마케팅팀" />
                  </div>
                  <div className="space-y-2">
                    <Label>감독자 직책 (선택)</Label>
                    <Input value={rfSupervisorPosition} onChange={(e) => setRfSupervisorPosition(e.target.value)} placeholder="팀장" />
                  </div>
                </div>

                {/* 감독자 사진 — 기업 로고와 동일한 업로드 패턴 재사용. 저장 필드: supervisor_profile_img */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <LogoUploadField
                      value={rfSupervisorPhoto}
                      onChange={setRfSupervisorPhoto}
                      onRemove={() => setRfSupervisorPhoto("")}
                      disabled={saving}
                      label="감독자 사진 (선택)"
                      required={false}
                      altText="감독자 사진"
                      emptyButtonLabel="감독자 사진 업로드"
                    />
                  </div>
                </div>

                {/* 선택 입력 */}
                <div className="space-y-2">
                  <Label>메인 타이틀 (선택)</Label>
                  <Input value={rfDefaultTitle} onChange={(e) => setRfDefaultTitle(e.target.value)} placeholder="미입력 시 개설 때 라인명 사용" />
                </div>

                {/* Output Assets */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Output Asset (선택)</Label>
                    <span className={cn("text-xs", rfAssetCount <= 2 ? "text-muted-foreground" : "text-red-500")}>
                      {rfAssetCount}/2 (최대 2)
                    </span>
                  </div>
                  <div className="grid gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="rfLink1" className="text-xs text-muted-foreground">Link 1</Label>
                      <Input id="rfLink1" value={rfOutputLink1} onChange={(e) => setRfOutputLink1(e.target.value)} placeholder="https://..." disabled={!rfOutputLink1.trim() && rfAssetCount >= 2} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="rfLink2" className="text-xs text-muted-foreground">Link 2</Label>
                      <Input id="rfLink2" value={rfOutputLink2} onChange={(e) => setRfOutputLink2(e.target.value)} placeholder="https://..." disabled={!rfOutputLink2.trim() && rfAssetCount >= 2} />
                    </div>
                    <ImageUploadSlot
                      label="Image"
                      image={rfOutputImage}
                      onUpload={setRfOutputImage}
                      onRemove={() => setRfOutputImage(null)}
                      disabled={!rfOutputImage && rfAssetCount >= 2}
                    />
                  </div>
                </div>

                {/* Crew Selection */}
                <CrewSelector
                  crews={crews}
                  teams={teams}
                  selectedIds={rfSelectedUserIds}
                  onToggle={(uid) => {
                    setRfSelectedUserIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(uid)) next.delete(uid); else next.add(uid);
                      return next;
                    });
                  }}
                  onSelectAll={() => setRfSelectedUserIds(new Set(rfFilteredCrews.map((c) => c.userId)))}
                  onDeselectAll={() => setRfSelectedUserIds(new Set())}
                  filterTeam={rfCrewFilterTeam}
                  setFilterTeam={setRfCrewFilterTeam}
                  filterPart={rfCrewFilterPart}
                  setFilterPart={setRfCrewFilterPart}
                  filterLevel={rfCrewFilterLevel}
                  setFilterLevel={setRfCrewFilterLevel}
                  filterStatus={rfCrewFilterStatus}
                  setFilterStatus={setRfCrewFilterStatus}
                  search={rfCrewSearch}
                  setSearch={setRfCrewSearch}
                  uniqueParts={rfUniqueParts}
                  uniqueLevels={rfUniqueLevels}
                  filteredCrews={rfFilteredCrews}
                />

                {/* Actions */}
                <div className="flex justify-end gap-3 pt-2">
                  <Button variant="outline" onClick={resetRegForm} disabled={saving}>취소</Button>
                  <Button onClick={handleSaveProject} loading={saving}>
                    {editingProjectId ? "수정" : "등록"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab: 경력 라인 개설 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "opening" && (
        <div className="space-y-4">
          {/* Current Week + Week Selector */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">라인 개설 대상 주차</CardTitle>
              <CardDescription>운영 기본값은 현재 주차이며, 테스트/검증 목적으로 직전 주차도 선택할 수 있습니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {weekOptions.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">대상 주차</Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={selectedWeekId}
                    onChange={(e) => setSelectedWeekId(e.target.value)}
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
              )}
              {selectedWeek ? (
                <div className="space-y-1 text-sm">
                  <p>
                    <span className="font-medium">{selectedWeek.year} {selectedWeek.seasonName} W{selectedWeek.weekNumber}</span>{" "}
                    ({fmtDateWithDay(selectedWeek.startDate)} ~ {fmtDateWithDay(selectedWeek.endDate)})
                  </p>
                  {/* 기입 기간 = 귀속 주차의 "다음 주"(주차정책 공통 helper). selectedWeek 가 이미 다음 주 기간을 담는다. */}
                  {selectedWeek.canOpen && selectedWeek.submissionOpensAt && selectedWeek.submissionClosesAt && (
                    <p className="text-muted-foreground">
                      기입 기간: {fmtDateTimeWithDay(selectedWeek.submissionOpensAt)} ~ {fmtDateTimeWithDay(selectedWeek.submissionClosesAt)}
                    </p>
                  )}
                  {!selectedWeek.canOpen && (
                    <p className="font-medium text-orange-600">선택한 주차는 공식 휴식 주차입니다.</p>
                  )}
                </div>
              ) : currentWeek ? (
                <div className="space-y-1 text-sm">
                  <p>
                    <span className="font-medium">W{currentWeek.weekNumber}</span>{" "}
                    ({fmtDateWithDay(currentWeek.weekStart)} ~ {fmtDateWithDay(currentWeek.weekEnd)})
                  </p>
                  <p className="text-muted-foreground">
                    기입 기간: {fmtDateTimeWithDay(currentWeek.submissionOpensAt)} ~ {fmtDateTimeWithDay(currentWeek.submissionClosesAt)}
                  </p>
                </div>
              ) : (
                <p className="font-medium text-orange-600">
                  현재 주차에 라인을 개설할 수 없습니다.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Existing career lines */}
          <Cluster4LineTable
            partType="career"
            title="개설된 실무 경력 라인"
            nameColumnLabel="경력 프로젝트"
            refreshSignal={lineRefreshKey}
            weekId={selectedWeekId}
          />

          {/* New line button */}
          {!lineFormOpen && canOpenSelected && (
            <Button onClick={() => setLineFormOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> 새 실무 경력 라인 개설
            </Button>
          )}

          {/* New line form */}
          {lineFormOpen && canOpenSelected && (selectedWeek?.submissionClosesAt ?? currentWeek?.submissionClosesAt) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">새 실무 경력 라인</CardTitle>
                <CardDescription>
                  기입 마감: {fmtDateTimeWithDay((selectedWeek?.submissionClosesAt ?? currentWeek?.submissionClosesAt) as string)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Project selection */}
                <div className="space-y-2">
                  <Label>경력 라인 <span className="text-red-500">*</span></Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                  >
                    <option value="">선택해주세요</option>
                    {careerOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        [{o.lineCode}] {o.lineName ?? ""} — {o.companyName ?? ""}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 선택한 career project 메타 — 라인 코드/기간은 읽기 전용, 기업/감독자는 편집 가능.
                    수정 후 개설하면 career_projects 에 PATCH 되고 대상자 weekly-card 가 갱신된다. */}
                {selectedOption && (
                  <div className="space-y-4 rounded-md border bg-muted/30 p-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">라인 코드</Label>
                        <p className="font-mono text-sm">{selectedOption.lineCode}</p>
                      </div>
                      {selectedOption.startDate && selectedOption.endDate && (
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">프로젝트 기간</Label>
                          <p className="text-sm">{selectedOption.startDate} ~ {selectedOption.endDate}</p>
                        </div>
                      )}
                    </div>

                    {/* 기업 정보 (편집) */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <Label className="text-xs">기업명 <span className="text-red-500">*</span></Label>
                        <Input value={loCompanyName} onChange={(e) => setLoCompanyName(e.target.value)} placeholder="기업명" />
                      </div>
                      <LogoUploadField
                        value={loCompanyLogo}
                        onChange={setLoCompanyLogo}
                        onRemove={() => setLoCompanyLogo("")}
                        disabled={saving}
                      />
                    </div>

                    {/* 감독자 정보 (편집) */}
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <Label className="text-xs">감독자명</Label>
                        <Input value={loSupervisorName} onChange={(e) => setLoSupervisorName(e.target.value)} placeholder="김담당" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">감독자 부서</Label>
                        <Input value={loSupervisorDept} onChange={(e) => setLoSupervisorDept(e.target.value)} placeholder="마케팅팀" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">감독자 직책</Label>
                        <Input value={loSupervisorPos} onChange={(e) => setLoSupervisorPos(e.target.value)} placeholder="팀장" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <LogoUploadField
                        value={loSupervisorPhoto}
                        onChange={setLoSupervisorPhoto}
                        onRemove={() => setLoSupervisorPhoto("")}
                        disabled={saving}
                        label="감독자 사진 (선택)"
                        required={false}
                        altText="감독자 사진"
                        emptyButtonLabel="감독자 사진 업로드"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      기업/감독자 정보는 연결된 경력 프로젝트에 저장됩니다(개설 시 함께 반영).
                    </p>
                  </div>
                )}

                {/* Editable main title */}
                <div className="space-y-2">
                  <Label>메인 타이틀 <span className="text-red-500">*</span></Label>
                  <Input
                    value={lineMainTitle}
                    onChange={(e) => setLineMainTitle(e.target.value)}
                    placeholder="메인 타이틀을 입력하세요"
                  />
                </div>

                {/* Output Assets */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Output Asset <span className="text-red-500">*</span></Label>
                    <span className={cn(
                      "text-xs",
                      lineAssetCount === 0 ? "text-red-500" : lineAssetCount <= 2 ? "text-green-600" : "text-red-500",
                    )}>
                      {lineAssetCount}/2 (최소 1, 최대 2)
                    </span>
                  </div>
                  <div className="grid gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="careerLink1" className="text-xs text-muted-foreground">Link 1 URL</Label>
                      <Input id="careerLink1" value={lineLink1} onChange={(e) => setLineLink1(e.target.value)} placeholder={OUTPUT_LINK_URL_PLACEHOLDER} disabled={!lineLink1.trim() && lineAssetCount >= 2} />
                      <Input id="careerLabel1" value={lineLabel1} onChange={(e) => setLineLabel1(e.target.value)} placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER} aria-label="Link 1 설명" maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="careerLink2" className="text-xs text-muted-foreground">Link 2 URL</Label>
                      <Input id="careerLink2" value={lineLink2} onChange={(e) => setLineLink2(e.target.value)} placeholder={OUTPUT_LINK_URL_PLACEHOLDER} disabled={!lineLink2.trim() && lineAssetCount >= 2} />
                      <Input id="careerLabel2" value={lineLabel2} onChange={(e) => setLineLabel2(e.target.value)} placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER} aria-label="Link 2 설명" maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH} />
                    </div>
                    <ImageUploadSlot
                      label="Image 1"
                      image={lineImage1}
                      caption={lineCaption1}
                      onUpload={setLineImage1}
                      onRemove={() => { setLineImage1(null); setLineCaption1(""); }}
                      onCaptionChange={setLineCaption1}
                      disabled={!lineImage1 && lineAssetCount >= 2}
                    />
                    <ImageUploadSlot
                      label="Image 2"
                      image={lineImage2}
                      caption={lineCaption2}
                      onUpload={setLineImage2}
                      onRemove={() => { setLineImage2(null); setLineCaption2(""); }}
                      onCaptionChange={setLineCaption2}
                      disabled={!lineImage2 && lineAssetCount >= 2}
                    />
                  </div>
                </div>

                {/* Target Crew Selection */}
                <CrewSelector
                  crews={crews}
                  teams={teams}
                  selectedIds={lineSelectedUserIds}
                  onToggle={(uid) => {
                    setLineSelectedUserIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(uid)) next.delete(uid); else next.add(uid);
                      return next;
                    });
                  }}
                  onSelectAll={() => setLineSelectedUserIds(new Set(lineFilteredCrews.map((c) => c.userId)))}
                  onDeselectAll={() => setLineSelectedUserIds(new Set())}
                  filterTeam={lineCrewFilterTeam}
                  setFilterTeam={setLineCrewFilterTeam}
                  filterPart={lineCrewFilterPart}
                  setFilterPart={setLineCrewFilterPart}
                  filterLevel={lineCrewFilterLevel}
                  setFilterLevel={setLineCrewFilterLevel}
                  filterStatus={lineCrewFilterStatus}
                  setFilterStatus={setLineCrewFilterStatus}
                  search={lineCrewSearch}
                  setSearch={setLineCrewSearch}
                  uniqueParts={rfUniqueParts}
                  uniqueLevels={rfUniqueLevels}
                  filteredCrews={lineFilteredCrews}
                />

                {/* Actions */}
                <div className="flex justify-end gap-3 pt-2">
                  <Button variant="outline" onClick={resetLineForm} disabled={saving}>취소</Button>
                  <Button onClick={handleSaveLine} loading={saving}>
                    개설
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab: 경력 기록/평가 관리 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "evaluation" && (
        <CareerEvaluationTab
          lines={existingLines.map((l) => ({
            id: l.id,
            lineCode: l.lineCode,
            mainTitle: l.mainTitle,
          }))}
        />
      )}
    </div>
  );
}
