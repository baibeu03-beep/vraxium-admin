"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Plus, Search, Check, X, Upload, Trash2, Pencil } from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { adminDialog } from "@/components/ui/admin-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatClubDate, formatClubDateTime } from "@/lib/clubDate";
import { formatBannerPeriod } from "@/lib/practicalInfoSection0Format";
import { readOrgParam } from "@/lib/adminOrgContext";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { buildLineOpeningTabs } from "@/lib/adminHeaderTabs";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import {
  ORGANIZATIONS,
  ORGANIZATION_LABEL,
  ORGANIZATION_COMMON_LABEL,
} from "@/lib/organizations";
import Cluster4LineTable from "@/components/admin/cluster4/Cluster4LineTable";
import CompetencyOpeningDashboard from "@/components/admin/CompetencyOpeningDashboard";
import CompetencyLineManageBoard from "@/components/admin/CompetencyLineManageBoard";
import {
  buildOutputLinksFromForm,
  OUTPUT_LINK_LABEL_PLACEHOLDER,
  OUTPUT_LINK_URL_PLACEHOLDER,
  OUTPUT_LINK_LABEL_MAX_LENGTH,
} from "@/lib/cluster4OutputLinks";
import { OUTPUT_IMAGE_CAPTION_MAX_LENGTH } from "@/lib/cluster4OutputImages";
import { useToast } from "@/components/ui/toast";
import { useActionToast } from "@/lib/actionToast";
import { LINE_OPENING_RESULT } from "@/lib/lineOpeningResultMessages";

const ORG_OPTIONS: Array<{ value: string; label: string }> = [
  ...ORGANIZATIONS.map((slug) => ({ value: slug, label: ORGANIZATION_LABEL[slug] })),
  { value: "common", label: ORGANIZATION_COMMON_LABEL },
];

// [라인 관리] 탭 레거시 3섹션(라인 등록·라인 개설·카페 링크 집계) 표시 토글.
//   이번 phase: false — UI 렌더·관련 데이터 호출(fetchInitialData) 전부 중단(코드는 보존).
//   향후 재사용 시 true 로만 바꾸면 원복(주차 드롭다운/집계 카드/크루별 결과표는 토글 무관·항상 유지).
const SHOW_LEGACY_SECTIONS: boolean = false;

function formatOrgLabel(slug: string | null | undefined): string {
  if (!slug) return "-";
  if (slug === "common") return ORGANIZATION_COMMON_LABEL;
  return (ORGANIZATION_LABEL as Record<string, string>)[slug] ?? slug;
}

type TabKey = "opening" | "masters" | "cafe";

