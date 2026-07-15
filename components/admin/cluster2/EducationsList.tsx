"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Plus, Star, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox, checkedTextClass } from "@/components/ui/checkbox";
import { FieldCell, fmt, type FieldDef } from "@/components/admin/fieldKit";
import { formatAdminDateTime } from "@/lib/adminDateTime";

// "학교 (school_name)" → "학교" (운영자 친화)
// 라벨 끝 괄호가 영문/언더스코어 (= column name) 일 때만 제거한다.
function operatorLabel(label: string): string {
  return label.replace(/\s*\([a-z0-9_,\s]+\)\s*$/i, "").trim() || label;
}

function operatorize(fields: readonly FieldDef[]): readonly FieldDef[] {
  return fields.map((f) => ({ ...f, label: operatorLabel(f.label) }));
}

// user_educations (실제 schema 기준 — 2026-05-13 PostgREST OpenAPI 확인):
//   readonly meta:  id (uuid), user_id (uuid), created_at, updated_at
//   core (편집):    school_name, major_name_1, sort_order (integer), is_primary (boolean)
//   extra (편집, 모두 text):
//     education_level, status, major_category,
//     major_name_2, major_name_3,
//     admission_year, admission_month,
//     graduation_year, graduation_month,
//     grade_max_type, grade_value, note
//
// 저장 시 admin PATCH 가 user_id 의 전체 row 삭제 후 재삽입.
// ⇒ id 는 매 저장마다 새로 발급되므로 readonly 표시 전용.
// 대표학력 = is_primary=true (저장 시 sort_order=0 동기화).

export type EducationDto = {
  id: string | number;
  user_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  school_name: string | null;
  major_name_1: string | null;
  sort_order: number;
  is_primary: boolean;
  education_level: string | null;
  status: string | null;
  major_category: string | null;
  major_name_2: string | null;
  major_name_3: string | null;
  admission_year: string | null;
  admission_month: string | null;
  graduation_year: string | null;
  graduation_month: string | null;
  grade_max_type: string | null;
  grade_value: string | null;
  note: string | null;
};

// Cluster2Editor 의 buildPatchBody 가 이 list 를 돌면서 normalizeForPatch 호출.
// sort_order / is_primary 는 Cluster2Editor 측에서 별도 처리하므로 여기 포함하지 않는다.
const EDUCATION_CORE_TEXT_FIELDS: readonly FieldDef[] = [
  {
    key: "school_name",
    label: "학교 (school_name)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.schoolName",
  },
  {
    key: "major_name_1",
    label: "전공 (major_name_1)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.majorName1",
  },
];

const EDUCATION_EXTRA_FIELDS: readonly FieldDef[] = [
  {
    key: "education_level",
    label: "학력 구분 (education_level)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.educationLevel",
  },
  {
    key: "status",
    label: "재학/졸업 상태 (status)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.status",
  },
  {
    key: "major_category",
    label: "전공 카테고리 (major_category)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.majorCategory",
  },
  {
    key: "major_name_2",
    label: "복수전공 (major_name_2)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.majorName2",
  },
  {
    key: "major_name_3",
    label: "부전공 (major_name_3)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.majorName3",
  },
  {
    key: "admission_year",
    label: "입학 연도 (admission_year, text)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.admissionYear",
  },
  {
    key: "admission_month",
    label: "입학 월 (admission_month, text)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.admissionMonth",
  },
  {
    key: "graduation_year",
    label: "졸업 연도 (graduation_year, text)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.graduationYear",
  },
  {
    key: "graduation_month",
    label: "졸업 월 (graduation_month, text)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.graduationMonth",
  },
  {
    key: "grade_max_type",
    label: "성적 만점 기준 (grade_max_type)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.gradeMaxType",
  },
  {
    key: "grade_value",
    label: "성적 (grade_value, text)",
    type: "text",
    helpKey: "admin.crews.cluster2.education.field.gradeValue",
  },
  {
    key: "note",
    label: "비고 (note)",
    type: "textarea",
    full: true,
    helpKey: "admin.crews.cluster2.education.field.note",
  },
];

export const EDUCATION_FIELD_DEFS: readonly FieldDef[] = [
  ...EDUCATION_CORE_TEXT_FIELDS,
  ...EDUCATION_EXTRA_FIELDS,
];

function newEducationRow(seedIndex: number, isPrimary: boolean): EducationDto {
  return {
    id: `new-${Date.now()}-${seedIndex}`,
    user_id: null,
    created_at: null,
    updated_at: null,
    school_name: null,
    major_name_1: null,
    sort_order: isPrimary ? 0 : seedIndex + 1,
    is_primary: isPrimary,
    education_level: null,
    status: null,
    major_category: null,
    major_name_2: null,
    major_name_3: null,
    admission_year: null,
    admission_month: null,
    graduation_year: null,
    graduation_month: null,
    grade_max_type: null,
    grade_value: null,
    note: null,
  };
}

