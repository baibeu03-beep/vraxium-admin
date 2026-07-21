"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { useActionToast } from "@/lib/actionToast";
import { CAREER_GRADES, CAREER_GRADE_POINTS } from "@/lib/careerGrade";
import type {
  CareerEvaluationTargetDto,
  CareerGrade,
} from "@/lib/adminCareerEvaluationsTypes";

type CareerLineOption = {
  id: string;
  lineCode: string | null;
  mainTitle: string;
};

type Banner = { kind: "success" | "error"; message: string } | null;

const RATING_STATUS_LABEL: Record<
  CareerEvaluationTargetDto["ratingStatus"],
  string
> = {
  unevaluated: "미평가",
  success: "강화 성공",
  fail: "강화 실패",
};

// ── 테이블 컬럼 정의(헤더 라벨 · 도움말 키 · 정렬 기준) ─────────────────────────
//   · sortValue 가 있는 컬럼만 정렬 가능. 저장(액션) 컬럼은 정렬 제외(도움말만).
//   · 정렬 기준은 표시 문자열이 아니라 "실제 정렬 가능한 값":
//       대상자 = 한글 locale 문자열, 등급 = 업무 순서(S>A>B>C>D) enum,
//       점수 = 숫자(환산 점수), 강화 상태 = 업무 순서 enum. 빈값(미입력)은 항상 뒤.
type ColKey = "target" | "grade" | "score" | "status" | "save";
type SortValue = number | string | null;

// 등급 업무 순서: S → A → B → C → D (S 가 최상위).
const GRADE_SORT_ORDER: Record<CareerGrade, number> = {
  S: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
};
// 강화 상태 순서: 미평가 → 강화 성공 → 강화 실패.
const RATING_STATUS_SORT_ORDER: Record<
  CareerEvaluationTargetDto["ratingStatus"],
  number
> = {
  unevaluated: 0,
  success: 1,
  fail: 2,
};

// 빈값 규칙: null/undefined/빈문자열/공백/"-" 는 모두 동일한 빈값으로 정규화(→ null).
function emptyToNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === "" || t === "-" ? null : t;
}

type ColumnDef = {
  key: ColKey;
  label: string;
  helpKey: string;
  // 없으면 정렬 불가(액션 전용 컬럼).
  sortValue?: (row: CareerEvaluationTargetDto) => SortValue;
};

const COLUMNS: ColumnDef[] = [
  {
    key: "target",
    label: "대상자",
    helpKey: "admin.career.evaluation.column.target",
    // 표시와 동일하게 이름(없으면 userId)으로 정렬 — 한글 locale.
    sortValue: (r) => emptyToNull(r.displayName ?? r.userId),
  },
  {
    key: "grade",
    label: "등급",
    helpKey: "admin.career.evaluation.column.grade",
    sortValue: (r) => (r.grade ? GRADE_SORT_ORDER[r.grade] : null),
  },
  {
    key: "score",
    label: "점수",
    helpKey: "admin.career.evaluation.column.score",
    sortValue: (r) => r.gradePoints ?? null,
  },
  {
    key: "status",
    label: "강화 상태",
    helpKey: "admin.career.evaluation.column.enhancementStatus",
    sortValue: (r) => RATING_STATUS_SORT_ORDER[r.ratingStatus],
  },
  {
    key: "save",
    label: "저장",
    helpKey: "admin.career.evaluation.action.save",
  },
];

// null/빈값/"-" 은 정렬 방향과 무관하게 항상 뒤로. 숫자는 숫자, 문자열은 한글 locale.
function compareSortValues(
  a: SortValue,
  b: SortValue,
  dir: "asc" | "desc",
): number {
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  let c: number;
  if (typeof a === "number" && typeof b === "number") c = a - b;
  else c = String(a).localeCompare(String(b), "ko");
  return dir === "asc" ? c : -c;
}