type CurrentWeekData = {
  weekId: string | null;
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

type TeamItem = { id: string; teamName: string };

type LineMasterItem = {
  id: string;
  organizationSlug: string;
  lineCode: string;
  lineName: string;
  mainTitle: string | null;
  sourceFileName: string | null;
  isActive: boolean;
};

type CrewItem = {
  userId: string;
  displayName: string;
  teamName: string | null;
  partName: string | null;
  membershipLevel: string | null;
  membershipState: string | null;
};

type ExistingLineDto = {
  id: string;
  lineCode: string | null;
  mainTitle: string;
  targetCount: number;
  isActive: boolean;
  createdAt: string;
};

type UploadedImage = { url: string; name: string };

function fmtDateWithDay(iso: string): string {
  return formatClubDate(iso);
}

function fmtDateTimeWithDay(iso: string): string {
  return formatClubDateTime(iso);
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

function ImageUploadSlot({ label, image, caption, onUpload, onRemove, onCaptionChange, disabled }: {
  label: string; image: UploadedImage | null;
  // 캡션은 이미지와 분리된 독립 state. 업로드 전에도 입력 가능.
  caption?: string;
  onUpload: (img: UploadedImage) => void; onRemove: () => void;
  // 제공 시 캡션 입력 UI 노출 (라인 개설 output_images 전용). 미제공 시 캡션 미노출.
  onCaptionChange?: (caption: string) => void; disabled: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch("/api/admin/cluster4/upload-image", { method: "POST", body: fd });
      const json = await res.json();
      if (!json.success) { void adminDialog.alert({ variant: "danger", title: "업로드 실패", description: json.error || "업로드에 실패했습니다." }); return; }
      onUpload({ url: json.data.url, name: file.name });
    } catch { void adminDialog.alert({ variant: "danger", title: "업로드 오류", description: "업로드 중 오류가 발생했습니다." }); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  }, [onUpload]);

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {image ? (
        <div className="flex items-center gap-3 rounded-md border p-2">
          <img src={image.url} alt={image.name} className="h-16 w-16 shrink-0 rounded object-cover" />
          <div className="min-w-0 flex-1"><p className="truncate text-sm">{image.name}</p></div>
          <Button variant="ghost" size="icon" className="shrink-0" onClick={onRemove}><Trash2 className="h-4 w-4 text-red-500" /></Button>
        </div>
      ) : (
        <div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={handleFileChange} disabled={disabled || uploading} />
          <Button variant="outline" className="w-full" loading={uploading} disabled={disabled} onClick={() => fileRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            이미지 업로드
          </Button>
        </div>
      )}
      {/* 이미지 캡션 — 업로드 전/후 항상 노출. 이미지 없으면 payload 미포함. 비우면 null 저장. */}
      {onCaptionChange && (
        <Input value={caption ?? ""} onChange={(e) => onCaptionChange(e.target.value)} placeholder="이미지 캡션을 입력하세요" aria-label={`${label} 캡션`} maxLength={OUTPUT_IMAGE_CAPTION_MAX_LENGTH} disabled={disabled} />
      )}
    </div>
  );
}

function TabButton({ label, active, onClick, disabled }: { label: string; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={cn("rounded-t-md px-4 py-2 text-sm font-medium transition-colors", active ? "border-b-2 border-primary bg-background text-primary" : "text-muted-foreground hover:text-foreground", disabled && "cursor-not-allowed opacity-50")} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}

export default function PracticalCompetencyManager() {
  // 헤더 [라인 관리]/[라인 개설] 2탭 — **조직 분기 모드(?org 있음)** 에서만 적용(실무 정보/경험과 동일 UX).
  // 탭 UI 자체는 상단 Header title 영역(components/admin/Header.tsx)에 있고, 본문은 URL ?tab 으로
  // 어느 콘텐츠를 보일지만 결정한다. ?org 없는 통합 진입에서는 기존 단일 화면 그대로.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const orgScoped = readOrgParam(searchParams) != null;
  const mainTab: "manage" | "open" =
    orgScoped && searchParams?.get("tab") === "open" ? "open" : "manage";

  const [activeTab, setActiveTab] = useState<TabKey>("masters");
  const [adminOrg, setAdminOrg] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [masters, setMasters] = useState<LineMasterItem[]>([]);
  const [currentWeek, setCurrentWeek] = useState<CurrentWeekData | null>(null);
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  const [existingLines, setExistingLines] = useState<ExistingLineDto[]>([]);
  const [lineRefreshKey, setLineRefreshKey] = useState(0);
  const [crews, setCrews] = useState<CrewItem[]>([]);
  // 레거시 섹션 숨김 시 manager 레벨 초기 로딩 불필요(보드는 자체 로딩) → 즉시 렌더.
  const [loading, setLoading] = useState(SHOW_LEGACY_SECTIONS);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const t = useActionToast();

  // Master form
  const [masterFormOpen, setMasterFormOpen] = useState(false);
  const [editingMasterId, setEditingMasterId] = useState<string | null>(null);
  const [mfOrgSlug, setMfOrgSlug] = useState("");
  const [mfLineCode, setMfLineCode] = useState("");
  const [mfLineName, setMfLineName] = useState("");
  const [mfMainTitle, setMfMainTitle] = useState("");
  const [mfSourceFile, setMfSourceFile] = useState("");

  // Line opening form
  const [lineFormOpen, setLineFormOpen] = useState(false);
  const [selectedMasterId, setSelectedMasterId] = useState("");
  const [lineLink1, setLineLink1] = useState("");
  const [lineLabel1, setLineLabel1] = useState("");
  const [lineLink2, setLineLink2] = useState("");
  const [lineLabel2, setLineLabel2] = useState("");
  const [lineImage1, setLineImage1] = useState<UploadedImage | null>(null);
  const [lineImage2, setLineImage2] = useState<UploadedImage | null>(null);
  // 이미지 캡션 — 이미지와 분리된 독립 state (업로드 전에도 입력 가능).
  const [lineCaption1, setLineCaption1] = useState("");
  const [lineCaption2, setLineCaption2] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());

  // 카페 링크 집계 (Phase 1 — 닉네임 수집만, 포인트/매칭/snapshot 미관여)
  const [cafeUrl, setCafeUrl] = useState("");
  const [cafeLoading, setCafeLoading] = useState(false);
  const [cafeError, setCafeError] = useState<string | null>(null);
  const [cafeResult, setCafeResult] = useState<{
    articleUrl: string;
    totalComments: number;
    uniqueNicknames: number;
    nicknames: string[];
    nicknameCounts: Array<{ nickname: string; count: number }>;
  } | null>(null);

  // Crew filters
  const [crewFilterTeam, setCrewFilterTeam] = useState("");
  const [crewFilterPart, setCrewFilterPart] = useState("");
  const [crewFilterLevel, setCrewFilterLevel] = useState("");
  const [crewFilterStatus, setCrewFilterStatus] = useState("active");
  const [crewSearch, setCrewSearch] = useState("");

  const lineAssetCount = useMemo(() => {
    let c = 0;
    if (lineLink1.trim()) c++;
    if (lineLink2.trim()) c++;
    if (lineImage1) c++;
    if (lineImage2) c++;
    return c;
  }, [lineLink1, lineLink2, lineImage1, lineImage2]);
  const lineAssetValid = lineAssetCount >= 1 && lineAssetCount <= 2;

  const selectedMaster = useMemo(() => masters.find((m) => m.id === selectedMasterId) ?? null, [masters, selectedMasterId]);
  const activeMasters = useMemo(() => masters.filter((m) => m.isActive), [masters]);
  const lineMainTitle = selectedMaster?.mainTitle ?? selectedMaster?.lineName ?? "";

  const uniqueParts = useMemo(() => { const s = new Set<string>(); for (const c of crews) if (c.partName) s.add(c.partName); return Array.from(s).sort(); }, [crews]);
  const uniqueLevels = useMemo(() => { const s = new Set<string>(); for (const c of crews) if (c.membershipLevel) s.add(c.membershipLevel); return Array.from(s).sort(); }, [crews]);

  const filteredCrews = useMemo(() => {
    let r = crews;
    if (crewFilterTeam) r = r.filter((c) => c.teamName === crewFilterTeam);
    if (crewFilterPart) r = r.filter((c) => c.partName === crewFilterPart);
    if (crewFilterLevel) r = r.filter((c) => c.membershipLevel === crewFilterLevel);
    if (crewSearch.trim()) { const q = crewSearch.trim().toLowerCase(); r = r.filter((c) => c.displayName.toLowerCase().includes(q)); }
    return r;
  }, [crews, crewFilterTeam, crewFilterPart, crewFilterLevel, crewSearch]);

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
      if (weekJson.success) setCurrentWeek(weekJson.data);
      const weeksJson = await weeksRes.json();
      if (weeksJson.success) {
        const opts: WeekOption[] = weeksJson.data.weeks ?? [];
        setWeekOptions(opts);
        const current = opts.find((o) => o.isCurrent) ?? opts[0];
        if (current) setSelectedWeekId((prev) => prev || current.id);
      }

      const orgParam = org ? `?organization=${org}` : "";
      // 개설된 라인 목록(linesRes)은 URL 조직 컨텍스트(?org)로 스코프 — (해당 조직 OR 공통).
      // (org 변수는 admin-org 기반 별개 값이라 구분해서 사용한다.)
      const linesQs = new URLSearchParams({ partType: "competency", limit: "100" });
      const urlOrg = readOrgParam(new URLSearchParams(window.location.search));
      if (urlOrg) linesQs.set("organization", urlOrg);
      // 팀/라인/크루 모집단 = 서버 QA_HIDE_REAL_USERS 스위치 기준(QA=테스트 / 종료 후 실사용자). 클라 강제 없음.
      const [teamsRes, mastersRes, linesRes, crewsRes] = await Promise.all([
        fetch(`/api/admin/cluster4/teams${orgParam ?? ""}`),
        // 라인 등록 데이터는 조직별 권한 분리 전 단계라 전체 조직을 조회한다.
        fetch(`/api/admin/cluster4/competency-line-masters`),
        fetch(`/api/admin/cluster4/lines?${linesQs.toString()}`),
        fetch(`/api/admin/cluster4/crews${orgParam ? orgParam + "&" : "?"}status=active`),
      ]);
      const teamsJson = await teamsRes.json(); if (teamsJson.success) setTeams(teamsJson.data);
      const mastersJson = await mastersRes.json(); if (mastersJson.success) setMasters(mastersJson.data);
      const linesJson = await linesRes.json(); if (linesJson.success) setExistingLines(linesJson.data?.rows ?? linesJson.data ?? []);
      const crewsJson = await crewsRes.json(); if (crewsJson.success) setCrews(crewsJson.data);
    } catch { toast("error", "데이터를 불러오는데 실패했습니다"); } finally { setLoading(false); }
  }, []);

  // 레거시 3섹션 전용 초기 데이터(admin-org·teams·masters·lines·crews 등) — 숨김 phase 에선 호출 중단.
  useEffect(() => { if (SHOW_LEGACY_SECTIONS) fetchInitialData(); }, [fetchInitialData]);

  const refetchCrews = useCallback(async () => {
    if (!adminOrg) return;
    const params = new URLSearchParams(); params.set("organization", adminOrg);
    if (crewFilterStatus) params.set("status", crewFilterStatus);
    try { const res = await fetch(`/api/admin/cluster4/crews?${params}`); const json = await res.json(); if (json.success) setCrews(json.data); } catch { /* silent */ }
  }, [adminOrg, crewFilterStatus]);

  useEffect(() => { if (SHOW_LEGACY_SECTIONS && !loading) refetchCrews(); }, [crewFilterStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Master form
  const resetMasterForm = useCallback(() => { setMfOrgSlug(""); setMfLineCode(""); setMfLineName(""); setMfMainTitle(""); setMfSourceFile(""); setEditingMasterId(null); setMasterFormOpen(false); }, []);

  const openEditMaster = useCallback((m: LineMasterItem) => {
    setEditingMasterId(m.id); setMfOrgSlug(m.organizationSlug ?? ""); setMfLineCode(m.lineCode); setMfLineName(m.lineName); setMfMainTitle(m.mainTitle ?? ""); setMfSourceFile(m.sourceFileName ?? ""); setMasterFormOpen(true);
  }, []);

  const handleSaveMaster = useCallback(async () => {
    const orgSlug = (mfOrgSlug || adminOrg || "").trim();
    if (!orgSlug) { toast("error", "클럽은 필수입니다"); return; }
    if (!mfLineCode.trim() || !mfLineName.trim()) { toast("error", "라인 코드와 라인명은 필수입니다"); return; }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { organization_slug: orgSlug, line_code: mfLineCode.trim(), line_name: mfLineName.trim(), main_title: mfMainTitle.trim() || null, source_file_name: mfSourceFile.trim() || null };
      const url = editingMasterId ? `/api/admin/cluster4/competency-line-masters/${editingMasterId}` : "/api/admin/cluster4/competency-line-masters";
      const res = await fetch(url, { method: editingMasterId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await res.json();
      if (!json.success) { console.error("[competency] save failed", json?.error); t.error("save", { status: res.status }); return; }
      toast("success", editingMasterId ? "라인이 수정되었습니다" : "라인이 등록되었습니다");
      resetMasterForm(); await fetchInitialData();
    } catch { toast("error", "저장 중 오류가 발생했습니다"); } finally { setSaving(false); }
  }, [mfOrgSlug, mfLineCode, mfLineName, mfMainTitle, mfSourceFile, adminOrg, editingMasterId, resetMasterForm, fetchInitialData]);

  const handleDeleteMaster = useCallback(async (id: string) => {
    if (!(await adminDialog.confirm({ variant: "danger", title: "라인 삭제", description: "이 라인을 삭제하시겠습니까?", confirmLabel: "삭제" }))) return;
    try { const res = await fetch(`/api/admin/cluster4/competency-line-masters/${id}`, { method: "DELETE" }); const json = await res.json(); if (!json.success) { console.error("[competency] delete failed", json?.error); t.error("delete", { status: res.status }); return; } toast("success", "삭제되었습니다"); await fetchInitialData(); } catch { toast("error", "삭제 중 오류"); }
  }, [fetchInitialData]);

  // Line opening
  const resetLineForm = useCallback(() => { setSelectedMasterId(""); setLineLink1(""); setLineLabel1(""); setLineLink2(""); setLineLabel2(""); setLineImage1(null); setLineImage2(null); setLineCaption1(""); setLineCaption2(""); setSelectedUserIds(new Set()); setCrewSearch(""); setLineFormOpen(false); }, []);

  const toggleUser = useCallback((uid: string) => { setSelectedUserIds((prev) => { const n = new Set(prev); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; }); }, []);
  const selectAllFiltered = useCallback(() => { setSelectedUserIds(new Set(filteredCrews.map((c) => c.userId))); }, [filteredCrews]);
  const deselectAll = useCallback(() => { setSelectedUserIds(new Set()); }, []);

  const selectedWeek = useMemo(
    () => weekOptions.find((w) => w.id === selectedWeekId) ?? null,
    [weekOptions, selectedWeekId],
  );
  const canOpenSelected = useMemo(() => {
    if (selectedWeek) return selectedWeek.canOpen;
    return !!currentWeek?.weekId && currentWeek.canOpen;
  }, [selectedWeek, currentWeek]);

  const handleSaveLine = useCallback(async () => {
    if (!selectedWeekId) { toast("error", "주차를 선택해주세요"); return; }
    const targetWeekId = selectedWeek?.id ?? null;
    if (!targetWeekId) { toast("error", "선택한 주차 정보를 확인할 수 없습니다"); return; }
    if (!selectedWeek?.canOpen) { toast("error", "선택한 주차는 라인 개설이 불가합니다"); return; }
    if (!selectedMaster) { toast("error", "라인을 선택해주세요"); return; }
    if (!lineAssetValid) { toast("error", lineAssetCount < 1 ? "Output을 최소 1개 입력해주세요" : "Output은 최대 2개까지 입력 가능합니다"); return; }
    if (selectedUserIds.size === 0) { toast("error", "개설 대상을 최소 1명 이상 선택해주세요"); return; }
    const built = buildOutputLinksFromForm([
      { url: lineLink1, label: lineLabel1 },
      { url: lineLink2, label: lineLabel2 },
    ]);
    if (!built.ok) { toast("error", built.error); return; }
    const outputLinks = built.value;

    setSaving(true);
    try {
      // output_images = [{url, caption}] — 이미지 있는 항목만 포함. 캡션 비우면 null.
      const imgs: { url: string; caption: string | null }[] = [];
      for (const [img, cap] of [
        [lineImage1, lineCaption1],
        [lineImage2, lineCaption2],
      ] as const) {
        if (!img) continue;
        imgs.push({ url: img.url, caption: cap.trim() ? cap.trim() : null });
      }
      const payload = {
        competency_line_master_id: selectedMaster.id,
        // output_links 우선 + 레거시 컬럼 backward-compat mirror.
        output_links: outputLinks,
        output_link_1: outputLinks[0]?.url ?? null,
        output_link_2: outputLinks[1]?.url ?? null,
        output_images: imgs,
        target_user_ids: Array.from(selectedUserIds),
        week_id: targetWeekId,
        submission_opens_at: selectedWeek.submissionOpensAt,
        submission_closes_at: selectedWeek.submissionClosesAt,
      };
      console.log("[competency line open payload]", {
        selectedWeekId,
        selectedWeekOption: selectedWeek,
        body: payload,
      });
      const res = await fetch("/api/admin/cluster4/competency-lines", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) { console.error("[competency] open failed", json?.error); t.error("open", { status: res.status }); return; }
      console.warn("[line-opening] competency create", { targetCount: json.data?.targetCount ?? 0 });
      toast("success", LINE_OPENING_RESULT.openSuccess);
      resetLineForm(); setLineRefreshKey((k) => k + 1); await fetchInitialData();
    } catch { toast("error", "저장 중 오류"); } finally { setSaving(false); }
  }, [currentWeek, selectedWeek, selectedWeekId, canOpenSelected, selectedMaster, lineAssetValid, lineAssetCount, lineLink1, lineLabel1, lineLink2, lineLabel2, lineImage1, lineImage2, lineCaption1, lineCaption2, selectedUserIds, resetLineForm, fetchInitialData]);

  // 카페 댓글 닉네임 수집 (Phase 1 — read-only, DB/snapshot 미관여)
  const handleCollectCafeComments = useCallback(async () => {
    if (!cafeUrl.trim()) { setCafeError("게시글 URL을 입력해주세요"); return; }
    setCafeLoading(true); setCafeError(null); setCafeResult(null);
    try {
      const res = await fetch("/api/admin/cluster4/cafe-comments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: cafeUrl.trim() }),
      });
      const json = await res.json();
      if (!json.success) { setCafeError(json.message ?? json.error ?? "수집 실패"); return; }
      setCafeResult(json.data);
    } catch { setCafeError("댓글 수집 요청 중 오류가 발생했습니다"); } finally { setCafeLoading(false); }
  }, [cafeUrl]);

  if (loading) return <LoadingState active />;

  return (
    <div className="admin-section-stack-lg w-full min-w-0 px-4 py-6">
      <AdminPageHeader
        title="실무 역량"
        tabs={
          orgScoped
            ? buildLineOpeningTabs(pathname, searchParams, mainTab)
            : undefined
        }
      />

      {/* 헤더 [라인 관리]/[라인 개설] 2탭은 상단 Header title 영역에서 구동(본문엔 두지 않음).
          [라인 관리] = 기존 실무 역량 화면(아래 내부 탭 3종) 그대로 — 미수정. */}
      {mainTab === "manage" && (
        <>
      {/* [라인 관리] 상단 보드 — [실무 역량] Hub 제목 + 현재 상황(기간) + 주차 드롭다운 + 6 집계 카드.
          조직 분기 모드(?org)에서만. 집계는 라인 개설 탭과 동일 DTO(주차만 선택). 아래 기존 화면은 무수정. */}
      {orgScoped && <CompetencyLineManageBoard />}

      {/* 레거시 내부 탭바(라인 등록/라인 개설/카페 링크 집계) — 이번 phase 숨김(코드 보존). */}
      {SHOW_LEGACY_SECTIONS && (
      <div className="flex gap-1 border-b">
        <TabButton label="라인 등록" active={activeTab === "masters"} onClick={() => setActiveTab("masters")} />
        <TabButton label="라인 개설" active={activeTab === "opening"} onClick={() => setActiveTab("opening")} />
        <TabButton label="카페 링크 집계" active={activeTab === "cafe"} onClick={() => setActiveTab("cafe")} />
      </div>
      )}

      {/* ══ 라인 개설 ══ */}
      {SHOW_LEGACY_SECTIONS && activeTab === "opening" && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">라인 개설 대상 주차</CardTitle>
              <CardDescription>운영 기본값은 현재 주차이며, 테스트/검증 목적으로 직전 주차도 선택할 수 있습니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {weekOptions.length > 0 && (
                <div className="space-y-1">
                  <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    대상 주차
                    <AdminHelpIconButton
                      helpKey="admin.competency.manager.input.targetWeek"
                      title="대상 주차"
                    />
                  </Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={selectedWeekId}
                    onChange={(e) => setSelectedWeekId(e.target.value)}
                  >
                    <option value="">주차를 선택해주세요</option>
                    {weekOptions.map((w) => (
                      <option key={w.id} value={w.id} disabled={!w.canOpen}>
                        {w.label} ({formatClubDate(w.startDate)} ~ {formatClubDate(w.endDate)})
                        {w.isCurrent ? " · 현재" : ""}
                        {!w.canOpen ? " · 휴식" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {selectedWeek ? (
                <div className="space-y-1 text-sm">
                  <p><span className="font-medium">{formatBannerPeriod({ year: selectedWeek.year, seasonName: selectedWeek.seasonName, weekNumber: selectedWeek.weekNumber })}</span>{" "}({fmtDateWithDay(selectedWeek.startDate)} ~ {fmtDateWithDay(selectedWeek.endDate)})</p>
                  {selectedWeek.canOpen && selectedWeek.submissionOpensAt && selectedWeek.submissionClosesAt && (
                    <p className="text-muted-foreground">기입 기간: {fmtDateTimeWithDay(selectedWeek.submissionOpensAt)} ~ {fmtDateTimeWithDay(selectedWeek.submissionClosesAt)}</p>
                  )}
                  {!selectedWeek.canOpen && <p className="font-medium text-orange-600">선택한 주차는 공식 휴식 주차입니다.</p>}
                </div>
              ) : currentWeek ? (
                <div className="space-y-1 text-sm">
                  <p><span className="font-medium">{formatBannerPeriod({ year: currentWeek.year, seasonName: currentWeek.seasonName, weekNumber: currentWeek.weekNumber })}</span>{" "}({fmtDateWithDay(currentWeek.startDate)} ~ {fmtDateWithDay(currentWeek.endDate)})</p>
                  {!currentWeek.canOpen && <p className="font-medium text-orange-600">{currentWeek.isOfficialRest ? "이번 주는 공식 휴식 주차입니다." : "현재 주차 데이터가 없습니다."}</p>}
                </div>
              ) : <p className="text-sm text-muted-foreground">주차 정보를 불러올 수 없습니다.</p>}
            </CardContent>
          </Card>

          <Cluster4LineTable
            partType="competency"
            title="개설된 실무 역량 라인"
            nameColumnLabel="역량 라인"
            refreshSignal={lineRefreshKey}
            weekId={selectedWeekId}
          />

          {!lineFormOpen && canOpenSelected && <Button onClick={() => setLineFormOpen(true)}><Plus className="mr-2 h-4 w-4" /> 새 실무 역량 라인 개설</Button>}

          {lineFormOpen && canOpenSelected && (selectedWeek?.submissionClosesAt ?? currentWeek?.submissionClosesAt) && (
            <Card>
              <CardHeader><CardTitle className="text-base">새 실무 역량 라인</CardTitle><CardDescription>기입 마감: {fmtDateTimeWithDay((selectedWeek?.submissionClosesAt ?? currentWeek?.submissionClosesAt) as string)}</CardDescription></CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label className="inline-flex items-center gap-1">라인 <span className="text-red-500">*</span>
                    <AdminHelpIconButton
                      helpKey="admin.competency.manager.input.line"
                      title="라인"
                    />
                  </Label>
                  <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={selectedMasterId} onChange={(e) => setSelectedMasterId(e.target.value)}>
                    <option value="">선택해주세요</option>
                    {activeMasters.map((m) => <option key={m.id} value={m.id}>{m.lineName}</option>)}
                  </select>
                </div>

                {selectedMaster && (
                  <div className="space-y-3 rounded-md border bg-muted/30 p-4">
                    <div className="space-y-1"><Label className="text-xs text-muted-foreground">라인 코드</Label><p className="font-mono text-sm">{selectedMaster.lineCode}</p></div>
                    <div className="space-y-1"><Label className="text-xs text-muted-foreground">메인 타이틀</Label><p className="text-sm">{lineMainTitle}</p></div>
                  </div>
                )}

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Output Asset <span className="text-red-500">*</span></Label>
                    <span className={cn("text-xs", lineAssetCount === 0 ? "text-red-500" : lineAssetCount <= 2 ? "text-green-600" : "text-red-500")}>{lineAssetCount}/2 (최소 1, 최대 2)</span>
                  </div>
                  <div className="grid gap-3">
                    <div className="space-y-1"><Label className="text-xs text-muted-foreground">Link 1 URL</Label><Input value={lineLink1} onChange={(e) => setLineLink1(e.target.value)} placeholder={OUTPUT_LINK_URL_PLACEHOLDER} disabled={!lineLink1.trim() && lineAssetCount >= 2} /><Input value={lineLabel1} onChange={(e) => setLineLabel1(e.target.value)} placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER} aria-label="Link 1 설명" maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH} /></div>
                    <div className="space-y-1"><Label className="text-xs text-muted-foreground">Link 2 URL</Label><Input value={lineLink2} onChange={(e) => setLineLink2(e.target.value)} placeholder={OUTPUT_LINK_URL_PLACEHOLDER} disabled={!lineLink2.trim() && lineAssetCount >= 2} /><Input value={lineLabel2} onChange={(e) => setLineLabel2(e.target.value)} placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER} aria-label="Link 2 설명" maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH} /></div>
                    <ImageUploadSlot label="Image 1" image={lineImage1} caption={lineCaption1} onUpload={setLineImage1} onRemove={() => { setLineImage1(null); setLineCaption1(""); }} onCaptionChange={setLineCaption1} disabled={!lineImage1 && lineAssetCount >= 2} />
                    <ImageUploadSlot label="Image 2" image={lineImage2} caption={lineCaption2} onUpload={setLineImage2} onRemove={() => { setLineImage2(null); setLineCaption2(""); }} onCaptionChange={setLineCaption2} disabled={!lineImage2 && lineAssetCount >= 2} />
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between"><Label className="inline-flex items-center gap-1">개설 대상 크루 <span className="text-red-500">*</span>
                    <AdminHelpIconButton
                      helpKey="admin.competency.manager.input.targetCrew"
                      title="개설 대상 크루"
                    />
                  </Label><span className="text-xs text-muted-foreground">선택됨: {selectedUserIds.size}명</span></div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <select className="rounded-md border border-input bg-background px-2 py-1.5 text-xs" value={crewFilterTeam} onChange={(e) => setCrewFilterTeam(e.target.value)}>
                      <option value="">전체 팀</option>{teams.map((t) => <option key={t.id} value={t.teamName}>{t.teamName}</option>)}
                    </select>
                    <select className="rounded-md border border-input bg-background px-2 py-1.5 text-xs" value={crewFilterPart} onChange={(e) => setCrewFilterPart(e.target.value)}>
                      <option value="">전체 파트</option>{uniqueParts.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <select className="rounded-md border border-input bg-background px-2 py-1.5 text-xs" value={crewFilterLevel} onChange={(e) => setCrewFilterLevel(e.target.value)}>
                      <option value="">전체 레벨</option>{uniqueLevels.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                    <select className="rounded-md border border-input bg-background px-2 py-1.5 text-xs" value={crewFilterStatus} onChange={(e) => setCrewFilterStatus(e.target.value)}>
                      <option value="active">활동중</option><option value="rest">휴식중</option><option value="">전체</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" placeholder="이름 검색..." value={crewSearch} onChange={(e) => setCrewSearch(e.target.value)} /></div>
                    <Button variant="outline" size="sm" onClick={selectAllFiltered}>전체 선택</Button>
                    <Button variant="outline" size="sm" onClick={deselectAll}>선택 해제</Button>
                  </div>
                  <div className="max-h-60 overflow-y-auto rounded-md border p-2">
                    {filteredCrews.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">{crews.length === 0 ? "등록된 크루가 없습니다" : "검색 결과가 없습니다"}</p> : (
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {filteredCrews.map((c) => (
                          <label key={c.userId} className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted", selectedUserIds.has(c.userId) && "bg-muted")}>
                            <input type="checkbox" className="rounded border-input" checked={selectedUserIds.has(c.userId)} onChange={() => toggleUser(c.userId)} />
                            <span className="truncate">{c.displayName}</span>
                            <span className="ml-auto text-xs text-muted-foreground">{[c.teamName, c.partName].filter(Boolean).join(" / ")}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <Button variant="outline" onClick={resetLineForm} disabled={saving}>취소</Button>
                  <Button onClick={handleSaveLine} loading={saving}>저장</Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ══ 라인 등록 ══ */}
      {SHOW_LEGACY_SECTIONS && activeTab === "masters" && (
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
                <div><CardTitle className="text-base">라인 등록</CardTitle><CardDescription>등록된 라인 {masters.length}개</CardDescription></div>
{/* (2E-6) 신규 생성 버튼 제거 — 통합 라인 등록 경로로 일원화 */}
              </div>
            </CardHeader>
            <CardContent>
              {masters.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">등록된 라인이 없습니다</p> : (
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        클럽
                        <AdminHelpIconButton helpKey="admin.competency.manager.master.org" title="클럽" />
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        라인 코드
                        <AdminHelpIconButton helpKey="admin.competency.manager.master.lineCode" title="라인 코드" />
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        라인명
                        <AdminHelpIconButton helpKey="admin.competency.manager.master.lineName" title="라인명" />
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        메인 타이틀
                        <AdminHelpIconButton helpKey="admin.competency.manager.master.mainTitle" title="메인 타이틀" />
                      </span>
                    </TableHead>
                    <TableHead className="text-center">
                      <span className="inline-flex items-center justify-center gap-1">
                        활성
                        <AdminHelpIconButton helpKey="admin.competency.manager.master.active" title="활성" />
                      </span>
                    </TableHead>
                    <TableHead className="w-20" />
                  </TableRow></TableHeader>
                  <TableBody>
                    {masters.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs">{formatOrgLabel(m.organizationSlug)}</TableCell>
                        <TableCell className="font-mono text-xs">{m.lineCode}</TableCell>
                        <TableCell className="font-medium">{m.lineName}</TableCell>
                        <TableCell className="max-w-xs truncate text-muted-foreground">{m.mainTitle ?? "-"}</TableCell>
                        <TableCell className="text-center">{m.isActive ? <Check className="mx-auto h-4 w-4 text-green-600" /> : <X className="mx-auto h-4 w-4 text-muted-foreground" />}</TableCell>
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
              <CardHeader className="pb-3"><CardTitle className="text-base">{editingMasterId ? "라인 등록 수정" : "새 라인 등록"}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>클럽 <span className="text-red-500">*</span></Label>
                  <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={mfOrgSlug} onChange={(e) => setMfOrgSlug(e.target.value)}>
                    <option value="">클럽을 선택하세요</option>
                    {ORG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2"><Label>라인 코드 <span className="text-red-500">*</span></Label><Input value={mfLineCode} onChange={(e) => setMfLineCode(e.target.value)} placeholder="CPBS-NN0001" /></div>
                  <div className="space-y-2"><Label>라인명 <span className="text-red-500">*</span></Label><Input value={mfLineName} onChange={(e) => setMfLineName(e.target.value)} placeholder="[실무 Principle. 1] 정량화" /></div>
                </div>
                <div className="space-y-2"><Label>메인 타이틀</Label><Input value={mfMainTitle} onChange={(e) => setMfMainTitle(e.target.value)} placeholder="메인 타이틀을 입력하세요" /></div>
                <div className="space-y-2"><Label>원본 파일명</Label><Input value={mfSourceFile} onChange={(e) => setMfSourceFile(e.target.value)} placeholder="source.xlsx" /></div>
                <div className="flex justify-end gap-3 pt-2">
                  <Button variant="outline" onClick={resetMasterForm} disabled={saving}>취소</Button>
                  <Button onClick={handleSaveMaster} loading={saving}>{editingMasterId ? "수정" : "저장"}</Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ══ 카페 링크 집계 — Phase 1: 댓글 작성자 닉네임 수집 (포인트/매칭/snapshot 미관여) ══ */}
      {SHOW_LEGACY_SECTIONS && activeTab === "cafe" && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">카페 댓글 닉네임 수집</CardTitle>
              <CardDescription>네이버 카페 게시글 URL을 입력하면 댓글 작성자 닉네임 목록을 수집합니다. (로컬 관리자 환경 전용)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Input
                  className="flex-1"
                  placeholder="https://cafe.naver.com/..."
                  value={cafeUrl}
                  onChange={(e) => setCafeUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !cafeLoading) handleCollectCafeComments(); }}
                  disabled={cafeLoading}
                />
                <Button onClick={handleCollectCafeComments} loading={cafeLoading}>
                  <Search className="mr-2 h-4 w-4" />
                  댓글 수집
                </Button>
              </div>
              {cafeLoading && <p className="text-xs text-muted-foreground">댓글 페이지를 순회하며 수집 중입니다. 댓글 수에 따라 수십 초가 걸릴 수 있습니다.</p>}
              {cafeError && <p className="text-sm text-red-600">{cafeError}</p>}
            </CardContent>
          </Card>

          {cafeResult && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">수집 결과</CardTitle>
                <CardDescription className="break-all">{cafeResult.articleUrl}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-3 sm:max-w-xl">
                  <div className="rounded-md border bg-muted/30 p-4 text-center">
                    <p className="text-2xl font-bold">{cafeResult.totalComments}</p>
                    <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      전체 댓글 수
                      <AdminHelpIconButton helpKey="admin.competency.manager.cafe.totalComments" title="전체 댓글 수" />
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-4 text-center">
                    <p className="text-2xl font-bold">{cafeResult.uniqueNicknames}</p>
                    <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      참여 인원 수
                      <AdminHelpIconButton helpKey="admin.competency.manager.cafe.uniqueNicknames" title="참여 인원 수" />
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-4 text-center">
                    <p className="text-2xl font-bold">{cafeResult.totalComments - cafeResult.uniqueNicknames}</p>
                    <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      추가 댓글 수
                      <AdminHelpIconButton helpKey="admin.competency.manager.cafe.extraComments" title="추가 댓글 수" />
                    </p>
                  </div>
                </div>
                {cafeResult.nicknameCounts.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">수집된 댓글이 없습니다</p>
                ) : (
                  <Table>
                    {/* 컬럼 확장 예정: 추후 회원 매칭 단계에서 "회원 매칭" 컬럼 추가 (Phase 2) */}
                    <TableHeader><TableRow><TableHead className="w-12">#</TableHead>
                      <TableHead>
                        <span className="inline-flex items-center gap-1">
                          닉네임
                          <AdminHelpIconButton helpKey="admin.competency.manager.cafe.nickname" title="닉네임" />
                        </span>
                      </TableHead>
                      <TableHead className="w-24">
                        <span className="inline-flex items-center gap-1">
                          댓글 수
                          <AdminHelpIconButton helpKey="admin.competency.manager.cafe.commentCount" title="댓글 수" />
                        </span>
                      </TableHead></TableRow></TableHeader>
                    <TableBody>
                      {[...cafeResult.nicknameCounts]
                        .sort((a, b) => b.count - a.count || a.nickname.localeCompare(b.nickname, "ko"))
                        .map((n, i) => (
                          <TableRow key={n.nickname}>
                            <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                            <TableCell className="font-medium">{n.nickname}</TableCell>
                            <TableCell>{n.count}</TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
        </>
      )}

      {/* [라인 개설] 탭 — 실무 역량 라인 개설 운영 대시보드(상태창+로그창+개설 완료/취소).
          허브 전체 is_active 토글로 고객 반영. 파트장 신청/검수 없음. snapshot 생성/조회 무변경. */}
      {mainTab === "open" && <CompetencyOpeningDashboard />}
    </div>
  );
}
