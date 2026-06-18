"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Save, Trash2, X } from "lucide-react";
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
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import {
  CAREER_ENHANCEMENT_STATUSES,
  CAREER_GRADES,
  type CareerEnhancementStatus,
  type CareerGrade,
  type CareerRecordRow,
} from "@/lib/careerRecordsTypes";
import type {
  Cluster4AdminSubmissionRow,
  Cluster4Bundle,
  Cluster4DeleteResource,
  Cluster4PatchBody,
} from "@/lib/adminCluster4Types";
import type { Cluster4LinePartType } from "@/lib/cluster4LinesTypes";
import {
  type Cluster4OutputLink,
  OUTPUT_LINK_LABEL_MAX_LENGTH,
} from "@/lib/cluster4OutputLinks";
import {
  type Cluster4OutputImage,
  OUTPUT_IMAGE_CAPTION_MAX_LENGTH,
} from "@/lib/cluster4OutputImages";

// Cluster4 4허브(Work Info / Ability / Exp / Career)의 운영 편집 영역.
//
// (2026 전환) 편집 SoT 를 user_activity_details → cluster4_line_submissions 로 이관.
//   - 편집 단위는 cluster4_line_targets(user-mode) 슬롯. 각 슬롯의 본문이 곧 submission 1행.
//   - 운영자는 target 을 자유 생성할 수 없다(라인 개설/배정 선행). submission 미제출 슬롯은
//     "미제출" 로 표시하고 그 자리에서 바로 입력/저장(upsert)한다.
//   - 운영자 저장/삭제는 작성기간(submission_closes_at)과 무관하게 가능(어드민 전용 배선).
//   - rating 은 이번 단계에서 노출하지 않는다(submissions 에 컬럼 없음 — 보류).
//   - Work Career 탭은 submission 슬롯 + career_records(프로젝트 기록) 영역을 함께 렌더한다.
//
// 고객 포털 제출/수정 API, info 읽기 DTO 경로는 변경하지 않는다.

type Props = {
  bundle: Cluster4Bundle;
  legacyUserId: string;
  weekLabels: Map<string, string>;
  saveDisabled: boolean;
  onBundleUpdate: (next: Cluster4Bundle) => void;
  onBanner: (banner: { kind: "success" | "error"; message: string } | null) => void;
  devMode: boolean;
};

// 슬롯(line target) + 제출 본문 편집 폼.
type SubmissionFormRow = {
  lineTargetId: string;
  weekId: string;
  partType: Cluster4LinePartType;
  mainTitle: string;
  activityTypeId: string | null;
  submissionId: string | null; // null = 미제출
  submissionClosesAt: string;
  updatedAt: string | null;
  subtitle: string;
  growth_point: string;
  // 구조화 편집: raw JSON 문자열 대신 객체 배열로 보유해 url↔label / url↔caption 페어를
  // 한 행씩 렌더·편집한다. 저장 시 서버가 normalize(빈 url 제거, 빈 label/caption→null).
  outputLinks: Cluster4OutputLink[]; // [{url, label}]
  outputImages: Cluster4OutputImage[]; // [{url, caption}]
};

type SubmissionFormPatch = Partial<
  Pick<
    SubmissionFormRow,
    "subtitle" | "growth_point" | "outputLinks" | "outputImages"
  >
>;

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

const SUB_TABS = [
  { key: "work_info", label: "Work Info", partType: "info" },
  { key: "work_exp", label: "Work Exp", partType: "experience" },
  { key: "work_ability", label: "Work Ability", partType: "competency" },
  { key: "work_career", label: "Work Career", partType: "career" },
] as const;

type SubmissionTabKey = (typeof SUB_TABS)[number]["key"];

const PART_TYPE_BY_TAB: Record<SubmissionTabKey, Cluster4LinePartType> = {
  work_info: "info",
  work_exp: "experience",
  work_ability: "competency",
  work_career: "career",
};

const TAB_LABEL: Record<SubmissionTabKey, string> = {
  work_info: "Work Info",
  work_exp: "Work Exp",
  work_ability: "Work Ability",
  work_career: "Work Career",
};

// ───────────── draft helpers (career_records 전용) ─────────────