// 컬럼 헤더: 정렬 트리거(button)와 도움말(button)을 형제로 둔다(버튼 중첩 방지).
//   · 액션 컬럼(sortValue 없음)은 정렬 트리거 없이 라벨 + 도움말만.
function ColumnHeader({
  col,
  dir,
  onSort,
}: {
  col: ColumnDef;
  dir: "asc" | "desc" | null;
  onSort: () => void;
}) {
  const sortable = Boolean(col.sortValue);
  return (
    <TableHead
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"
      }
    >
      <span className="inline-flex items-center justify-center gap-1">
        {sortable ? (
          <button
            type="button"
            onClick={onSort}
            aria-label={`${col.label} 정렬`}
            className={cn(
              "inline-flex items-center gap-1 text-sm font-semibold tracking-wide text-muted-foreground hover:text-foreground",
              dir && "text-foreground",
            )}
          >
            <span>{col.label}</span>
            {dir === "asc" ? (
              <ArrowUp className="h-3 w-3" />
            ) : dir === "desc" ? (
              <ArrowDown className="h-3 w-3" />
            ) : (
              <ArrowUpDown className="h-3 w-3 opacity-40" />
            )}
          </button>
        ) : (
          <span className="text-sm font-semibold tracking-wide text-muted-foreground">
            {col.label}
          </span>
        )}
        <AdminHelpIconButton helpKey={col.helpKey} title={col.label} size="xs" />
      </span>
    </TableHead>
  );
}

