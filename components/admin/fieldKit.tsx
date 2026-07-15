"use client";

import type React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { cn } from "@/lib/utils";
import { Checkbox, checkedTextClass } from "@/components/ui/checkbox";

// Admin editor 공용 field 정의 + 렌더링 부품.
// resume-card editor 에서 추출한 패턴이며, cluster2 등 다른 editor 도 재사용한다.

export type FieldType =
  | "text"
  | "textarea"
  | "date"
  | "number"
  | "checkbox"
  | "select"
  | "url";

export type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
  placeholder?: string;
  full?: boolean;
  // number 타입에서만 사용. 브라우저 native 검증/스피너 동작용.
  min?: number;
  max?: number;
  step?: number;
  // text/textarea 에 적용. 지정 시 native maxLength + 카운터(`현재/최대`) 표시.
  // 카운터 색상: 0~maxLength-100 normal, ~-1 warning, maxLength reached.
  maxLength?: number;
  // 선택: 필드 라벨 옆에 요소별 돋보기 도움말(AdminHelpIconButton)을 붙일 helpKey.
  //   지정 시에만 아이콘 노출 — 미지정 caller 는 영향 없음(비파괴적).
  helpKey?: string;
};

// PATCH body 로 보내기 전 값 정규화.
//   - checkbox → boolean
//   - 빈 문자열 → null
//   - number 타입 → 숫자 변환 (실패 시 null)
export function normalizeForPatch(value: unknown, type: FieldType): unknown {
  if (type === "checkbox") return Boolean(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (type === "number") {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    return trimmed;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return value ?? null;
}

export function FieldCell({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const showCounter =
    typeof field.maxLength === "number" &&
    (field.type === "text" || field.type === "textarea" || field.type === "url");
  const currentLength =
    typeof value === "string" ? value.length : value == null ? 0 : String(value).length;
  const maxLength = field.maxLength ?? 0;
  // 색상 상태: 0~max-100 normal, max-99~max-1 warning, max reached.
  const counterTone = !showCounter
    ? "muted"
    : currentLength >= maxLength
      ? "limit"
      : currentLength >= maxLength - 100
        ? "warning"
        : "muted";

  return (
    <div className={cn("flex flex-col gap-1.5", field.full && "sm:col-span-2")}>
      {field.helpKey ? (
        <Label className="inline-flex items-center gap-1 text-xs">
          {field.label}
          <AdminHelpIconButton
            helpKey={field.helpKey}
            title={field.label}
            size="xs"
          />
        </Label>
      ) : (
        <Label className="text-xs">{field.label}</Label>
      )}
      <FieldInput
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
      {showCounter && (
        <div
          className={cn(
            "self-end text-[10px] tabular-nums",
            counterTone === "limit" && "font-semibold text-red-600",
            counterTone === "warning" && "font-medium text-amber-600",
            counterTone === "muted" && "text-muted-foreground",
          )}
          aria-live="polite"
        >
          {currentLength.toLocaleString()} / {maxLength.toLocaleString()}
          {counterTone === "limit" && " · 제한 도달"}
        </div>
      )}
    </div>
  );
}

export function FieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const stringValue = value == null ? "" : String(value);

  if (field.type === "textarea") {
    return (
      <textarea
        value={stringValue}
        onChange={(e) => {
          // maxLength 가 있으면 paste 등 비표준 경로에서도 잘라낸다.
          const next =
            typeof field.maxLength === "number"
              ? e.target.value.slice(0, field.maxLength)
              : e.target.value;
          onChange(next);
        }}
        disabled={disabled}
        rows={3}
        placeholder={field.placeholder}
        maxLength={field.maxLength}
        className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
      />
    );
  }

  if (field.type === "checkbox") {
    return (
      <label className="mt-1 inline-flex items-center gap-2 text-sm">
        <Checkbox
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <span className={cn("text-muted-foreground", checkedTextClass(Boolean(value)))}>
          {Boolean(value) ? "true" : "false"}
        </span>
      </label>
    );
  }

  if (field.type === "select" && field.options) {
    const NULL_TOKEN = "__null__";
    const current = stringValue || NULL_TOKEN;
    return (
      <Select
        value={current}
        onValueChange={(v) => onChange(v === NULL_TOKEN ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NULL_TOKEN}>— (null)</SelectItem>
          {field.options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (field.type === "date") {
    const dateValue =
      typeof stringValue === "string" && stringValue.includes("T")
        ? stringValue.slice(0, 10)
        : stringValue;
    return (
      <Input
        type="date"
        value={dateValue}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    );
  }

  return (
    <Input
      type={field.type === "number" ? "number" : "text"}
      value={stringValue}
      onChange={(e) => {
        const next =
          typeof field.maxLength === "number" && field.type !== "number"
            ? e.target.value.slice(0, field.maxLength)
            : e.target.value;
        onChange(next);
      }}
      placeholder={field.placeholder}
      disabled={disabled}
      min={field.type === "number" ? field.min : undefined}
      max={field.type === "number" ? field.max : undefined}
      step={field.type === "number" ? field.step : undefined}
      maxLength={field.type === "number" ? undefined : field.maxLength}
    />
  );
}

export function PreviewBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/40 py-2 last:border-b-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="mt-0.5 break-words">{children}</div>
    </div>
  );
}

export function DebugSection({
  title,
  data,
}: {
  title: string;
  data: unknown;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 font-medium text-foreground">{title}</div>
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-[10px] leading-tight">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

export function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function formatDepartmentName(name: unknown): string {
  if (name === null || name === undefined || name === "") return "—";
  const str = String(name).trim();
  if (str === "") return "—";
  if (str.endsWith("학과")) return str.slice(0, -2);
  return str;
}