const DRAFT_PREFIX = "__draft_";
const DRAFT_ID_CAREER = `${DRAFT_PREFIX}career`;
const isDraftId = (id: string) => id.startsWith(DRAFT_PREFIX);

function createEmptyCareerDraft(userId: string): CareerFormRow {
  return {
    id: DRAFT_ID_CAREER,
    user_id: userId,
    week_id: "",
    project_id: "",
    enhancement_status: "",
    grade: "",
    grade_points: "",
    career_code: "",
    project: null,
  };
}

function toSubmissionForm(row: Cluster4AdminSubmissionRow): SubmissionFormRow {
  const s = row.submission;
  return {
    lineTargetId: row.lineTargetId,
    weekId: row.weekId,
    partType: row.partType,
    mainTitle: row.mainTitle,
    activityTypeId: row.activityTypeId,
    submissionId: s?.id ?? null,
    submissionClosesAt: row.submissionClosesAt,
    updatedAt: s?.updatedAt ?? null,
    subtitle: s?.subtitle ?? "",
    growth_point: s?.growthPoint ?? "",
    // 객체 페어를 그대로 보유(얕은 복사). label/caption 은 null 가능.
    outputLinks: (s?.outputLinks ?? []).map((l) => ({
      url: l.url,
      label: l.label,
    })),
    outputImages: (s?.outputImages ?? []).map((i) => ({
      url: i.url,
      caption: i.caption,
    })),
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

type SubmissionPatchValue = NonNullable<
  Cluster4PatchBody["cluster4LineSubmissions"]
>[number];
type CareerPatchValue = NonNullable<Cluster4PatchBody["careerRecords"]>[number];

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

  const persistedId = form.id && !isDraftId(form.id) ? form.id : null;

  return {
    ok: true,
    value: {
      id: persistedId,
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
  const [activeSub, setActiveSub] = useState<SubmissionTabKey>("work_info");
  // 미저장 편집: submission 은 lineTargetId 별, career 는 row id 별 patch 로 보관.
  const [submissionEdits, setSubmissionEdits] = useState<
    Map<string, SubmissionFormPatch>
  >(() => new Map());
  const [careerEdits, setCareerEdits] = useState<
    Map<string, Partial<CareerFormRow>>
  >(() => new Map());
  const [careerDraft, setCareerDraft] = useState<CareerFormRow | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const confirm = useConfirm();

  const targetUserId = bundle.userId ?? "";

  // 운영자 편집 게이트: 작성기간(submission window)과 무관. parent 의 saveDisabled
  // (loading/saving + !bundle.userId) 만 적용한다 — 마감 지난 라인도 운영자는 편집 가능.
  const canOperate = !saveDisabled && Boolean(bundle.userId);

  const submissionRows = useMemo<Cluster4AdminSubmissionRow[]>(
    () => bundle.cluster4LineSubmissions ?? [],
    [bundle.cluster4LineSubmissions],
  );

  const submissionTableAvailable =
    bundle.tablesAvailable.cluster4LineSubmissions !== false;

  const getWeekLabel = useCallback(
    (id: string | null | undefined) => {
      if (!id) return "-";
      return weekLabels.get(String(id)) ?? String(id);
    },
    [weekLabels],
  );

  // 주차 정렬용 시작일 맵 (weekId → start_date). 최근 주차 우선 정렬에 사용.
  const weekStartById = useMemo(() => {
    const map = new Map<string, string>();
    for (const week of bundle.weeks as Array<Record<string, unknown>>) {
      const id = week?.id;
      if (id === undefined || id === null) continue;
      const start = week.start_date ?? week.startDate ?? week.starts_at ?? null;
      map.set(String(id), start ? String(start) : "");
    }
    return map;
  }, [bundle.weeks]);

  const submissionForms = useMemo<SubmissionFormRow[]>(() => {
    return submissionRows.map((row) => {
      const base = toSubmissionForm(row);
      const patch = submissionEdits.get(row.lineTargetId);
      return patch ? { ...base, ...patch } : base;
    });
  }, [submissionRows, submissionEdits]);

  const careerForm = useMemo<CareerFormRow[]>(() => {
    return bundle.careerRecords.map((row) => {
      const base = toCareerForm(row);
      const patch = careerEdits.get(row.id);
      return patch ? { ...base, ...patch } : base;
    });
  }, [bundle.careerRecords, careerEdits]);

  const visibleSubmissionRows = useMemo<SubmissionFormRow[]>(() => {
    const partType = PART_TYPE_BY_TAB[activeSub];
    return submissionForms.filter((row) => row.partType === partType);
  }, [submissionForms, activeSub]);

  const careerSlotRows = useMemo<SubmissionFormRow[]>(() => {
    return submissionForms.filter((row) => row.partType === "career");
  }, [submissionForms]);

  const visibleCareerRows = useMemo<CareerFormRow[]>(() => {
    return careerDraft ? [careerDraft, ...careerForm] : careerForm;
  }, [careerDraft, careerForm]);

  const setSubmissionRow = (lineTargetId: string, patch: SubmissionFormPatch) => {
    setSubmissionEdits((current) => {
      const next = new Map(current);
      const existing = next.get(lineTargetId) ?? {};
      next.set(lineTargetId, { ...existing, ...patch });
      return next;
    });
  };

  const clearSubmissionEdits = (lineTargetId: string) =>
    setSubmissionEdits((current) => {
      if (!current.has(lineTargetId)) return current;
      const next = new Map(current);
      next.delete(lineTargetId);
      return next;
    });

  const setCareerRow = (rowId: string, patch: Partial<CareerFormRow>) => {
    if (isDraftId(rowId)) {
      setCareerDraft((current) => (current ? { ...current, ...patch } : null));
      return;
    }
    setCareerEdits((current) => {
      const next = new Map(current);
      const existing = next.get(rowId) ?? {};
      next.set(rowId, { ...existing, ...patch });
      return next;
    });
  };

  const clearCareerEdits = (rowId: string) =>
    setCareerEdits((current) => {
      if (!current.has(rowId)) return current;
      const next = new Map(current);
      next.delete(rowId);
      return next;
    });

  const handleAddCareerDraft = () => {
    if (!targetUserId || !canOperate) return;
    if (careerDraft) return;
    setCareerDraft(createEmptyCareerDraft(targetUserId));
    onBanner(null);
  };

  const handleCancelCareerDraft = () => {
    setCareerDraft(null);
    onBanner(null);
  };

  // ── submission upsert (line_target_id 기준, 작성기간 무관) ──
  const handleSaveSubmission = async (lineTargetId: string) => {
    if (saveDisabled) return;
    const row = submissionForms.find((r) => r.lineTargetId === lineTargetId);
    if (!row) return;

    // 구조화 입력 → 저장 payload. 서버(buildAdminSubmissionPayload)가 normalize 하므로
    // (빈 url 항목 제거, 빈 label/caption → null) 여기선 그대로 전달한다.
    const value: SubmissionPatchValue = {
      lineTargetId: row.lineTargetId,
      subtitle: row.subtitle.trim() === "" ? null : row.subtitle,
      growthPoint: row.growth_point.trim() === "" ? null : row.growth_point,
      outputLinks: row.outputLinks,
      outputImages: row.outputImages,
    };

    setSavingRowId(lineTargetId);
    onBanner(null);
    try {
      const response = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cluster4LineSubmissions: [value] }),
        },
      );
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to save.");
      }
      onBundleUpdate(json.data as Cluster4Bundle);
      clearSubmissionEdits(lineTargetId);
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
    const isDraft = isDraftId(rowId);
    const target = isDraft
      ? careerDraft
      : careerForm.find((row) => row.id === rowId);
    if (!target) return;

    if (isDraft) {
      if (!target.week_id) {
        onBanner({ kind: "error", message: "week 를 선택해 주세요." });
        return;
      }
      if (!target.project_id.trim()) {
        onBanner({ kind: "error", message: "project_id 를 입력해 주세요." });
        return;
      }
    }

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
      if (isDraft) {
        setCareerDraft(null);
      } else {
        clearCareerEdits(rowId);
      }
      onBanner({
        kind: "success",
        message: isDraft
          ? "신규 Career Record 가 추가되었습니다."
          : "저장되었습니다.",
      });
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

    const ok = await confirm({
      ...CONFIRM.delete,
      description: `${confirmMessage}\n\nid: ${id}`,
    });
    if (!ok) return;

    const paramKeyMap: Record<Cluster4DeleteResource, string> = {
      seasonReputation: "seasonReputationId",
      weeklyReputation: "weeklyReputationId",
      weeklyReview: "weeklyReviewId",
      weeklyColleague: "weeklyColleagueId",
      userActivityDetail: "userActivityDetailId",
      careerRecord: "careerRecordId",
      cluster4LineSubmission: "cluster4LineSubmissionId",
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
          Cluster4-card 4개 허브(Work Info / Ability / Exp / Career)의 운영 편집 영역입니다.
          개설·배정된 라인(line target) 슬롯의 제출값을 편집하며, 운영자는 작성기간과
          무관하게 수정/삭제할 수 있습니다.
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

        {activeSub !== "work_career" ? (
          <SubmissionSubPane
            key={activeSub}
            label={TAB_LABEL[activeSub]}
            rows={visibleSubmissionRows}
            canOperate={canOperate}
            savingRowId={savingRowId}
            tableAvailable={submissionTableAvailable}
            getWeekLabel={getWeekLabel}
            weekStartById={weekStartById}
            onChange={(lineTargetId, patch) =>
              setSubmissionRow(lineTargetId, patch)
            }
            onSave={(lineTargetId) => void handleSaveSubmission(lineTargetId)}
            onDelete={(submissionId, label) =>
              void handleDelete(
                "cluster4LineSubmission",
                submissionId,
                `${label} 제출값을 삭제할까요?`,
              )
            }
            devMode={devMode}
          />
        ) : (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                카드 내용{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  cluster4_line_submissions
                </span>
              </h3>
              <SubmissionSubPane
                key="work_career_submissions"
                label="Work Career"
                rows={careerSlotRows}
                canOperate={canOperate}
                savingRowId={savingRowId}
                tableAvailable={submissionTableAvailable}
                getWeekLabel={getWeekLabel}
                weekStartById={weekStartById}
                onChange={(lineTargetId, patch) =>
                  setSubmissionRow(lineTargetId, patch)
                }
                onSave={(lineTargetId) => void handleSaveSubmission(lineTargetId)}
                onDelete={(submissionId, label) =>
                  void handleDelete(
                    "cluster4LineSubmission",
                    submissionId,
                    `${label} 제출값을 삭제할까요?`,
                  )
                }
                devMode={devMode}
              />
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                프로젝트 기록{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  career_records
                </span>
              </h3>
              <CareerSubPane
                rows={visibleCareerRows}
                saveDisabled={saveDisabled}
                savingRowId={savingRowId}
                tableAvailable={bundle.tablesAvailable.careerRecords}
                getWeekLabel={getWeekLabel}
                weekOptions={Array.from(weekLabels.entries()).map(
                  ([id, label]) => ({ id, label }),
                )}
                canAdd={canOperate}
                draftActive={!!careerDraft}
                onAddDraft={handleAddCareerDraft}
                onCancelDraft={handleCancelCareerDraft}
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
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────── Submission(line target) pane — 주차 그룹핑 + 아코디언 ─────────────

type WeekGroup = {
  weekId: string;
  label: string;
  sortKey: string;
  rows: SubmissionFormRow[];
  total: number;
  submitted: number;
  missing: number;
};

// 슬롯을 weekId 로 묶고 주차 헤더 요약(총/제출/미제출)을 계산한다. 최근 주차 우선 정렬.
function buildWeekGroups(
  rows: SubmissionFormRow[],
  getWeekLabel: (id: string | null | undefined) => string,
  weekStartById: Map<string, string>,
): WeekGroup[] {
  const byWeek = new Map<string, SubmissionFormRow[]>();
  for (const row of rows) {
    const arr = byWeek.get(row.weekId) ?? [];
    arr.push(row);
    byWeek.set(row.weekId, arr);
  }
  const groups: WeekGroup[] = [];
  for (const [weekId, weekRows] of byWeek.entries()) {
    const submitted = weekRows.filter((r) => r.submissionId !== null).length;
    const label = getWeekLabel(weekId);
    const start = weekStartById.get(weekId) ?? "";
    // start_date 우선, 없으면 라벨에 박힌 날짜, 최후엔 weekId 로 정렬키 구성.
    const labelDate = label.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
    groups.push({
      weekId,
      label,
      sortKey: start || labelDate || weekId,
      rows: weekRows,
      total: weekRows.length,
      submitted,
      missing: weekRows.length - submitted,
    });
  }
  groups.sort((a, b) =>
    a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0,
  );
  return groups;
}

// 기본 펼침: 가장 최근 주차(첫 그룹) + submission 이 하나라도 있는 주차.
function defaultOpenWeeks(groups: WeekGroup[]): Set<string> {
  const open = new Set<string>();
  if (groups.length > 0) open.add(groups[0].weekId);
  for (const g of groups) if (g.submitted > 0) open.add(g.weekId);
  return open;
}

function SubmissionSubPane({
  label,
  rows,
  canOperate,
  savingRowId,
  tableAvailable,
  getWeekLabel,
  weekStartById,
  onChange,
  onSave,
  onDelete,
  devMode,
}: {
  label: string;
  rows: SubmissionFormRow[];
  canOperate: boolean;
  savingRowId: string | null;
  tableAvailable: boolean;
  getWeekLabel: (id: string | null | undefined) => string;
  weekStartById: Map<string, string>;
  onChange: (lineTargetId: string, patch: SubmissionFormPatch) => void;
  onSave: (lineTargetId: string) => void;
  onDelete: (submissionId: string, label: string) => void;
  devMode: boolean;
}) {
  const rowDisabled = !canOperate;
  const groups = useMemo(
    () => buildWeekGroups(rows, getWeekLabel, weekStartById),
    [rows, getWeekLabel, weekStartById],
  );
  // 컴포넌트는 탭 전환 시 key 로 remount 되므로, 마운트 시점의 groups 로 기본 펼침을 1회 계산.
  const [openWeeks, setOpenWeeks] = useState<Set<string>>(() =>
    defaultOpenWeeks(groups),
  );
  const [openSlots, setOpenSlots] = useState<Set<string>>(() => new Set());

  const toggleWeek = (weekId: string) =>
    setOpenWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(weekId)) next.delete(weekId);
      else next.add(weekId);
      return next;
    });
  const toggleSlot = (lineTargetId: string) =>
    setOpenSlots((prev) => {
      const next = new Set(prev);
      if (next.has(lineTargetId)) next.delete(lineTargetId);
      else next.add(lineTargetId);
      return next;
    });

  if (!tableAvailable) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <span className="font-mono text-xs">cluster4_line_submissions</span> 를 조회할 수
        없습니다.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-md border border-dashed bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        <p>{label} 에 개설/배정된 라인이 없습니다.</p>
        <p className="text-xs">먼저 라인 개설/배정을 진행해주세요.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const weekOpen = openWeeks.has(group.weekId);
        return (
          <div
            key={group.weekId}
            className="overflow-hidden rounded-lg border bg-card shadow-sm"
          >
            <button
              type="button"
              onClick={() => toggleWeek(group.weekId)}
              className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-muted/40"
              aria-expanded={weekOpen}
            >
              {weekOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="text-sm font-semibold text-foreground">
                {group.label}
              </span>
              <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="rounded bg-muted px-2 py-0.5">
                  총 {group.total}
                </span>
                <span className="rounded bg-emerald-100 px-2 py-0.5 text-emerald-700">
                  제출 {group.submitted}
                </span>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-700">
                  미제출 {group.missing}
                </span>
              </span>
            </button>

            {weekOpen && (
              <div className="flex flex-col gap-2 border-t bg-muted/20 px-3 py-3">
                {group.rows.map((row) => (
                  <SubmissionSlotCard
                    key={row.lineTargetId}
                    row={row}
                    open={openSlots.has(row.lineTargetId)}
                    rowDisabled={rowDisabled}
                    savingRowId={savingRowId}
                    getWeekLabel={getWeekLabel}
                    onToggle={() => toggleSlot(row.lineTargetId)}
                    onChange={onChange}
                    onSave={onSave}
                    onDelete={onDelete}
                    devMode={devMode}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// 슬롯 카드 — 접힘 시 최소 정보(mainTitle/상태/수정일), 펼침 시 상세 입력 + 저장/삭제.
function SubmissionSlotCard({
  row,
  open,
  rowDisabled,
  savingRowId,
  getWeekLabel,
  onToggle,
  onChange,
  onSave,
  onDelete,
  devMode,
}: {
  row: SubmissionFormRow;
  open: boolean;
  rowDisabled: boolean;
  savingRowId: string | null;
  getWeekLabel: (id: string | null | undefined) => string;
  onToggle: () => void;
  onChange: (lineTargetId: string, patch: SubmissionFormPatch) => void;
  onSave: (lineTargetId: string) => void;
  onDelete: (submissionId: string, label: string) => void;
  devMode: boolean;
}) {
  const isSubmitted = row.submissionId !== null;
  const updated = row.updatedAt ? row.updatedAt.slice(0, 10) : null;
  const headerTitle = `${row.mainTitle} · ${getWeekLabel(row.weekId)}`;

  return (
    <div
      className={cn(
        "rounded-md border bg-background",
        !isSubmitted && "border-amber-300/60",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            isSubmitted ? "bg-emerald-600 text-white" : "bg-amber-500 text-white",
          )}
        >
          {isSubmitted ? "제출됨" : "미제출"}
        </span>
        <span className="truncate text-sm font-medium text-foreground">
          {row.mainTitle}
        </span>
        {row.activityTypeId && (
          <span className="font-mono text-[11px] text-muted-foreground">
            [{row.activityTypeId}]
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {updated ? `수정 ${updated}` : "—"}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            {devMode ? (
              <span className="font-mono text-[10px] text-muted-foreground">
                lineTargetId: {row.lineTargetId}
                {row.submissionId ? ` · submissionId: ${row.submissionId}` : ""}
              </span>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => onSave(row.lineTargetId)}
                disabled={rowDisabled || savingRowId === row.lineTargetId}
              >
                <Save className="h-4 w-4" />
                {savingRowId === row.lineTargetId ? "저장 중..." : "저장"}
              </Button>
              {isSubmitted && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(row.submissionId!, headerTitle)}
                  disabled={rowDisabled || savingRowId === row.submissionId}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  삭제
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <FieldLabel>subtitle</FieldLabel>
              <textarea
                value={row.subtitle}
                onChange={(event) =>
                  onChange(row.lineTargetId, { subtitle: event.target.value })
                }
                disabled={rowDisabled}
                rows={2}
                maxLength={300}
                className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="self-end text-[10px] text-muted-foreground">
                {row.subtitle.length}/300
              </div>
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <FieldLabel>growthPoint</FieldLabel>
              <textarea
                value={row.growth_point}
                onChange={(event) =>
                  onChange(row.lineTargetId, { growth_point: event.target.value })
                }
                disabled={rowDisabled}
                rows={3}
                maxLength={2000}
                className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="self-end text-[10px] text-muted-foreground">
                {row.growth_point.length}/2000
              </div>
            </div>

            <div className="sm:col-span-2">
              <OutputLinksEditor
                links={row.outputLinks}
                disabled={rowDisabled}
                onChange={(next) =>
                  onChange(row.lineTargetId, { outputLinks: next })
                }
              />
            </div>

            <div className="sm:col-span-2">
              <OutputImagesEditor
                images={row.outputImages}
                disabled={rowDisabled}
                onChange={(next) =>
                  onChange(row.lineTargetId, { outputImages: next })
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── output_links / output_images 구조화 에디터 ─────────────
// raw JSON 노출 대신 항목별 카드로 url ↔ label / url ↔ caption 페어를 한눈에 보여준다.
// 저장 시 서버가 normalize 하므로(빈 url 제거, 빈 label/caption→null) 여기선 페어를 그대로 보관.

function OutputLinksEditor({
  links,
  disabled,
  onChange,
}: {
  links: Cluster4OutputLink[];
  disabled: boolean;
  onChange: (next: Cluster4OutputLink[]) => void;
}) {
  const update = (idx: number, patch: Partial<Cluster4OutputLink>) =>
    onChange(links.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const add = () => onChange([...links, { url: "", label: null }]);
  const remove = (idx: number) => onChange(links.filter((_, i) => i !== idx));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel>
          outputLinks{" "}
          <span className="font-mono normal-case text-muted-foreground">
            [{links.length}] {`{url, label}`}
          </span>
        </FieldLabel>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={add}
          disabled={disabled}
          className="h-7 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          링크 추가
        </Button>
      </div>

      {links.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/20 px-3 py-3 text-center text-xs text-muted-foreground">
          등록된 결과물 링크가 없습니다.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {links.map((link, idx) => (
            <div
              key={idx}
              className="rounded-md border bg-muted/20 px-3 py-2.5"
            >
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-foreground">
                  결과물 {idx + 1}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(idx)}
                  disabled={disabled}
                  className="h-6 px-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      설명 (label)
                    </span>
                    <span
                      className={`text-[10px] tabular-nums ${
                        (link.label ?? "").length > OUTPUT_LINK_LABEL_MAX_LENGTH
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {(link.label ?? "").length}/{OUTPUT_LINK_LABEL_MAX_LENGTH}
                    </span>
                  </div>
                  <Input
                    value={link.label ?? ""}
                    onChange={(event) =>
                      update(idx, {
                        label:
                          event.target.value === "" ? null : event.target.value,
                      })
                    }
                    disabled={disabled}
                    maxLength={OUTPUT_LINK_LABEL_MAX_LENGTH}
                    placeholder="예) GitHub 저장소, 발표 자료"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    URL
                  </span>
                  <Input
                    value={link.url}
                    onChange={(event) => update(idx, { url: event.target.value })}
                    disabled={disabled}
                    spellCheck={false}
                    placeholder="https://..."
                    className="h-8 font-mono text-xs"
                  />
                  {link.url.trim() !== "" && (
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[11px] text-blue-600 underline-offset-2 hover:underline"
                    >
                      {link.url}
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OutputImagesEditor({
  images,
  disabled,
  onChange,
}: {
  images: Cluster4OutputImage[];
  disabled: boolean;
  onChange: (next: Cluster4OutputImage[]) => void;
}) {
  const update = (idx: number, patch: Partial<Cluster4OutputImage>) =>
    onChange(images.map((im, i) => (i === idx ? { ...im, ...patch } : im)));
  const add = () => onChange([...images, { url: "", caption: null }]);
  const remove = (idx: number) => onChange(images.filter((_, i) => i !== idx));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel>
          outputImages{" "}
          <span className="font-mono normal-case text-muted-foreground">
            [{images.length}] {`{url, caption}`}
          </span>
        </FieldLabel>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={add}
          disabled={disabled}
          className="h-7 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          이미지 추가
        </Button>
      </div>

      {images.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/20 px-3 py-3 text-center text-xs text-muted-foreground">
          등록된 이미지가 없습니다.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {images.map((image, idx) => (
            <div
              key={idx}
              className="rounded-md border bg-muted/20 px-3 py-2.5"
            >
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-foreground">
                  이미지 {idx + 1}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(idx)}
                  disabled={disabled}
                  className="h-6 px-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex gap-3">
                <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background">
                  {image.url.trim() !== "" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={image.url}
                      alt={image.caption ?? `이미지 ${idx + 1}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-[10px] text-muted-foreground">
                      미리보기
                    </span>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        설명 (caption)
                      </span>
                      <span
                        className={`text-[10px] tabular-nums ${
                          (image.caption ?? "").length >
                          OUTPUT_IMAGE_CAPTION_MAX_LENGTH
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }`}
                      >
                        {(image.caption ?? "").length}/
                        {OUTPUT_IMAGE_CAPTION_MAX_LENGTH}
                      </span>
                    </div>
                    <Input
                      value={image.caption ?? ""}
                      onChange={(event) =>
                        update(idx, {
                          caption:
                            event.target.value === ""
                              ? null
                              : event.target.value,
                        })
                      }
                      disabled={disabled}
                      maxLength={OUTPUT_IMAGE_CAPTION_MAX_LENGTH}
                      placeholder="예) 아키텍처 도면"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      원본 URL
                    </span>
                    <Input
                      value={image.url}
                      onChange={(event) =>
                        update(idx, { url: event.target.value })
                      }
                      disabled={disabled}
                      spellCheck={false}
                      placeholder="https://..."
                      className="h-8 font-mono text-xs"
                    />
                    {image.url.trim() !== "" && (
                      <a
                        href={image.url}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-[11px] text-blue-600 underline-offset-2 hover:underline"
                      >
                        {image.url}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────── Work Career pane (career_records) ─────────────

function CareerSubPane({
  rows,
  saveDisabled,
  savingRowId,
  tableAvailable,
  getWeekLabel,
  weekOptions,
  canAdd,
  draftActive,
  onAddDraft,
  onCancelDraft,
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
  weekOptions: Array<{ id: string; label: string }>;
  canAdd: boolean;
  draftActive: boolean;
  onAddDraft: () => void;
  onCancelDraft: () => void;
  onChange: (rowId: string, patch: Partial<CareerFormRow>) => void;
  onSave: (rowId: string) => void;
  onDelete: (rowId: string, label: string) => void;
  devMode: boolean;
}) {
  const rowDisabled = saveDisabled;
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
      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        <p>
          career_records row 가 없습니다. 운영자는 아래 버튼으로 새 Career Record 를
          추가할 수 있습니다.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAddDraft}
          disabled={!canAdd}
        >
          <Plus className="h-4 w-4" />
          Career Record 추가
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!draftActive && (
        <div className="flex items-center justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onAddDraft}
            disabled={!canAdd}
          >
            <Plus className="h-4 w-4" />
            Career Record 추가
          </Button>
        </div>
      )}
      {rows.map((row) => {
        const isDraft = isDraftId(row.id);
        const project = row.project;
        const projectLabel = isDraft
          ? "신규 Career Record"
          : project
            ? `${project.company_name ?? "-"} · ${project.project_name ?? "-"}`
            : "(project not found)";
        return (
          <div
            key={row.id}
            className={cn(
              "rounded-lg border bg-card shadow-sm",
              isDraft && "border-primary/40 bg-primary/5",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {isDraft && (
                    <span className="rounded bg-primary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-foreground">
                      신규
                    </span>
                  )}
                  <span>{projectLabel}</span>
                </div>
                {!isDraft && (
                  <div className="text-[11px] text-muted-foreground">
                    {getWeekLabel(row.week_id)}
                    {project?.line_code && (
                      <span className="ml-2 font-mono">[{project.line_code}]</span>
                    )}
                  </div>
                )}
                {devMode && !isDraft && (
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
                  disabled={rowDisabled || savingRowId === row.id}
                >
                  <Save className="h-4 w-4" />
                  {savingRowId === row.id
                    ? "저장 중..."
                    : isDraft
                      ? "추가"
                      : "저장"}
                </Button>
                {isDraft ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onCancelDraft}
                    disabled={savingRowId === row.id}
                  >
                    <X className="h-4 w-4" />
                    취소
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onDelete(
                        row.id,
                        `${projectLabel} · ${getWeekLabel(row.week_id)}`,
                      )
                    }
                    disabled={rowDisabled || savingRowId === row.id}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    삭제
                  </Button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2">
              {isDraft && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>week (작성 주차)</FieldLabel>
                    <Select
                      value={row.week_id || "__none__"}
                      onValueChange={(value: string | null) =>
                        onChange(row.id, {
                          week_id: value === "__none__" ? "" : (value ?? ""),
                        })
                      }
                      disabled={rowDisabled}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="주차 선택" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">— 선택</SelectItem>
                        {weekOptions.map((opt) => (
                          <SelectItem key={opt.id} value={opt.id}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>
                      {devMode
                        ? "project_id (career_projects.id, UUID)"
                        : "실무 경력 프로젝트 식별값"}
                    </FieldLabel>
                    <Input
                      value={row.project_id}
                      onChange={(event) =>
                        onChange(row.id, { project_id: event.target.value })
                      }
                      disabled={rowDisabled}
                      placeholder={
                        devMode
                          ? "career_projects.id UUID 입력"
                          : "실무 경력 프로젝트 식별값 입력"
                      }
                      className="h-9 font-mono text-xs"
                    />
                  </div>
                </>
              )}

              {!isDraft && project && (
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
                  disabled={rowDisabled}
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
                  disabled={rowDisabled}
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
                  disabled={rowDisabled}
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
                  disabled={rowDisabled}
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
