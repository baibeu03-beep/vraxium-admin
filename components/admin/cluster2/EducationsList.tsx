"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Plus, Star, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FieldCell, type FieldDef } from "@/components/admin/fieldKit";

// user_educations (실제 schema 기준):
//   id, user_id, school_name, major_name_1, sort_order, is_primary,
//   created_at, updated_at
//
// 저장 시 admin PATCH 가 user_id 의 전체 row 삭제 후 재삽입.
// 대표학력 = is_primary=true (저장 시 sort_order=0 동기화).

export type EducationDto = {
  id: string | number;
  school_name: string | null;
  major_name_1: string | null;
  sort_order: number;
  is_primary: boolean;
};

export const EDUCATION_FIELD_DEFS: readonly FieldDef[] = [
  { key: "school_name", label: "학교 (school_name)", type: "text" },
  { key: "major_name_1", label: "전공 (major_name_1)", type: "text" },
];

export default function EducationsList({
  rows,
  onChange,
  disabled,
}: {
  rows: EducationDto[];
  onChange: (next: EducationDto[]) => void;
  disabled?: boolean;
}) {
  const primaryIndex = rows.findIndex((r) => r.is_primary);

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
    const newRow: EducationDto = {
      id: `new-${Date.now()}-${nextIndex}`,
      school_name: null,
      major_name_1: null,
      sort_order: hasPrimary
        ? rows.filter((r) => !r.is_primary).length + 1
        : 0,
      is_primary: !hasPrimary,
    };
    onChange([...rows, newRow]);
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && (
        <div className="rounded-md border border-dashed bg-muted/10 px-3 py-6 text-center text-sm text-muted-foreground">
          등록된 학력 row 가 없습니다.
        </div>
      )}

      {rows.map((row, index) => {
        const isPrimary = row.is_primary;
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

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {EDUCATION_FIELD_DEFS.map((field) => (
                <FieldCell
                  key={field.key}
                  field={field}
                  value={(row as Record<string, unknown>)[field.key]}
                  onChange={(v) => setFieldValue(index, field.key, v)}
                  disabled={disabled}
                />
              ))}
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">sort_order (정수)</Label>
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
                <Label className="text-xs">is_primary (대표 여부)</Label>
                <label className="mt-1 inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={row.is_primary}
                    onChange={(e) =>
                      e.target.checked
                        ? markPrimary(index)
                        : setFieldValue(index, "is_primary", false)
                    }
                    disabled={disabled}
                  />
                  <span className="text-muted-foreground">
                    {row.is_primary ? "true" : "false"}
                  </span>
                </label>
              </div>
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          대표학력 (is_primary=true):{" "}
          {primaryIndex >= 0 ? `Row #${primaryIndex + 1}` : "없음"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addRow}
          disabled={disabled}
        >
          <Plus className="h-4 w-4" />
          학력 row 추가
        </Button>
      </div>
    </div>
  );
}
