"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Search, Check, X, Upload, Trash2 } from "lucide-react";
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

type WeekOption = {
  id: string;             // weeks.id (UUID). POST body 의 week_id 로 그대로 전달.
  label: string;          // 표시용 — "{year}년도 {season} {weekNumber}w".
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

type LineDto = {
  id: string;
  activityTypeId: string | null;
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

// ──────────────────────────────────────────────────────────────
// Image Upload Component
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
// Main Component
// ──────────────────────────────────────────────────────────────

export default function PracticalInfoManager() {
  // ── State ──
  const [currentWeek, setCurrentWeek] = useState<CurrentWeekData | null>(null);
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [existingLines, setExistingLines] = useState<LineDto[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [selectedActivityType, setSelectedActivityType] = useState("");
  const [mainTitle, setMainTitle] = useState("");
  const [outputLink1, setOutputLink1] = useState("");
  const [outputLink2, setOutputLink2] = useState("");
  const [uploadedImage1, setUploadedImage1] = useState<UploadedImage | null>(null);
  const [uploadedImage2, setUploadedImage2] = useState<UploadedImage | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [userSearch, setUserSearch] = useState("");

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

  // ── Data fetching ──
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [weekRes, weeksRes, typesRes, usersRes, linesRes] = await Promise.all([
        fetch("/api/admin/cluster4/current-week"),
        fetch("/api/admin/cluster4/weeks-options?limit=3"),
        fetch("/api/admin/cluster4/activity-types?cluster=practical_info"),
        fetch("/api/admin/cluster4/users"),
        fetch("/api/admin/cluster4/lines?partType=info&limit=100"),
      ]);

      const weekJson = await weekRes.json();
      if (weekJson.success) setCurrentWeek(weekJson.data);

      const weeksJson = await weeksRes.json();
      if (weeksJson.success) {
        const opts: WeekOption[] = weeksJson.data.weeks ?? [];
        setWeekOptions(opts);
        const current = opts.find((o) => o.isCurrent) ?? opts[0];
        if (current) setSelectedWeekId((prev) => prev || current.id);
      }

      const typesJson = await typesRes.json();
      if (typesJson.success) setActivityTypes(typesJson.data);

      const usersJson = await usersRes.json();
      if (usersJson.success) setUsers(usersJson.data);

      const linesJson = await linesRes.json();
      if (linesJson.success) setExistingLines(linesJson.data.rows ?? []);
    } catch (error) {
      console.error("Failed to fetch data", error);
      setBanner({ kind: "error", message: "데이터를 불러오는데 실패했습니다" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── Form reset ──
  const resetForm = useCallback(() => {
    setSelectedActivityType("");
    setMainTitle("");
    setOutputLink1("");
    setOutputLink2("");
    setUploadedImage1(null);
    setUploadedImage2(null);
    setSelectedUserIds(new Set());
    setUserSearch("");
  }, []);

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

  // 선택된 주차 정보 — UI/POST 모두 이 값을 사용한다.
  const selectedWeek = useMemo(
    () => weekOptions.find((w) => w.id === selectedWeekId) ?? null,
    [weekOptions, selectedWeekId],
  );

  const canOpenSelected = useMemo(() => {
    if (selectedWeek) return selectedWeek.canOpen;
    return !!currentWeek?.weekId && currentWeek.canOpen;
  }, [selectedWeek, currentWeek]);

  // ── Save ──
  const handleSave = useCallback(async () => {
    // selectedWeekId 가 비어 있으면 명시적으로 차단한다 — 빈 값으로 API 를 호출하지 않는다.
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

    if (!selectedActivityType) {
      setBanner({ kind: "error", message: "활동 유형을 선택해주세요" });
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

    setSaving(true);
    setBanner(null);

    try {
      const outputImages: string[] = [];
      if (uploadedImage1) outputImages.push(uploadedImage1.url);
      if (uploadedImage2) outputImages.push(uploadedImage2.url);

      const payload = {
        activity_type_id: selectedActivityType,
        main_title: mainTitle.trim(),
        output_link_1: outputLink1.trim() || null,
        output_link_2: outputLink2.trim() || null,
        output_images: outputImages,
        target_user_ids: Array.from(selectedUserIds),
        week_id: targetWeekId,
        submission_opens_at: targetOpens,
        submission_closes_at: targetCloses,
      };
      console.log("[info line open payload]", {
        selectedWeekId,
        selectedWeekOption: selectedWeek,
        body: payload,
      });
      const res = await fetch("/api/admin/cluster4/info-lines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

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
      await fetchAll();
    } catch (error) {
      console.error("Save failed", error);
      setBanner({ kind: "error", message: "저장 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [
    currentWeek,
    selectedWeek,
    selectedWeekId,
    selectedActivityType,
    mainTitle,
    assetValid,
    assetCount,
    outputLink1,
    outputLink2,
    uploadedImage1,
    uploadedImage2,
    selectedUserIds,
    resetForm,
    fetchAll,
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
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">실무 정보 라인 개설</h1>

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

      {/* Current Week Info + Week Selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">라인 개설 대상 주차</CardTitle>
          <CardDescription>
            운영 기본값은 현재 주차이며, 테스트/검증 목적으로 직전 주차도 선택할 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {weekOptions.length > 0 && (
            <div className="space-y-1">
              <Label htmlFor="weekSelect" className="text-xs text-muted-foreground">
                대상 주차
              </Label>
              <select
                id="weekSelect"
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
                <span className="font-medium">
                  {selectedWeek.year} {selectedWeek.seasonName} W{selectedWeek.weekNumber}
                </span>{" "}
                ({fmtDateWithDay(selectedWeek.startDate)} ~ {fmtDateWithDay(selectedWeek.endDate)})
              </p>
              {selectedWeek.canOpen &&
                selectedWeek.submissionOpensAt &&
                selectedWeek.submissionClosesAt && (
                  <>
                    <p className="text-muted-foreground">
                      제출 기간: {fmtDateTimeWithDay(selectedWeek.submissionOpensAt)} ~{" "}
                      {fmtDateTimeWithDay(selectedWeek.submissionClosesAt)}
                    </p>
                    <p className="text-muted-foreground">
                      크루원 2차 정보 입력 마감:{" "}
                      {fmtDateTimeWithDay(selectedWeek.submissionClosesAt)}
                    </p>
                  </>
                )}
              {!selectedWeek.canOpen && (
                <p className="font-medium text-orange-600">
                  선택한 주차는 공식 휴식 주차입니다. 라인 개설이 불가합니다.
                </p>
              )}
            </div>
          ) : currentWeek ? (
            <div className="space-y-1 text-sm">
              <p>
                <span className="font-medium">
                  {currentWeek.year} {currentWeek.seasonName} W{currentWeek.weekNumber}
                </span>{" "}
                ({fmtDateWithDay(currentWeek.startDate)} ~ {fmtDateWithDay(currentWeek.endDate)})
              </p>
              {!currentWeek.canOpen && (
                <p className="font-medium text-orange-600">
                  {currentWeek.isOfficialRest
                    ? "이번 주는 공식 휴식 주차입니다."
                    : "현재 주차 데이터가 없습니다."}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">주차 정보를 불러올 수 없습니다.</p>
          )}
        </CardContent>
      </Card>

      {/* Existing Lines */}
      {existingLines.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">개설된 실무 정보 라인</CardTitle>
            <CardDescription>
              현재 등록된 실무 정보 라인 {existingLines.length}개
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>활동 유형</TableHead>
                  <TableHead>메인 타이틀</TableHead>
                  <TableHead className="text-center">대상</TableHead>
                  <TableHead className="text-center">활성</TableHead>
                  <TableHead>생성일</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {existingLines.map((line) => {
                  const typeName =
                    activityTypes.find((t) => t.id === line.activityTypeId)
                      ?.name ??
                    line.activityTypeId ??
                    "-";
                  return (
                    <TableRow key={line.id}>
                      <TableCell className="font-medium">{typeName}</TableCell>
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
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* New Line Form */}
      {!showForm && canOpenSelected && (
        <Button onClick={() => setShowForm(true)}>
          <Plus className="mr-2 h-4 w-4" /> 새 라인 개설
        </Button>
      )}

      {showForm && canOpenSelected && (selectedWeek?.submissionClosesAt ?? currentWeek?.submissionClosesAt) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">새 실무 정보 라인</CardTitle>
            <CardDescription>
              크루원 2차 정보 입력 마감:{" "}
              {fmtDateTimeWithDay(
                (selectedWeek?.submissionClosesAt ?? currentWeek?.submissionClosesAt) as string,
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Activity Type */}
            <div className="space-y-2">
              <Label htmlFor="activityType">
                활동 유형 <span className="text-red-500">*</span>
              </Label>
              <select
                id="activityType"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={selectedActivityType}
                onChange={(e) => setSelectedActivityType(e.target.value)}
              >
                <option value="">선택해주세요</option>
                {activityTypes.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.hasActiveLine}>
                    {t.name}
                    {t.hasActiveLine ? " (사용중)" : ""}
                  </option>
                ))}
              </select>
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
                {/* Links */}
                <div className="space-y-1">
                  <Label
                    htmlFor="link1"
                    className="text-xs text-muted-foreground"
                  >
                    Link 1
                  </Label>
                  <Input
                    id="link1"
                    value={outputLink1}
                    onChange={(e) => setOutputLink1(e.target.value)}
                    placeholder="https://..."
                    disabled={!outputLink1.trim() && assetCount >= 2}
                  />
                </div>
                <div className="space-y-1">
                  <Label
                    htmlFor="link2"
                    className="text-xs text-muted-foreground"
                  >
                    Link 2
                  </Label>
                  <Input
                    id="link2"
                    value={outputLink2}
                    onChange={(e) => setOutputLink2(e.target.value)}
                    placeholder="https://..."
                    disabled={!outputLink2.trim() && assetCount >= 2}
                  />
                </div>

                {/* Image Uploads */}
                <ImageUploadSlot
                  label="Image 1"
                  image={uploadedImage1}
                  onUpload={setUploadedImage1}
                  onRemove={() => setUploadedImage1(null)}
                  disabled={!uploadedImage1 && assetCount >= 2}
                />
                <ImageUploadSlot
                  label="Image 2"
                  image={uploadedImage2}
                  onUpload={setUploadedImage2}
                  onRemove={() => setUploadedImage2(null)}
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
                  선택됨: {selectedUserIds.size}명
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
                  전체 선택
                </Button>
                <Button variant="outline" size="sm" onClick={deselectAll}>
                  선택 해제
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
                  <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
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
                          className="rounded border-gray-300"
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
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                저장
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
