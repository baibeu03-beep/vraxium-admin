"use client";

import { useCallback, useMemo, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  classifyActivityType,
  type UserActivityDetailRow,
  type UserActivityModalKey,
  type UserActivityOutputLink,
} from "@/lib/userActivityDetailsTypes";
import {
  CAREER_ENHANCEMENT_STATUSES,
  CAREER_GRADES,
  type CareerEnhancementStatus,
  type CareerGrade,
  type CareerRecordRow,
} from "@/lib/careerRecordsTypes";
import type {
  Cluster4Bundle,
  Cluster4DeleteResource,
  Cluster4PatchBody,
} from "@/lib/adminCluster4Types";

// 4개 모달(Work Info / Work Ability / Work Exp / Work Career) 을 묶는 활동 탭.
// 부모(Cluster4Editor) 의 bundle 을 받아 자체 form state 를 유지하고, 저장/삭제 시
// /api/admin/crews/[id]/cluster4 PATCH/DELETE 를 호출한 뒤 응답 bundle 로 부모를 갱신.

type Props = {
  bundle: Cluster4Bundle;
  legacyUserId: string;
  weekLabels: Map<string, string>;
  saveDisabled: boolean;
  onBundleUpdate: (next: Cluster4Bundle) => void;
  onBanner: (banner: { kind: "success" | "error"; message: string } | null) => void;
  devMode: boolean;
};

type ActivityFormRow = {
  id: string;
  user_id: string;
  week_id: string;
  activity_type_id: string;
  sub_title: string;
  growth_point: string;
  output_links_json: string; // JSON text — admin power-user 입력
  image_urls_json: string; // JSON text — string[]
  image_captions_json: string; // JSON text — string[]
  growth_image_url: string;
  growth_image_caption: string;
  rating: string; // string for input, "" = null
  modal: UserActivityModalKey;
};

type CareerFormRow = {
  id: string;
  user_id: string;
  week_id: string;
  project_id: string;
  enhancement_status: string; // "" = null
  grade: string; // "" = null
  grade_points: string;
  career_code: string;
  project: CareerRecordRow["project"];
};

const SUB_TABS: { key: UserActivityModalKey | "work_career"; label: string }[] = [
  { key: "work_info", label: "Work Info" },
  { key: "work_ability", label: "Work Ability" },
  { key: "work_exp", label: "Work Exp" },
  { key: "work_career", label: "Work Career" },
];

function toActivityForm(row: UserActivityDetailRow): ActivityFormRow {
  return {
    id: row.id,
    user_id: row.user_id,
    week_id: row.week_id,
    activity_type_id: row.activity_type_id,
    sub_title: row.sub_title ?? "",
    growth_point: row.growth_point ?? "",
    output_links_json: JSON.stringify(row.output_links, null, 2),
    image_urls_json: JSON.stringify(row.image_urls, null, 2),
    image_captions_json: JSON.stringify(row.image_captions, null, 2),
    growth_image_url: row.growth_image_url ?? "",
    growth_image_caption: row.growth_image_caption ?? "",
    rating: row.rating === null || row.rating === undefined ? "" : String(row.rating),
    modal: classifyActivityType(row.activity_type_id),
  };
}

function toCareerForm(row: CareerRecordRow): CareerFormRow {
  return {
    id: row.id,
    user_id: row.user_id,
    week_id: row.week_id,
    project_id: row.project_id,
    enhancement_status: row.enhancement_status ?? "",
    grade: row.grade ?? "",
    grade_points: row.grade_points === null ? "" : String(row.grade_points),
    career_code: row.career_code ?? "",
    project: row.project,
  };
}

// safe JSON parse with error string.
function tryParseJson<T>(value: string, fallback: T): { ok: true; value: T } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: fallback };
  try {
    const parsed = JSON.parse(trimmed) as T;
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
}

type ActivityPatchValue = NonNullable<Cluster4PatchBody["userActivityDetails"]>[number];
type CareerPatchValue = NonNullable<Cluster4PatchBody["careerRecords"]>[number];