// 운영자 평가는 작성기간과 무관(지난 주차도 입력/수정 가능). D(2점)=강화 실패.
export default function CareerEvaluationTab({
  lines,
}: {
  lines: CareerLineOption[];
}) {
  const t = useActionToast();
  const [selectedLineId, setSelectedLineId] = useState<string>("");
  const [targets, setTargets] = useState<CareerEvaluationTargetDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingTargetId, setSavingTargetId] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  // 행별 grade 선택 임시값 (저장 전).
  const [draftGrade, setDraftGrade] = useState<Record<string, CareerGrade | "">>({});
  // 컬럼 헤더 클릭 정렬. null = 기본(서버) 순서. 클릭 순환: 없음 → asc → desc → 기본.
  const [columnSort, setColumnSort] = useState<{
    key: ColKey;
    dir: "asc" | "desc";
  } | null>(null);

  const cycleSort = (key: ColKey) => {
    setColumnSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // 내림차순 다음 클릭 → 기본 순서 복귀
    });
  };

  // 원본(targets)은 mutate 하지 않고 복사본을 정렬. columnSort=null 이면 원본 순서 그대로.
  const sortedTargets = useMemo(() => {
    if (!columnSort) return targets;
    const col = COLUMNS.find((c) => c.key === columnSort.key);
    if (!col?.sortValue) return targets;
    const sortValue = col.sortValue;
    return [...targets].sort((a, b) =>
      compareSortValues(sortValue(a), sortValue(b), columnSort.dir),
    );
  }, [targets, columnSort]);

  const loadTargets = useCallback(async (lineId: string) => {
    if (!lineId) {
      setTargets([]);
      setDraftGrade({});
      return;
    }
    setLoading(true);
    setBanner(null);
    try {
      // ⚠ QA 누수 차단: 라인 대상자 평가도 mode 전달 — 백엔드 mode-aware(operating/test 모집단).
      const res = await fetch(
        appendModeQuery(
          `/api/admin/cluster4/career-evaluations?line_id=${encodeURIComponent(lineId)}`,
          readScopeMode(new URLSearchParams(window.location.search)),
        ),
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "대상자 평가를 불러오지 못했습니다.");
      }
      const rows = (json.data?.targets ?? []) as CareerEvaluationTargetDto[];
      setTargets(rows);
      setDraftGrade(
        Object.fromEntries(rows.map((r) => [r.lineTargetId, r.grade ?? ""])),
      );
    } catch (e) {
      console.error("career evaluations load failed", e);
      t.raw("error", "대상자 평가를 불러오지 못했습니다.");
      setTargets([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadTargets(selectedLineId);
  }, [selectedLineId, loadTargets]);

  async function handleSave(target: CareerEvaluationTargetDto) {
    const grade = draftGrade[target.lineTargetId];
    if (!grade) {
      setBanner({ kind: "error", message: "등급(S/A/B/C/D)을 선택해주세요." });
      return;
    }
    setSavingTargetId(target.lineTargetId);
    setBanner(null);
    let status = 0;
    try {
      const res = await fetch("/api/admin/cluster4/career-evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          line_target_id: target.lineTargetId,
          user_id: target.userId,
          grade,
          // 조회(loadTargets)와 동일 모드를 저장에도 전달 — 서버 스코프 가드와 정합(대상 사용자 스코프 전용).
          ...(readScopeMode(new URLSearchParams(window.location.search)) === "test"
            ? { mode: "test" }
            : {}),
        }),
      });
      status = res.status;
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "평가 저장에 실패했습니다.");
      }
      // 로컬 상태 갱신 (재조회 없이 즉시 반영).
      setTargets((prev) =>
        prev.map((row) =>
          row.lineTargetId === target.lineTargetId
            ? {
                ...row,
                grade,
                gradePoints: CAREER_GRADE_POINTS[grade],
                ratingStatus: CAREER_GRADE_POINTS[grade] <= 3 ? "fail" : "success",
              }
            : row,
        ),
      );
      console.warn(
        `career evaluation saved: user=${target.userId} grade=${grade} (${CAREER_GRADE_POINTS[grade]}pt)`,
      );
      t.success("save");
    } catch (e) {
      console.error("career evaluation save failed", e);
      t.error("save", status ? { status } : undefined);
    } finally {
      setSavingTargetId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            경력 라인 평가
            <AdminHelpIconButton
              helpKey="admin.career.evaluation.title.card"
              title="경력 라인 평가"
              size="xs"
            />
          </CardTitle>
          <CardDescription className="inline-flex flex-wrap items-center gap-1">
            개설된 실무 경력 라인의 대상자별 평점(S/A/B/C/D)을 입력합니다. 점수 환산 S=10·A=8·B=6·C=4·D=2,
            D(2점)는 강화 실패로 처리됩니다. 운영자 평가는 작성기간과 무관하게 입력·수정할 수 있습니다.
            <AdminHelpIconButton
              helpKey="admin.career.evaluation.desc.card"
              title="경력 라인 평가 기준"
              size="xs"
            />
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              평가 대상 라인
              <AdminHelpIconButton
                helpKey="admin.career.evaluation.input.targetLine"
                title="평가 대상 라인"
              />
            </Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedLineId}
              onChange={(e) => setSelectedLineId(e.target.value)}
            >
              <option value="">실무 경력 라인을 선택해주세요</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.lineCode ? `[${l.lineCode}] ` : ""}
                  {l.mainTitle}
                </option>
              ))}
            </select>
          </div>

          {banner && (
            <p
              className={
                banner.kind === "success"
                  ? "text-sm font-medium text-green-600"
                  : "text-sm font-medium text-red-600"
              }
            >
              {banner.message}
            </p>
          )}
        </CardContent>
      </Card>

      {selectedLineId && (
        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <LoadingState active />
            ) : targets.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                이 라인에 배정된 대상자가 없습니다.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {COLUMNS.map((col) => (
                      <ColumnHeader
                        key={col.key}
                        col={col}
                        dir={columnSort?.key === col.key ? columnSort.dir : null}
                        onSort={() => cycleSort(col.key)}
                      />
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedTargets.map((t) => {
                    const draft = draftGrade[t.lineTargetId] ?? "";
                    return (
                      <TableRow key={t.lineTargetId}>
                        <TableCell className="font-medium">
                          {t.displayName ?? t.userId}
                        </TableCell>
                        <TableCell>
                          <select
                            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                            value={draft}
                            onChange={(e) =>
                              setDraftGrade((prev) => ({
                                ...prev,
                                [t.lineTargetId]: e.target.value as CareerGrade | "",
                              }))
                            }
                          >
                            <option value="">미입력</option>
                            {CAREER_GRADES.map((g) => (
                              <option key={g} value={g}>
                                {g} ({CAREER_GRADE_POINTS[g]}점)
                              </option>
                            ))}
                          </select>
                        </TableCell>
                        <TableCell>
                          {draft ? `${CAREER_GRADE_POINTS[draft]}점` : "-"}
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              t.ratingStatus === "fail"
                                ? "text-red-600"
                                : t.ratingStatus === "success"
                                  ? "text-green-600"
                                  : "text-muted-foreground"
                            }
                          >
                            {RATING_STATUS_LABEL[t.ratingStatus]}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            loading={savingTargetId === t.lineTargetId}
                            onClick={() => handleSave(t)}
                            disabled={savingTargetId === t.lineTargetId || !draft}
                          >
                            저장
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
