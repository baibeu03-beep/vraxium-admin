"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Search, Check, X, Upload, Trash2, Pencil } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  ORGANIZATIONS,
  ORGANIZATION_LABEL,
  ORGANIZATION_COMMON_LABEL,
} from "@/lib/organizations";
import Cluster4LineTable from "@/components/admin/cluster4/Cluster4LineTable";
import {
  buildOutputLinksFromForm,
  OUTPUT_LINK_LABEL_PLACEHOLDER,
  OUTPUT_LINK_URL_PLACEHOLDER,
} from "@/lib/cluster4OutputLinks";

const ORG_OPTIONS: Array<{ value: string; label: string }> = [
  ...ORGANIZATIONS.map((slug) => ({ value: slug, label: ORGANIZATION_LABEL[slug] })),
  { value: "common", label: ORGANIZATION_COMMON_LABEL },
];

function formatOrgLabel(slug: string | null | undefined): string {
  if (!slug) return "-";
  if (slug === "common") return ORGANIZATION_COMMON_LABEL;
  return (ORGANIZATION_LABEL as Record<string, string>)[slug] ?? slug;
}

type Banner = { kind: "success" | "error"; message: string } | null;
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
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${DAY_NAMES[d.getDay()]}) ${ampm} ${h}:${String(min).padStart(2, "0")}`;
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
      if (!json.success) { alert(json.error || "업로드 실패"); return; }
      onUpload({ url: json.data.url, name: file.name });
    } catch { alert("업로드 중 오류"); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
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
          <Button variant="outline" className="w-full" disabled={disabled || uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {uploading ? "업로드 중..." : "이미지 업로드"}
          </Button>
        </div>
      )}
      {/* 이미지 캡션 — 업로드 전/후 항상 노출. 이미지 없으면 payload 미포함. 비우면 null 저장. */}
      {onCaptionChange && (
        <Input value={caption ?? ""} onChange={(e) => onCaptionChange(e.target.value)} placeholder="이미지 캡션을 입력하세요" aria-label={`${label} 캡션`} disabled={disabled} />
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

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
        fetch("/api/admin/cluster4/weeks-options?limit=3"),
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
      const [teamsRes, mastersRes, linesRes, crewsRes] = await Promise.all([
        fetch(`/api/admin/cluster4/teams${orgParam}`),
        // 라인 등록 데이터는 조직별 권한 분리 전 단계라 전체 조직을 조회한다.
        fetch(`/api/admin/cluster4/competency-line-masters`),
        fetch("/api/admin/cluster4/lines?partType=competency&limit=100"),
        fetch(`/api/admin/cluster4/crews${orgParam ? orgParam + "&" : "?"}status=active`),
      ]);
      const teamsJson = await teamsRes.json(); if (teamsJson.success) setTeams(teamsJson.data);
      const mastersJson = await mastersRes.json(); if (mastersJson.success) setMasters(mastersJson.data);
      const linesJson = await linesRes.json(); if (linesJson.success) setExistingLines(linesJson.data?.rows ?? linesJson.data ?? []);
      const crewsJson = await crewsRes.json(); if (crewsJson.success) setCrews(crewsJson.data);
    } catch { setBanner({ kind: "error", message: "데이터를 불러오는데 실패했습니다" }); } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchInitialData(); }, [fetchInitialData]);

  const refetchCrews = useCallback(async () => {
    if (!adminOrg) return;
    const params = new URLSearchParams(); params.set("organization", adminOrg);
    if (crewFilterStatus) params.set("status", crewFilterStatus);
    try { const res = await fetch(`/api/admin/cluster4/crews?${params}`); const json = await res.json(); if (json.success) setCrews(json.data); } catch { /* silent */ }
  }, [adminOrg, crewFilterStatus]);

  useEffect(() => { if (!loading) refetchCrews(); }, [crewFilterStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Master form
  const resetMasterForm = useCallback(() => { setMfOrgSlug(""); setMfLineCode(""); setMfLineName(""); setMfMainTitle(""); setMfSourceFile(""); setEditingMasterId(null); setMasterFormOpen(false); }, []);

  const openEditMaster = useCallback((m: LineMasterItem) => {
    setEditingMasterId(m.id); setMfOrgSlug(m.organizationSlug ?? ""); setMfLineCode(m.lineCode); setMfLineName(m.lineName); setMfMainTitle(m.mainTitle ?? ""); setMfSourceFile(m.sourceFileName ?? ""); setMasterFormOpen(true);
  }, []);

  const handleSaveMaster = useCallback(async () => {
    const orgSlug = (mfOrgSlug || adminOrg || "").trim();
    if (!orgSlug) { setBanner({ kind: "error", message: "조직은 필수입니다" }); return; }
    if (!mfLineCode.trim() || !mfLineName.trim()) { setBanner({ kind: "error", message: "라인 코드와 라인명은 필수입니다" }); return; }
    setSaving(true); setBanner(null);
    try {
      const payload: Record<string, unknown> = { organization_slug: orgSlug, line_code: mfLineCode.trim(), line_name: mfLineName.trim(), main_title: mfMainTitle.trim() || null, source_file_name: mfSourceFile.trim() || null };
      const url = editingMasterId ? `/api/admin/cluster4/competency-line-masters/${editingMasterId}` : "/api/admin/cluster4/competency-line-masters";
      const res = await fetch(url, { method: editingMasterId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await res.json();
      if (!json.success) { setBanner({ kind: "error", message: json.error ?? "저장 실패" }); return; }
      setBanner({ kind: "success", message: editingMasterId ? "라인이 수정되었습니다" : "라인이 등록되었습니다" });
      resetMasterForm(); await fetchInitialData();
    } catch { setBanner({ kind: "error", message: "저장 중 오류가 발생했습니다" }); } finally { setSaving(false); }
  }, [mfOrgSlug, mfLineCode, mfLineName, mfMainTitle, mfSourceFile, adminOrg, editingMasterId, resetMasterForm, fetchInitialData]);

  const handleDeleteMaster = useCallback(async (id: string) => {
    if (!confirm("이 라인을 삭제하시겠습니까?")) return;
    try { const res = await fetch(`/api/admin/cluster4/competency-line-masters/${id}`, { method: "DELETE" }); const json = await res.json(); if (!json.success) { setBanner({ kind: "error", message: json.error ?? "삭제 실패" }); return; } setBanner({ kind: "success", message: "삭제되었습니다" }); await fetchInitialData(); } catch { setBanner({ kind: "error", message: "삭제 중 오류" }); }
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
    if (!selectedWeekId) { setBanner({ kind: "error", message: "주차를 선택해주세요" }); return; }
    const targetWeekId = selectedWeek?.id ?? null;
    if (!targetWeekId) { setBanner({ kind: "error", message: "선택한 주차 정보를 확인할 수 없습니다" }); return; }
    if (!selectedWeek?.canOpen) { setBanner({ kind: "error", message: "선택한 주차는 라인 개설이 불가합니다" }); return; }
    if (!selectedMaster) { setBanner({ kind: "error", message: "라인을 선택해주세요" }); return; }
    if (!lineAssetValid) { setBanner({ kind: "error", message: lineAssetCount < 1 ? "Output을 최소 1개 입력해주세요" : "Output은 최대 2개까지 입력 가능합니다" }); return; }
    if (selectedUserIds.size === 0) { setBanner({ kind: "error", message: "개설 대상을 최소 1명 이상 선택해주세요" }); return; }
    const built = buildOutputLinksFromForm([
      { url: lineLink1, label: lineLabel1 },
      { url: lineLink2, label: lineLabel2 },
    ]);
    if (!built.ok) { setBanner({ kind: "error", message: built.error }); return; }
    const outputLinks = built.value;

    setSaving(true); setBanner(null);
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
      if (!json.success) { setBanner({ kind: "error", message: json.error ?? "저장 실패" }); return; }
      setBanner({ kind: "success", message: `실무 역량 라인이 생성되었습니다 (대상: ${json.data?.targetCount ?? 0}명)` });
      resetLineForm(); setLineRefreshKey((k) => k + 1); await fetchInitialData();
    } catch { setBanner({ kind: "error", message: "저장 중 오류" }); } finally { setSaving(false); }
  }, [currentWeek, selectedWeek, selectedWeekId, canOpenSelected, selectedMaster, lineAssetValid, lineAssetCount, lineLink1, lineLabel1, lineLink2, lineLabel2, lineImage1, lineImage2, lineCaption1, lineCaption2, selectedUserIds, resetLineForm, fetchInitialData]);

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6">
      <h1 className="text-2xl font-bold">실무 역량 라인 관리</h1>

      {banner && (
        <div className={cn("rounded-md border px-4 py-3 text-sm", banner.kind === "success" ? "border-green-300 bg-green-50 text-green-800" : "border-red-300 bg-red-50 text-red-800")}>
          {banner.message}
          <button className="float-right" onClick={() => setBanner(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="flex gap-1 border-b">
        <TabButton label="라인 등록" active={activeTab === "masters"} onClick={() => setActiveTab("masters")} />
        <TabButton label="라인 개설" active={activeTab === "opening"} onClick={() => setActiveTab("opening")} />
        <TabButton label="카페 링크 집계" active={activeTab === "cafe"} onClick={() => setActiveTab("cafe")} disabled />
      </div>

      {/* ══ 라인 개설 ══ */}
      {activeTab === "opening" && (
        <div className="space-y-4">
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
                  <p><span className="font-medium">{selectedWeek.year} {selectedWeek.seasonName} W{selectedWeek.weekNumber}</span>{" "}({fmtDateWithDay(selectedWeek.startDate)} ~ {fmtDateWithDay(selectedWeek.endDate)})</p>
                  {selectedWeek.canOpen && selectedWeek.submissionOpensAt && selectedWeek.submissionClosesAt && (
                    <p className="text-muted-foreground">기입 기간: {fmtDateTimeWithDay(selectedWeek.submissionOpensAt)} ~ {fmtDateTimeWithDay(selectedWeek.submissionClosesAt)}</p>
                  )}
                  {!selectedWeek.canOpen && <p className="font-medium text-orange-600">선택한 주차는 공식 휴식 주차입니다.</p>}
                </div>
              ) : currentWeek ? (
                <div className="space-y-1 text-sm">
                  <p><span className="font-medium">{currentWeek.year} {currentWeek.seasonName} W{currentWeek.weekNumber}</span>{" "}({fmtDateWithDay(currentWeek.startDate)} ~ {fmtDateWithDay(currentWeek.endDate)})</p>
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
                  <Label>라인 <span className="text-red-500">*</span></Label>
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
                    <div className="space-y-1"><Label className="text-xs text-muted-foreground">Link 1 URL</Label><Input value={lineLink1} onChange={(e) => setLineLink1(e.target.value)} placeholder={OUTPUT_LINK_URL_PLACEHOLDER} disabled={!lineLink1.trim() && lineAssetCount >= 2} /><Input value={lineLabel1} onChange={(e) => setLineLabel1(e.target.value)} placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER} aria-label="Link 1 설명" /></div>
                    <div className="space-y-1"><Label className="text-xs text-muted-foreground">Link 2 URL</Label><Input value={lineLink2} onChange={(e) => setLineLink2(e.target.value)} placeholder={OUTPUT_LINK_URL_PLACEHOLDER} disabled={!lineLink2.trim() && lineAssetCount >= 2} /><Input value={lineLabel2} onChange={(e) => setLineLabel2(e.target.value)} placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER} aria-label="Link 2 설명" /></div>
                    <ImageUploadSlot label="Image 1" image={lineImage1} caption={lineCaption1} onUpload={setLineImage1} onRemove={() => { setLineImage1(null); setLineCaption1(""); }} onCaptionChange={setLineCaption1} disabled={!lineImage1 && lineAssetCount >= 2} />
                    <ImageUploadSlot label="Image 2" image={lineImage2} caption={lineCaption2} onUpload={setLineImage2} onRemove={() => { setLineImage2(null); setLineCaption2(""); }} onCaptionChange={setLineCaption2} disabled={!lineImage2 && lineAssetCount >= 2} />
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between"><Label>개설 대상 크루 <span className="text-red-500">*</span></Label><span className="text-xs text-muted-foreground">선택됨: {selectedUserIds.size}명</span></div>
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
                            <input type="checkbox" className="rounded border-gray-300" checked={selectedUserIds.has(c.userId)} onChange={() => toggleUser(c.userId)} />
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
                  <Button onClick={handleSaveLine} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}저장</Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ══ 라인 등록 ══ */}
      {activeTab === "masters" && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div><CardTitle className="text-base">라인 등록</CardTitle><CardDescription>등록된 라인 {masters.length}개</CardDescription></div>
                {!masterFormOpen && <Button size="sm" onClick={() => setMasterFormOpen(true)}><Plus className="mr-1 h-4 w-4" /> 새 라인</Button>}
              </div>
            </CardHeader>
            <CardContent>
              {masters.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">등록된 라인이 없습니다</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>조직</TableHead><TableHead>라인 코드</TableHead><TableHead>라인명</TableHead><TableHead>메인 타이틀</TableHead><TableHead className="text-center">활성</TableHead><TableHead className="w-20" /></TableRow></TableHeader>
                  <TableBody>
                    {masters.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs">{formatOrgLabel(m.organizationSlug)}</TableCell>
                        <TableCell className="font-mono text-xs">{m.lineCode}</TableCell>
                        <TableCell className="font-medium">{m.lineName}</TableCell>
                        <TableCell className="max-w-xs truncate text-muted-foreground">{m.mainTitle ?? "-"}</TableCell>
                        <TableCell className="text-center">{m.isActive ? <Check className="mx-auto h-4 w-4 text-green-600" /> : <X className="mx-auto h-4 w-4 text-muted-foreground" />}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditMaster(m)}><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDeleteMaster(m.id)}><Trash2 className="h-3.5 w-3.5 text-red-500" /></Button>
                          </div>
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
                  <Label>조직 <span className="text-red-500">*</span></Label>
                  <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={mfOrgSlug} onChange={(e) => setMfOrgSlug(e.target.value)}>
                    <option value="">조직을 선택하세요</option>
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
                  <Button onClick={handleSaveMaster} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{editingMasterId ? "수정" : "저장"}</Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ══ 카페 링크 집계 (준비 중) ══ */}
      {activeTab === "cafe" && (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-lg font-medium text-muted-foreground">카페 링크 집계 기능은 준비 중입니다</p>
            <p className="mt-2 text-sm text-muted-foreground">이 기능은 Phase 2에서 제공될 예정입니다.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