function buildActivityPatchInput(form: ActivityFormRow):
  | { ok: true; value: ActivityPatchValue }
  | { ok: false; error: string } {
  const outputLinks = tryParseJson<UserActivityOutputLink[]>(
    form.output_links_json,
    [],
  );
  if (!outputLinks.ok) {
    return { ok: false, error: `output_links JSON 파싱 오류: ${outputLinks.error}` };
  }
  const imageUrls = tryParseJson<string[]>(form.image_urls_json, []);
  if (!imageUrls.ok) {
    return { ok: false, error: `image_urls JSON 파싱 오류: ${imageUrls.error}` };
  }
  const imageCaptions = tryParseJson<string[]>(form.image_captions_json, []);
  if (!imageCaptions.ok) {
    return { ok: false, error: `image_captions JSON 파싱 오류: ${imageCaptions.error}` };
  }

  let rating: number | null = null;
  if (form.rating.trim() !== "") {
    const n = Number(form.rating);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      return { ok: false, error: "rating 은 0~10 사이여야 합니다." };
    }
    rating = n;
  }

  return {
    ok: true,
    value: {
      id: form.id || null,
      week_id: form.week_id,
      activity_type_id: form.activity_type_id,
      sub_title: form.sub_title || null,
      growth_point: form.growth_point || null,
      output_links: outputLinks.value,
      image_urls: imageUrls.value,
      image_captions: imageCaptions.value,
      growth_image_url: form.growth_image_url || null,
      growth_image_caption: form.growth_image_caption || null,
      rating,
      modal: form.modal,
    },
  };
}

function buildCareerPatchInput(form: CareerFormRow):
  | { ok: true; value: CareerPatchValue }
  | { ok: false; error: string } {
  let gradePoints: number | null = null;
  if (form.grade_points.trim() !== "") {
    const n = Number(form.grade_points);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: "grade_points 는 0 이상의 정수여야 합니다." };
    }
    gradePoints = n;
  }

  return {
    ok: true,
    value: {
      id: form.id || null,
      week_id: form.week_id,
      project_id: form.project_id,
      enhancement_status:
        form.enhancement_status === ""
          ? null
          : (form.enhancement_status as CareerEnhancementStatus),
      grade: form.grade === "" ? null : (form.grade as CareerGrade),
      grade_points: gradePoints,
      career_code: form.career_code || null,
    },
  };
}

