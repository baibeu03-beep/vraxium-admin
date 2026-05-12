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
import { cn } from "@/lib/utils";

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
  return (
    <div className={cn("flex flex-col gap-1.5", field.full && "sm:col-span-2")}>
      <Label className="text-xs">{field.label}</Label>
      <FieldInput
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
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
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={3}
        placeholder={field.placeholder}
        className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
      />
    );
  }

  if (field.type === "checkbox") {
    return (
      <label className="mt-1 inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <span className="text-muted-foreground">
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
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder}
      disabled={disabled}
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
