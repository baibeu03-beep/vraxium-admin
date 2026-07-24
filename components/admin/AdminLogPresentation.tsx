import type { ReactNode } from "react";

import {
  ADMIN_LOG_ENTITY_STYLES,
  ADMIN_LOG_TONE_STYLES,
  type AdminLogEntityKind,
  type AdminLogTone,
} from "@/lib/adminLogPresentation";
import { cn } from "@/lib/utils";

export function AdminLogEventLabel({
  tone,
  children,
  brackets = true,
  className,
}: {
  tone: AdminLogTone;
  children: ReactNode;
  brackets?: boolean;
  className?: string;
}) {
  return (
    <span
      data-admin-log-tone={tone}
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border px-1 py-0.5 font-semibold leading-tight",
        ADMIN_LOG_TONE_STYLES[tone],
        className,
      )}
    >
      {brackets ? <>[{children}]</> : children}
    </span>
  );
}

export function AdminLogEntity({
  kind,
  children,
  className,
}: {
  kind: AdminLogEntityKind;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-admin-log-entity={kind}
      className={cn(
        "inline rounded-md px-1.5 py-0.5",
        ADMIN_LOG_ENTITY_STYLES[kind],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function AdminLogTimestamp({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-admin-log-timestamp=""
      className={cn("tabular-nums text-muted-foreground", className)}
    >
      {children}
    </span>
  );
}