export default function ActivityTab({
  bundle,
  legacyUserId,
  weekLabels,
  saveDisabled,
  onBundleUpdate,
  onBanner,
  devMode,
}: Props) {
  const [activeSub, setActiveSub] = useState<UserActivityModalKey | "work_career">(
    "work_info",
  );
  // bundle 은 외부 source-of-truth. 사용자의 미저장 편집은 row id 별 patch 로 보관해
  // bundle 갱신과 자연스럽게 머지. effect 없이 setState 회피 + 다른 row 의 미저장
  // 입력을 잃지 않도록 함.
  const [activityEdits, setActivityEdits] = useState<
    Map<string, Partial<ActivityFormRow>>
  >(() => new Map());
  const [careerEdits, setCareerEdits] = useState<
    Map<string, Partial<CareerFormRow>>
  >(() => new Map());
  const [savingRowId, setSavingRowId] = useState<string | null>(null);

  const getWeekLabel = useCallback(
    (id: string | null | undefined) => {
      if (!id) return "-";
      return weekLabels.get(String(id)) ?? String(id);
    },
    [weekLabels],
  );

  const activityForm = useMemo<ActivityFormRow[]>(() => {
    return bundle.userActivityDetails.map((row) => {
      const base = toActivityForm(row);
      const patch = activityEdits.get(row.id);
      return patch ? { ...base, ...patch } : base;
    });
  }, [bundle.userActivityDetails, activityEdits]);

  const careerForm = useMemo<CareerFormRow[]>(() => {
    return bundle.careerRecords.map((row) => {
      const base = toCareerForm(row);
      const patch = careerEdits.get(row.id);
      return patch ? { ...base, ...patch } : base;
    });
  }, [bundle.careerRecords, careerEdits]);

  const visibleActivityRows = useMemo(() => {
    if (activeSub === "work_career") return [];
    return activityForm.filter((row) => row.modal === activeSub);
  }, [activityForm, activeSub]);

  const setActivityRow = (rowId: string, patch: Partial<ActivityFormRow>) => {
    setActivityEdits((current) => {
      const next = new Map(current);
      const existing = next.get(rowId) ?? {};
      next.set(rowId, { ...existing, ...patch });
      return next;
    });
  };

  const setCareerRow = (rowId: string, patch: Partial<CareerFormRow>) => {
    setCareerEdits((current) => {
      const next = new Map(current);
      const existing = next.get(rowId) ?? {};
      next.set(rowId, { ...existing, ...patch });
      return next;
    });
  };

  const clearActivityEdits = (rowId: string) =>
    setActivityEdits((current) => {
      if (!current.has(rowId)) return current;
      const next = new Map(current);
      next.delete(rowId);
      return next;
    });

  const clearCareerEdits = (rowId: string) =>
    setCareerEdits((current) => {
      if (!current.has(rowId)) return current;
      const next = new Map(current);
      next.delete(rowId);
      return next;
    });

  const handleSaveActivityRow = async (rowId: string) => {
    if (saveDisabled) return;
    const target = activityForm.find((row) => row.id === rowId);
    if (!target) return;

    const built = buildActivityPatchInput(target);
    if (!built.ok) {
      onBanner({ kind: "error", message: built.error });
      return;
    }

    setSavingRowId(rowId);
    onBanner(null);
    try {
      const response = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userActivityDetails: [built.value] }),
        },
      );
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to save.");
      }
      onBundleUpdate(json.data as Cluster4Bundle);
      clearActivityEdits(rowId);
      onBanner({ kind: "success", message: "저장되었습니다." });
    } catch (error) {
      onBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to save.",
      });
    } finally {
      setSavingRowId(null);
    }
  };

  const handleSaveCareerRow = async (rowId: string) => {
    if (saveDisabled) return;
    const target = careerForm.find((row) => row.id === rowId);
    if (!target) return;

    const built = buildCareerPatchInput(target);
    if (!built.ok) {
      onBanner({ kind: "error", message: built.error });
      return;
    }

    setSavingRowId(rowId);
    onBanner(null);
    try {
      const response = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ careerRecords: [built.value] }),
        },
      );
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to save.");
      }
      onBundleUpdate(json.data as Cluster4Bundle);
      clearCareerEdits(rowId);
      onBanner({ kind: "success", message: "저장되었습니다." });
    } catch (error) {
      onBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to save.",
      });
    } finally {
      setSavingRowId(null);
    }
  };

  const handleDelete = async (
    resource: Cluster4DeleteResource,
    id: string,
    confirmMessage: string,
  ) => {
    if (saveDisabled) return;
    const ok = window.confirm(`${confirmMessage}\n\nid: ${id}`);
    if (!ok) return;

    const paramKeyMap: Record<Cluster4DeleteResource, string> = {
      seasonReputation: "seasonReputationId",
      weeklyReputation: "weeklyReputationId",
      weeklyReview: "weeklyReviewId",
      weeklyColleague: "weeklyColleagueId",
      userActivityDetail: "userActivityDetailId",
      careerRecord: "careerRecordId",
    };

    setSavingRowId(id);
    onBanner(null);
    try {
      const response = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4?${paramKeyMap[resource]}=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to delete.");
      }
      onBundleUpdate(json.data as Cluster4Bundle);
      onBanner({ kind: "success", message: "삭제되었습니다." });
    } catch (error) {
      onBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to delete.",
      });
    } finally {
      setSavingRowId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">활동</CardTitle>
        <p className="text-xs text-muted-foreground">
          Cluster4-card 4개 모달(Work Info / Ability / Exp / Career)의 운영 편집 영역입니다.
          작성기간 게이트는 사용자에게만 적용되며, 운영자는 작성기간과 무관하게 수정/삭제할 수
          있습니다.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1 border-b">
          {SUB_TABS.map((tab) => {
            const isActive = activeSub === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveSub(tab.key)}
                className={cn(
                  "relative -mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-xs",
                  isActive
                    ? "border-foreground bg-background font-semibold text-foreground"
                    : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted",
                )}
                aria-pressed={isActive}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeSub !== "work_career" && (
          <ActivitySubPane
            modal={activeSub}
            rows={visibleActivityRows}
            saveDisabled={saveDisabled}
            savingRowId={savingRowId}
            tableAvailable={bundle.tablesAvailable.userActivityDetails}
            getWeekLabel={getWeekLabel}
            onChange={(rowId, patch) => setActivityRow(rowId, patch)}
            onSave={(rowId) => void handleSaveActivityRow(rowId)}
            onDelete={(rowId, label) =>
              void handleDelete(
                "userActivityDetail",
                rowId,
                `${label} 행을 삭제할까요?`,
              )
            }
            devMode={devMode}
          />
        )}

        {activeSub === "work_career" && (
          <CareerSubPane
            rows={careerForm}
            saveDisabled={saveDisabled}
            savingRowId={savingRowId}
            tableAvailable={bundle.tablesAvailable.careerRecords}
            getWeekLabel={getWeekLabel}
            onChange={(rowId, patch) => setCareerRow(rowId, patch)}
            onSave={(rowId) => void handleSaveCareerRow(rowId)}
            onDelete={(rowId, label) =>
              void handleDelete(
                "careerRecord",
                rowId,
                `${label} 행을 삭제할까요?`,
              )
            }
            devMode={devMode}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ───────────── Work Info / Ability / Exp pane ─────────────

function ActivitySubPane({
  modal,
  rows,
  saveDisabled,
  savingRowId,
  tableAvailable,
  getWeekLabel,
  onChange,
  onSave,
  onDelete,
  devMode,
}: {
  modal: UserActivityModalKey;
  rows: ActivityFormRow[];
  saveDisabled: boolean;
  savingRowId: string | null;
  tableAvailable: boolean;
  getWeekLabel: (id: string | null | undefined) => string;
  onChange: (rowId: string, patch: Partial<ActivityFormRow>) => void;
  onSave: (rowId: string) => void;
  onDelete: (rowId: string, label: string) => void;
  devMode: boolean;
}) {
  if (!tableAvailable) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <span className="font-mono text-xs">user_activity_details</span> 테이블을 조회할 수
        없습니다.
      </div>
    );
  }
  if (rows.length === 0) {
    const labelMap: Record<UserActivityModalKey, string> = {
      work_info: "Work Info",
      work_ability: "Work Ability",
      work_exp: "Work Exp",
      work_career: "Work Career",
    };
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        {labelMap[modal]} 에 해당하는 user_activity_details row 가 없습니다.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.id} className="rounded-lg border bg-card shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <div className="text-sm font-semibold text-foreground">
                <span className="font-mono">{row.activity_type_id}</span>
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  · {getWeekLabel(row.week_id)}
                </span>
              </div>
              {devMode && (
                <div className="font-mono text-[10px] text-muted-foreground">
                  id: {row.id}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => onSave(row.id)}
                disabled={saveDisabled || savingRowId === row.id}
              >
                <Save className="h-4 w-4" />
                {savingRowId === row.id ? "저장 중..." : "저장"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  onDelete(
                    row.id,
                    `${row.activity_type_id} · ${getWeekLabel(row.week_id)}`,
                  )
                }
                disabled={saveDisabled || savingRowId === row.id}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                삭제
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <FieldLabel>sub_title</FieldLabel>
              <textarea
                value={row.sub_title}
                onChange={(event) =>
                  onChange(row.id, { sub_title: event.target.value })
                }
                disabled={saveDisabled}
                rows={2}
                maxLength={300}
                className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="self-end text-[10px] text-muted-foreground">
                {row.sub_title.length}/300
              </div>
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <FieldLabel>growth_point</FieldLabel>
              <textarea
                value={row.growth_point}
                onChange={(event) =>
                  onChange(row.id, { growth_point: event.target.value })
                }
                disabled={saveDisabled}
                rows={3}
                maxLength={2000}
                className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="self-end text-[10px] text-muted-foreground">
                {row.growth_point.length}/2000
              </div>
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <FieldLabel>output_links (JSON array of {`{desc, url}`})</FieldLabel>
              <textarea
                value={row.output_links_json}
                onChange={(event) =>
                  onChange(row.id, { output_links_json: event.target.value })
                }
                disabled={saveDisabled}
                rows={3}
                spellCheck={false}
                className="resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <FieldLabel>image_urls (JSON array of strings, ≤4)</FieldLabel>
              <textarea
                value={row.image_urls_json}
                onChange={(event) =>
                  onChange(row.id, { image_urls_json: event.target.value })
                }
                disabled={saveDisabled}
                rows={3}
                spellCheck={false}
                className="resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>image_captions (JSON array)</FieldLabel>
              <textarea
                value={row.image_captions_json}
                onChange={(event) =>
                  onChange(row.id, { image_captions_json: event.target.value })
                }
                disabled={saveDisabled}
                rows={3}
                spellCheck={false}
                className="resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <FieldLabel>growth_image_url</FieldLabel>
              <Input
                value={row.growth_image_url}
                onChange={(event) =>
                  onChange(row.id, { growth_image_url: event.target.value })
                }
                disabled={saveDisabled}
                maxLength={500}
                className="h-9"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>growth_image_caption</FieldLabel>
              <Input
                value={row.growth_image_caption}
                onChange={(event) =>
                  onChange(row.id, { growth_image_caption: event.target.value })
                }
                disabled={saveDisabled}
                maxLength={200}
                className="h-9"
              />
            </div>

            {modal === "work_exp" && (
              <div className="flex flex-col gap-1.5">
                <FieldLabel>rating (0~10, 비우면 NULL)</FieldLabel>
                <Input
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  inputMode="numeric"
                  value={row.rating}
                  onChange={(event) =>
                    onChange(row.id, { rating: event.target.value })
                  }
                  disabled={saveDisabled}
                  className="h-9"
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ───────────── Work Career pane ─────────────

function CareerSubPane({
  rows,
  saveDisabled,
  savingRowId,
  tableAvailable,
  getWeekLabel,
  onChange,
  onSave,
  onDelete,
  devMode,
}: {
  rows: CareerFormRow[];
  saveDisabled: boolean;
  savingRowId: string | null;
  tableAvailable: boolean;
  getWeekLabel: (id: string | null | undefined) => string;
  onChange: (rowId: string, patch: Partial<CareerFormRow>) => void;
  onSave: (rowId: string) => void;
  onDelete: (rowId: string, label: string) => void;
  devMode: boolean;
}) {
  if (!tableAvailable) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <span className="font-mono text-xs">career_records</span> 테이블을 조회할 수
        없습니다.
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        career_records row 가 없습니다. 본 단계에서는 admin 이 기존 row 만 편집할 수
        있습니다. user 신청 흐름은 Phase 6 에서 추가됩니다.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => {
        const project = row.project;
        const projectLabel = project
          ? `${project.company_name ?? "-"} · ${project.project_name ?? "-"}`
          : "(project not found)";
        return (
          <div key={row.id} className="rounded-lg border bg-card shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <div className="text-sm font-semibold text-foreground">
                  {projectLabel}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {getWeekLabel(row.week_id)}
                  {project?.line_code && (
                    <span className="ml-2 font-mono">[{project.line_code}]</span>
                  )}
                </div>
                {devMode && (
                  <div className="font-mono text-[10px] text-muted-foreground">
                    id: {row.id} · project_id: {row.project_id}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSave(row.id)}
                  disabled={saveDisabled || savingRowId === row.id}
                >
                  <Save className="h-4 w-4" />
                  {savingRowId === row.id ? "저장 중..." : "저장"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onDelete(row.id, `${projectLabel} · ${getWeekLabel(row.week_id)}`)
                  }
                  disabled={saveDisabled || savingRowId === row.id}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  삭제
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2">
              {project && (
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <FieldLabel>프로젝트 정보 (read-only)</FieldLabel>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">company</span>{" "}
                      {project.company_name ?? "-"}
                    </div>
                    <div>
                      <span className="text-muted-foreground">project</span>{" "}
                      {project.project_name ?? "-"}
                    </div>
                    {project.job_position && (
                      <div>
                        <span className="text-muted-foreground">job_position</span>{" "}
                        {project.job_position}
                      </div>
                    )}
                    {project.supervisor_name && (
                      <div>
                        <span className="text-muted-foreground">supervisor</span>{" "}
                        {project.supervisor_name}
                        {project.supervisor_position
                          ? ` (${project.supervisor_position})`
                          : ""}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <FieldLabel>enhancement_status</FieldLabel>
                <Select
                  value={row.enhancement_status || "__none__"}
                  onValueChange={(value: string | null) =>
                    onChange(row.id, {
                      enhancement_status: value === "__none__" ? "" : (value ?? ""),
                    })
                  }
                  disabled={saveDisabled}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— (null)</SelectItem>
                    {CAREER_ENHANCEMENT_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <FieldLabel>grade</FieldLabel>
                <Select
                  value={row.grade || "__none__"}
                  onValueChange={(value: string | null) =>
                    onChange(row.id, {
                      grade: value === "__none__" ? "" : (value ?? ""),
                    })
                  }
                  disabled={saveDisabled}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— (null)</SelectItem>
                    {CAREER_GRADES.map((grade) => (
                      <SelectItem key={grade} value={grade}>
                        {grade}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <FieldLabel>grade_points</FieldLabel>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={row.grade_points}
                  onChange={(event) =>
                    onChange(row.id, { grade_points: event.target.value })
                  }
                  disabled={saveDisabled}
                  className="h-9"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <FieldLabel>career_code</FieldLabel>
                <Input
                  value={row.career_code}
                  onChange={(event) =>
                    onChange(row.id, { career_code: event.target.value })
                  }
                  disabled={saveDisabled}
                  maxLength={50}
                  className="h-9"
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}