export default function EducationsList({
  rows,
  onChange,
  disabled,
  devMode = false,
}: {
  rows: EducationDto[];
  onChange: (next: EducationDto[]) => void;
  disabled?: boolean;
  devMode?: boolean;
}) {
  const primaryIndex = rows.findIndex((r) => r.is_primary);
  const coreFields = useMemo(
    () => (devMode ? EDUCATION_CORE_TEXT_FIELDS : operatorize(EDUCATION_CORE_TEXT_FIELDS)),
    [devMode],
  );
  const extraFields = useMemo(
    () => (devMode ? EDUCATION_EXTRA_FIELDS : operatorize(EDUCATION_EXTRA_FIELDS)),
    [devMode],
  );

  const setFieldValue = (index: number, key: string, value: unknown) => {
    const next = rows.map((row, i) =>
      i === index ? ({ ...row, [key]: value } as EducationDto) : row,
    );
    onChange(next);
  };

  const markPrimary = (index: number) => {
    // 대표 = is_primary true + sort_order 0. 나머지는 is_primary false, sort_order 1..N.
    let counter = 1;
    const reordered = rows.map((row, i) => {
      if (i === index) return { ...row, is_primary: true, sort_order: 0 };
      return { ...row, is_primary: false, sort_order: counter++ };
    });
    onChange(reordered);
  };

  const removeRow = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    // sort_order 재정렬 — 대표 (is_primary=true) 는 sort_order=0 으로, 나머지 1..N
    let counter = 1;
    const reordered = next.map((row) => {
      if (row.is_primary) return { ...row, sort_order: 0 };
      return { ...row, sort_order: counter++ };
    });
    onChange(reordered);
  };

  const addRow = () => {
    const nextIndex = rows.length;
    const hasPrimary = rows.some((r) => r.is_primary);
    onChange([...rows, newEducationRow(nextIndex, !hasPrimary)]);
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && (
        <div className="rounded-md border border-dashed bg-muted/10 px-3 py-6 text-center text-sm text-muted-foreground">
          {devMode ? "등록된 학력 row 가 없습니다." : "등록된 학력이 없습니다."}
        </div>
      )}

      {rows.map((row, index) => {
        const isPrimary = row.is_primary;
        const mismatch = isPrimary !== (row.sort_order === 0);
        return (
          <div
            key={String(row.id) || index}
            className={cn(
              "rounded-md border p-3",
              isPrimary
                ? "border-emerald-300 bg-emerald-50/40"
                : "border-border bg-card",
            )}
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">Row #{index + 1}</span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px]",
                    isPrimary
                      ? "bg-emerald-200 text-emerald-900"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  sort_order {row.sort_order}
                </span>
                {isPrimary && (
                  <span className="rounded-full bg-emerald-200 px-2 py-0.5 text-[10px] text-emerald-900">
                    대표 (is_primary)
                  </span>
                )}
                {mismatch && (
                  <span
                    className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] text-amber-900"
                    title="is_primary 와 sort_order=0 이 불일치합니다. 대표학력 toggle 또는 sort_order 를 조정하세요."
                  >
                    ⚠ is_primary ↔ sort_order=0 불일치
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {!isPrimary && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => markPrimary(index)}
                    disabled={disabled}
                    title="이 row 를 대표학력으로"
                  >
                    <Star className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeRow(index)}
                  disabled={disabled}
                  title="삭제"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Core 편집 영역 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {coreFields.map((field) => (
                <FieldCell
                  key={field.key}
                  field={field}
                  value={(row as Record<string, unknown>)[field.key]}
                  onChange={(v) => setFieldValue(index, field.key, v)}
                  disabled={disabled}
                />
              ))}
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">
                  {devMode ? "sort_order (integer)" : "정렬 순서"}
                </Label>
                <input
                  type="number"
                  value={row.sort_order}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setFieldValue(
                      index,
                      "sort_order",
                      Number.isFinite(n) ? n : 0,
                    );
                  }}
                  disabled={disabled}
                  className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className={cn("text-xs", checkedTextClass(row.is_primary))}>
                  {devMode ? "is_primary (대표 여부)" : "대표학력"}
                </Label>
                <label className="mt-1 inline-flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={row.is_primary}
                    onChange={(e) =>
                      e.target.checked
                        ? markPrimary(index)
                        : setFieldValue(index, "is_primary", false)
                    }
                    disabled={disabled}
                  />
                  <span className="text-muted-foreground">
                    {row.is_primary
                      ? devMode
                        ? "true"
                        : "예"
                      : devMode
                        ? "false"
                        : "아니오"}
                  </span>
                </label>
              </div>
            </div>

            {/* Extra (optional) 편집 영역 */}
            <details className="mt-3 rounded-md border border-dashed border-border/60 bg-muted/10 p-2 open:bg-muted/20">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                {devMode ? "추가 필드 (12개, 모두 text)" : "추가 정보 (12개 항목)"}
              </summary>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {extraFields.map((field) => (
                  <FieldCell
                    key={field.key}
                    field={field}
                    value={(row as Record<string, unknown>)[field.key]}
                    onChange={(v) => setFieldValue(index, field.key, v)}
                    disabled={disabled}
                  />
                ))}
              </div>
            </details>

            {/* Readonly meta (id / user_id / created_at / updated_at) — dev only */}
            {devMode && (
              <dl className="mt-3 grid grid-cols-1 gap-x-3 gap-y-1 rounded-md bg-muted/30 px-2 py-1.5 text-[10px] text-muted-foreground sm:grid-cols-2">
                <div className="flex gap-1">
                  <dt className="font-medium">id:</dt>
                  <dd className="break-all">{fmt(row.id)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt className="font-medium">user_id:</dt>
                  <dd className="break-all">{fmt(row.user_id)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt className="font-medium">created_at:</dt>
                  <dd>{formatAdminDateTime(row.created_at)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt className="font-medium">updated_at:</dt>
                  <dd>{formatAdminDateTime(row.updated_at)}</dd>
                </div>
              </dl>
            )}
          </div>
        );
      })}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {devMode ? "대표학력 (is_primary=true): " : "대표학력: "}
          {primaryIndex >= 0
            ? devMode
              ? `Row #${primaryIndex + 1}`
              : `${primaryIndex + 1}번째 학력`
            : "없음"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addRow}
          disabled={disabled}
        >
          <Plus className="h-4 w-4" />
          {devMode ? "학력 row 추가" : "학력 추가"}
        </Button>
      </div>
    </div>
  );
}
