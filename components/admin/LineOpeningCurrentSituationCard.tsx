"use client";

import type { ReactNode } from "react";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";

export type CurrentSituationItem = {
  label: string;
  helpKey: string;
  value: ReactNode;
};

export function CurrentSituationWeekValue({
  label,
  range,
}: {
  label: ReactNode;
  range: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 break-keep sm:flex-nowrap sm:whitespace-nowrap">
      <span>{label}</span>
      <span className="font-normal text-muted-foreground">({range})</span>
    </span>
  );
}

export default function LineOpeningCurrentSituationCard({
  items,
  loading = false,
  error = null,
  footer,
}: {
  items: CurrentSituationItem[];
  loading?: boolean;
  error?: string | null;
  footer?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="inline-flex items-center gap-1.5 text-lg">
          현재 상황
          <AdminHelpIconButton
            size="sm"
            helpKey="admin.lineOpening.currentSituation.title.card"
            title="현재 상황"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="text-base">
        {error ? (
          <p className="text-red-600">{error}</p>
        ) : loading ? (
          <LoadingState active />
        ) : (
          <div className="grid min-w-0 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-3">
            {items.map((item) => (
              <div key={item.label} className="grid min-w-0 gap-1 sm:contents">
                <span className="inline-flex items-center gap-1 text-muted-foreground sm:self-start">
                  {item.label}
                  <AdminHelpIconButton
                    size="xs"
                    helpKey={item.helpKey}
                    title={item.label}
                  />
                </span>
                <span className="min-w-0 font-semibold">{item.value}</span>
              </div>
            ))}
          </div>
        )}
        {footer}
      </CardContent>
    </Card>
  );
}
