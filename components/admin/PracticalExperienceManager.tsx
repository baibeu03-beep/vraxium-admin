"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  Search,
  Check,
  X,
  Upload,
  Trash2,
  Pencil,
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

type TeamItem = {
  id: string;
  teamName: string;
  organizationSlug: string;
  isActive: boolean;
};

type LineMasterItem = {
  id: string;
  lineCode: string;
  lineName: string;
  mainTitle: string | null;
  teamId: string | null;
  teamName: string | null;
  sourceFileName: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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

type TabKey = "masters" | "opening" | "evaluation";

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
// Image Upload Component (reused from PracticalInfoManager)
// ──────────────────────────────────────────────────────────────

function ImageUploadSlot({
  label,
  image,
  onUpload,
  onRemove,
  disabled,
}: {
  label: string;
  image: UploadedImage | null;
  onUpload: (img: UploadedImage) => void;
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

export default function PracticalExperienceManager() {
  const [activeTab, setActiveTab] = useState<TabKey>("masters");
  const [adminOrg, setAdminOrg] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [masters, setMasters] = useState<LineMasterItem[]>([]);
  const [currentWeek, setCurrentWeek] = useState<CurrentWeekData | null>(null);
  const [existingLines, setExistingLines] = useState<ExistingLineDto[]>([]);
  const [crews, setCrews] = useState<CrewItem[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  // ── Master form state ──
  const [masterFormOpen, setMasterFormOpen] = useState(false);
  const [editingMasterId, setEditingMasterId] = useState<string | null>(null);
  const [mfLineCode, setMfLineCode] = useState("");
  const [mfLineName, setMfLineName] = useState("");
  const [mfDefaultTitle, setMfDefaultTitle] = useState("");
  const [mfTeamId, setMfTeamId] = useState("");
  const [mfSourceFile, setMfSourceFile] = useState("");

  // ── Line opening form state ──
  const [lineFormOpen, setLineFormOpen] = useState(false);
  const [selectedMasterId, setSelectedMasterId] = useState("");
  const [lineLink1, setLineLink1] = useState("");
  const [lineLink2, setLineLink2] = useState("");
  const [lineImage1, setLineImage1] = useState<UploadedImage | null>(null);
  const [lineImage2, setLineImage2] = useState<UploadedImage | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());

  // ── Crew filter state ──
  const [crewFilterTeam, setCrewFilterTeam] = useState("");
  const [crewFilterPart, setCrewFilterPart] = useState("");
  const [crewFilterLevel, setCrewFilterLevel] = useState("");
  const [crewFilterStatus, setCrewFilterStatus] = useState("active");
  const [crewSearch, setCrewSearch] = useState("");

  // ── Computed ──
  const lineAssetCount = useMemo(() => {
    let count = 0;
    if (lineLink1.trim()) count++;
    if (lineLink2.trim()) count++;
    if (lineImage1) count++;
    if (lineImage2) count++;
    return count;
  }, [lineLink1, lineLink2, lineImage1, lineImage2]);

  const lineAssetValid = lineAssetCount >= 1 && lineAssetCount <= 2;

  const selectedMaster = useMemo(
    () => masters.find((m) => m.id === selectedMasterId) ?? null,
    [masters, selectedMasterId],
  );

  const activeMasters = useMemo(
    () => masters.filter((m) => m.isActive),
    [masters],
  );

  const uniqueParts = useMemo(() => {
    const set = new Set<string>();
    for (const c of crews) {
      if (c.partName) set.add(c.partName);
    }
    return Array.from(set).sort();
  }, [crews]);

  const uniqueLevels = useMemo(() => {
    const set = new Set<string>();
    for (const c of crews) {
      if (c.membershipLevel) set.add(c.membershipLevel);
    }
    return Array.from(set).sort();
  }, [crews]);

  const filteredCrews = useMemo(() => {
    let result = crews;
    if (crewFilterTeam) {
      result = result.filter((c) => c.teamName === crewFilterTeam);
    }
    if (crewFilterPart) {
      result = result.filter((c) => c.partName === crewFilterPart);
    }
    if (crewFilterLevel) {
      result = result.filter((c) => c.membershipLevel === crewFilterLevel);
    }
    if (crewSearch.trim()) {
      const q = crewSearch.trim().toLowerCase();
      result = result.filter((c) => c.displayName.toLowerCase().includes(q));
    }
    return result;
  }, [crews, crewFilterTeam, crewFilterPart, crewFilterLevel, crewSearch]);

  // ── Data fetching ──
  const fetchInitialData = useCallback(async () => {
    setLoading(true);
    try {
      const [orgRes, weekRes] = await Promise.all([
        fetch("/api/admin/cluster4/admin-org"),
        fetch("/api/admin/cluster4/current-week"),
      ]);

      const orgJson = await orgRes.json();
      const org = orgJson.success ? orgJson.data.organization : null;
      setAdminOrg(org);

      const weekJson = await weekRes.json();
      if (weekJson.success) setCurrentWeek(weekJson.data);

      const orgParam = org ? `?organization=${org}` : "";
      const [teamsRes, mastersRes, linesRes, crewsRes] = await Promise.all([
        fetch(`/api/admin/cluster4/teams${orgParam}`),
        fetch(`/api/admin/cluster4/experience-line-masters${orgParam}`),
        fetch("/api/admin/cluster4/lines?partType=experience&limit=100"),
        fetch(`/api/admin/cluster4/crews${orgParam ? orgParam + "&" : "?"}status=active`),
      ]);

      const teamsJson = await teamsRes.json();
      if (teamsJson.success) setTeams(teamsJson.data);

      const mastersJson = await mastersRes.json();
      if (mastersJson.success) setMasters(mastersJson.data);

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

  const refetchCrews = useCallback(async () => {
    if (!adminOrg) return;
    try {
      const params = new URLSearchParams();
      params.set("organization", adminOrg);
      if (crewFilterStatus) params.set("status", crewFilterStatus);
      const res = await fetch(`/api/admin/cluster4/crews?${params}`);
      const json = await res.json();
      if (json.success) setCrews(json.data);
    } catch {
      // silent
    }
  }, [adminOrg, crewFilterStatus]);

  useEffect(() => {
    if (!loading) refetchCrews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crewFilterStatus]);

  // ── Master form helpers ──
  const resetMasterForm = useCallback(() => {
    setMfLineCode("");
    setMfLineName("");
    setMfDefaultTitle("");
    setMfTeamId("");
    setMfSourceFile("");
    setEditingMasterId(null);
    setMasterFormOpen(false);
  }, []);

  const openEditMaster = useCallback(
    (m: LineMasterItem) => {
      setEditingMasterId(m.id);
      setMfLineCode(m.lineCode);
      setMfLineName(m.lineName);
      setMfDefaultTitle(m.mainTitle ?? "");
      setMfTeamId(m.teamId ?? "");
      setMfSourceFile(m.sourceFileName ?? "");
      setMasterFormOpen(true);
    },
    [],
  );

  const handleSaveMaster = useCallback(async () => {
    if (!mfLineCode.trim() || !mfLineName.trim()) {
      setBanner({ kind: "error", message: "라인 코드와 라인명은 필수입니다" });
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = {
        organization_slug: adminOrg,
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
        message: editingMasterId ? "라인 마스터가 수정되었습니다" : "라인 마스터가 생성되었습니다",
      });
      resetMasterForm();
      await fetchInitialData();
    } catch {
      setBanner({ kind: "error", message: "저장 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [
    mfLineCode,
    mfLineName,
    mfDefaultTitle,
    mfTeamId,
    mfSourceFile,
    editingMasterId,
    resetMasterForm,
    fetchInitialData,
  ]);

  const handleDeleteMaster = useCallback(
    async (id: string) => {
      if (!confirm("이 라인 마스터를 삭제하시겠습니까?")) return;
      try {
        const res = await fetch(
          `/api/admin/cluster4/experience-line-masters/${id}`,
          { method: "DELETE" },
        );
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
    [fetchInitialData],
  );

  // ── Line opening helpers ──
  const resetLineForm = useCallback(() => {
    setSelectedMasterId("");
    setLineLink1("");
    setLineLink2("");
    setLineImage1(null);
    setLineImage2(null);
    setSelectedUserIds(new Set());
    setCrewSearch("");
    setLineFormOpen(false);
  }, []);

  const lineMainTitle = selectedMaster?.mainTitle ?? selectedMaster?.lineName ?? "";

  const toggleUser = useCallback((userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const selectAllFiltered = useCallback(() => {
    setSelectedUserIds(new Set(filteredCrews.map((c) => c.userId)));
  }, [filteredCrews]);

  const deselectAll = useCallback(() => {
    setSelectedUserIds(new Set());
  }, []);

  const handleSaveLine = useCallback(async () => {
    if (!currentWeek?.weekId || !currentWeek.canOpen) return;

    if (!selectedMaster) {
      setBanner({ kind: "error", message: "라인을 선택해주세요" });
      return;
    }
    if (!lineAssetValid) {
      setBanner({
        kind: "error",
        message:
          lineAssetCount < 1
            ? "Output을 최소 1개 입력해주세요"
            : "Output은 최대 2개까지 입력 가능합니다",
      });
      return;
    }
    if (selectedUserIds.size === 0) {
      setBanner({ kind: "error", message: "개설 대상을 최소 1명 이상 선택해주세요" });
      return;
    }

    setSaving(true);
    setBanner(null);
    try {
      const outputImages: string[] = [];
      if (lineImage1) outputImages.push(lineImage1.url);
      if (lineImage2) outputImages.push(lineImage2.url);

      const res = await fetch("/api/admin/cluster4/experience-lines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experience_line_master_id: selectedMaster.id,
          line_code: selectedMaster.lineCode,
          main_title: selectedMaster.mainTitle ?? selectedMaster.lineName,
          team_id: selectedMaster.teamId,
          output_link_1: lineLink1.trim() || null,
          output_link_2: lineLink2.trim() || null,
          output_images: outputImages,
          target_user_ids: Array.from(selectedUserIds),
          week_id: currentWeek.weekId,
          submission_opens_at: currentWeek.submissionOpensAt,
          submission_closes_at: currentWeek.submissionClosesAt,
        }),
      });

      const json = await res.json();
      if (!json.success) {
        setBanner({ kind: "error", message: json.error ?? "저장에 실패했습니다" });
        return;
      }

      setBanner({
        kind: "success",
        message: `실무 경험 라인이 생성되었습니다 (대상: ${json.data?.targetCount ?? 0}명)`,
      });
      resetLineForm();
      await fetchInitialData();
    } catch {
      setBanner({ kind: "error", message: "저장 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [
    currentWeek,
    selectedMaster,
    lineAssetValid,
    lineAssetCount,
    lineLink1,
    lineLink2,
    lineImage1,
    lineImage2,
    selectedUserIds,
    resetLineForm,
    fetchInitialData,
  ]);

  // ── Render ──
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">실무 경험 라인 관리</h1>

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
          label="라인 마스터"
          active={activeTab === "masters"}
          onClick={() => setActiveTab("masters")}
        />
        <TabButton
          label="라인 개설"
          active={activeTab === "opening"}
          onClick={() => setActiveTab("opening")}
        />
        <TabButton
          label="평가 관리"
          active={activeTab === "evaluation"}
          onClick={() => setActiveTab("evaluation")}
          disabled
        />
      </div>

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab: 라인 마스터 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "masters" && (
        <div className="space-y-4">
          {/* Master list */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">실무 경험 라인 마스터</CardTitle>
                  <CardDescription>
                    등록된 마스터 {masters.length}개
                    {adminOrg && <span className="ml-1">({adminOrg})</span>}
                  </CardDescription>
                </div>
                {!masterFormOpen && (
                  <Button size="sm" onClick={() => setMasterFormOpen(true)}>
                    <Plus className="mr-1 h-4 w-4" /> 새 마스터
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {masters.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  등록된 라인 마스터가 없습니다
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>라인 코드</TableHead>
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
                        <TableCell className="font-mono text-xs">
                          {m.lineCode}
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
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => openEditMaster(m)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => handleDeleteMaster(m.id)}
                            >
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

          {/* Master form */}
          {masterFormOpen && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  {editingMasterId ? "라인 마스터 수정" : "새 라인 마스터"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>
                      라인 코드 <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      value={mfLineCode}
                      onChange={(e) => setMfLineCode(e.target.value)}
                      placeholder="exp-design"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>
                      라인명 <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      value={mfLineName}
                      onChange={(e) => setMfLineName(e.target.value)}
                      placeholder="디자인 실무"
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
      {/* Tab: 라인 개설 */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "opening" && (
        <div className="space-y-4">
          {/* Current Week */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">현재 개설 주차</CardTitle>
            </CardHeader>
            <CardContent>
              {currentWeek ? (
                <div className="space-y-1 text-sm">
                  <p>
                    <span className="font-medium">
                      {currentWeek.year} {currentWeek.seasonName} W
                      {currentWeek.weekNumber}
                    </span>{" "}
                    ({fmtDateWithDay(currentWeek.startDate)} ~{" "}
                    {fmtDateWithDay(currentWeek.endDate)})
                  </p>
                  {currentWeek.canOpen &&
                    currentWeek.submissionOpensAt &&
                    currentWeek.submissionClosesAt && (
                      <p className="text-muted-foreground">
                        제출 기간: {fmtDateTimeWithDay(currentWeek.submissionOpensAt)} ~{" "}
                        {fmtDateTimeWithDay(currentWeek.submissionClosesAt)}
                      </p>
                    )}
                  {!currentWeek.canOpen && (
                    <p className="font-medium text-orange-600">
                      {currentWeek.isOfficialRest
                        ? "이번 주는 공식 휴식 주차입니다. 라인 개설이 불가합니다."
                        : "현재 주차에 해당하는 주차 데이터가 없습니다."}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  주차 정보를 불러올 수 없습니다.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Existing experience lines */}
          {existingLines.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">개설된 실무 경험 라인</CardTitle>
                <CardDescription>
                  현재 등록된 실무 경험 라인 {existingLines.length}개
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>라인 코드</TableHead>
                      <TableHead>메인 타이틀</TableHead>
                      <TableHead className="text-center">대상</TableHead>
                      <TableHead className="text-center">활성</TableHead>
                      <TableHead>생성일</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {existingLines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell className="font-mono text-xs">
                          {line.lineCode ?? "-"}
                        </TableCell>
                        <TableCell>{line.mainTitle}</TableCell>
                        <TableCell className="text-center">
                          {line.targetCount}명
                        </TableCell>
                        <TableCell className="text-center">
                          {line.isActive ? (
                            <Check className="mx-auto h-4 w-4 text-green-600" />
                          ) : (
                            <X className="mx-auto h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {fmtDateShort(line.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* New line button */}
          {!lineFormOpen && currentWeek?.canOpen && (
            <Button onClick={() => setLineFormOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> 새 실무 경험 라인 개설
            </Button>
          )}

          {/* New line form */}
          {lineFormOpen && currentWeek?.canOpen && currentWeek.submissionClosesAt && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">새 실무 경험 라인</CardTitle>
                <CardDescription>
                  제출 마감: {fmtDateTimeWithDay(currentWeek.submissionClosesAt)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Master selection */}
                <div className="space-y-2">
                  <Label>
                    라인 <span className="text-red-500">*</span>
                  </Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={selectedMasterId}
                    onChange={(e) => setSelectedMasterId(e.target.value)}
                  >
                    <option value="">선택해주세요</option>
                    {activeMasters.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.lineName}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Auto-populated fields from master */}
                {selectedMaster && (
                  <div className="space-y-3 rounded-md border bg-muted/30 p-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">라인 코드</Label>
                      <p className="font-mono text-sm">{selectedMaster.lineCode}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">메인 타이틀</Label>
                      <p className="text-sm">{lineMainTitle}</p>
                    </div>
                    {selectedMaster.teamName && (
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">팀</Label>
                        <p className="text-sm">{selectedMaster.teamName}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Output Assets */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>
                      Output Asset <span className="text-red-500">*</span>
                    </Label>
                    <span
                      className={cn(
                        "text-xs",
                        lineAssetCount === 0
                          ? "text-red-500"
                          : lineAssetCount <= 2
                            ? "text-green-600"
                            : "text-red-500",
                      )}
                    >
                      {lineAssetCount}/2 (최소 1, 최대 2)
                    </span>
                  </div>
                  <div className="grid gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="expLink1" className="text-xs text-muted-foreground">
                        Link 1
                      </Label>
                      <Input
                        id="expLink1"
                        value={lineLink1}
                        onChange={(e) => setLineLink1(e.target.value)}
                        placeholder="https://..."
                        disabled={!lineLink1.trim() && lineAssetCount >= 2}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="expLink2" className="text-xs text-muted-foreground">
                        Link 2
                      </Label>
                      <Input
                        id="expLink2"
                        value={lineLink2}
                        onChange={(e) => setLineLink2(e.target.value)}
                        placeholder="https://..."
                        disabled={!lineLink2.trim() && lineAssetCount >= 2}
                      />
                    </div>
                    <ImageUploadSlot
                      label="Image 1"
                      image={lineImage1}
                      onUpload={setLineImage1}
                      onRemove={() => setLineImage1(null)}
                      disabled={!lineImage1 && lineAssetCount >= 2}
                    />
                    <ImageUploadSlot
                      label="Image 2"
                      image={lineImage2}
                      onUpload={setLineImage2}
                      onRemove={() => setLineImage2(null)}
                      disabled={!lineImage2 && lineAssetCount >= 2}
                    />
                  </div>
                </div>

                {/* Target Crew Selection */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>
                      개설 대상 크루 <span className="text-red-500">*</span>
                    </Label>
                    <span className="text-xs text-muted-foreground">
                      선택됨: {selectedUserIds.size}명
                    </span>
                  </div>

                  {/* Filters */}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <select
                      className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                      value={crewFilterTeam}
                      onChange={(e) => setCrewFilterTeam(e.target.value)}
                    >
                      <option value="">전체 팀</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.teamName}>
                          {t.teamName}
                        </option>
                      ))}
                    </select>
                    <select
                      className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                      value={crewFilterPart}
                      onChange={(e) => setCrewFilterPart(e.target.value)}
                    >
                      <option value="">전체 파트</option>
                      {uniqueParts.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <select
                      className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                      value={crewFilterLevel}
                      onChange={(e) => setCrewFilterLevel(e.target.value)}
                    >
                      <option value="">전체 레벨</option>
                      {uniqueLevels.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <select
                      className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                      value={crewFilterStatus}
                      onChange={(e) => setCrewFilterStatus(e.target.value)}
                    >
                      <option value="active">활동중</option>
                      <option value="rest">휴식중</option>
                      <option value="">전체</option>
                    </select>
                  </div>

                  {/* Search + Select All */}
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        className="pl-9"
                        placeholder="이름 검색..."
                        value={crewSearch}
                        onChange={(e) => setCrewSearch(e.target.value)}
                      />
                    </div>
                    <Button variant="outline" size="sm" onClick={selectAllFiltered}>
                      전체 선택
                    </Button>
                    <Button variant="outline" size="sm" onClick={deselectAll}>
                      선택 해제
                    </Button>
                  </div>

                  {/* Crew list */}
                  <div className="max-h-60 overflow-y-auto rounded-md border p-2">
                    {filteredCrews.length === 0 ? (
                      <p className="py-4 text-center text-sm text-muted-foreground">
                        {crews.length === 0
                          ? "등록된 크루가 없습니다"
                          : "검색 결과가 없습니다"}
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {filteredCrews.map((crew) => (
                          <label
                            key={crew.userId}
                            className={cn(
                              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                              selectedUserIds.has(crew.userId) && "bg-muted",
                            )}
                          >
                            <input
                              type="checkbox"
                              className="rounded border-gray-300"
                              checked={selectedUserIds.has(crew.userId)}
                              onChange={() => toggleUser(crew.userId)}
                            />
                            <span className="truncate">{crew.displayName}</span>
                            <span className="ml-auto text-xs text-muted-foreground">
                              {[crew.teamName, crew.partName]
                                .filter(Boolean)
                                .join(" / ") || ""}
                            </span>
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
                      resetLineForm();
                    }}
                    disabled={saving}
                  >
                    취소
                  </Button>
                  <Button onClick={handleSaveLine} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    저장
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Tab: 평가 관리 (준비 중) */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {activeTab === "evaluation" && (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-lg font-medium text-muted-foreground">
              평가 관리 기능은 준비 중입니다
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              이 기능은 추후 업데이트에서 제공될 예정입니다.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
