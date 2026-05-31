"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarPlus, Pencil, Power, RefreshCw, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  OFFICIAL_REST_PERIOD_TYPE_LABELS,
  OFFICIAL_REST_PERIOD_TYPES,
  type OfficialRestPeriodDto,
  type OfficialRestPeriodType,
} from "@/lib/officialRestPeriodsTypes";

type Draft = {
  name: string;
  type: OfficialRestPeriodType;
  startDate: string;
  endDate: string;
  description: string;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  type: "temporary",
  startDate: "",
  endDate: "",
  description: "",
};

const API_BASE = "/api/admin/official-rest-periods";

function draftToBody(draft: Draft) {
  return {
    name: draft.name.trim(),
    type: draft.type,
    start_date: draft.startDate,
    end_date: draft.endDate,
    description: draft.description.trim() || null,
  };
}

function OfficialRestPolicyInfo() {
  return (
    <Card className="border-primary/15 bg-primary/5">
      <CardHeader>
        <CardTitle>공식 휴식 운영 정책</CardTitle>
        <CardDescription>
          시험기간 휴식과 날짜 기반 공식 휴식의 관리 기준입니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 text-sm text-foreground/85">
          <ul className="list-disc space-y-1 pl-5">
            <li>시험기간 휴식은 별도 등록하지 않습니다.</li>
            <li>시험기간 휴식은 시스템 정책으로 자동 계산됩니다.</li>
          </ul>
          <div>
            <div className="font-medium text-foreground">적용 규칙</div>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>봄 시즌 6~8주차</li>
              <li>봄 시즌 14~16주차</li>
              <li>가을 시즌 6~8주차</li>
              <li>가을 시즌 14~16주차</li>
            </ul>
          </div>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              위 기간은 seasonCalendar 정책에 의해 자동으로 공식 휴식
              처리됩니다.
            </li>
            <li>
              이 화면에서 등록한 설/추석/임시 휴식은 날짜 범위가 겹치는 주차에
              별도 SQL 없이 즉시 공식 휴식으로 반영됩니다.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 text-xs font-medium",
        active
          ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200"
          : "bg-muted text-muted-foreground",
      )}
    >
      {active ? "활성" : "비활성"}
    </span>
  );
}

export default function OfficialRestPeriodsManager() {
  const [periods, setPeriods] = useState<OfficialRestPeriodDto[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}?includeInactive=1`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load official rest periods.");
        }
        if (!cancelled) {
          setPeriods((json.data?.rows ?? []) as OfficialRestPeriodDto[]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load.");
          setPeriods([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const activeCount = useMemo(
    () => periods.filter((period) => period.isActive).length,
    [periods],
  );

  const editing = editingId
    ? periods.find((period) => period.id === editingId) ?? null
    : null;

  const canSubmit =
    !saving &&
    draft.name.trim().length > 0 &&
    draft.startDate.trim().length > 0 &&
    draft.endDate.trim().length > 0 &&
    draft.startDate <= draft.endDate;

  function resetForm() {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  }

  function startEdit(period: OfficialRestPeriodDto) {
    setEditingId(period.id);
    setDraft({
      name: period.name,
      type: period.type,
      startDate: period.startDate,
      endDate: period.endDate,
      description: period.description ?? "",
    });
  }

  async function saveDraft() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const url = editing ? `${API_BASE}/${editing.id}` : API_BASE;
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToBody(draft)),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "저장에 실패했습니다.");
      }
      resetForm();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(period: OfficialRestPeriodDto) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/${period.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !period.isActive }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "상태 변경에 실패했습니다.");
      }
      if (editingId === period.id) resetForm();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "상태 변경에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function removePeriod(period: OfficialRestPeriodDto) {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`"${period.name}" 기간을 삭제하시겠습니까?`)
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/${period.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "삭제에 실패했습니다.");
      }
      if (editingId === period.id) resetForm();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-foreground">
            공식 휴식 관리
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            명절 및 임시 공식 휴식 기간을 관리합니다.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      <OfficialRestPolicyInfo />

      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardDescription>전체 기간</CardDescription>
            <CardTitle>{loading ? "-" : `${periods.length}개`}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>활성 기간</CardDescription>
            <CardTitle>{loading ? "-" : `${activeCount}개`}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>데이터 소스</CardDescription>
            <CardTitle>official_rest_periods</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{editing ? "공식 휴식 수정" : "공식 휴식 추가"}</CardTitle>
          <CardDescription>
            등록/수정한 날짜 범위는 겹치는 주차에 공식 휴식으로 즉시 반영됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_1.5fr_auto]">
            <div className="grid gap-1.5">
              <Label htmlFor="rest-name">이름</Label>
              <Input
                id="rest-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="2026 설 연휴"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-type">유형</Label>
              <select
                id="rest-type"
                value={draft.type}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    type: event.target.value as OfficialRestPeriodType,
                  }))
                }
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {OFFICIAL_REST_PERIOD_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {OFFICIAL_REST_PERIOD_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-start">시작일</Label>
              <Input
                id="rest-start"
                type="date"
                value={draft.startDate}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    startDate: event.target.value,
                  }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-end">종료일</Label>
              <Input
                id="rest-end"
                type="date"
                value={draft.endDate}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    endDate: event.target.value,
                  }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-description">설명</Label>
              <Input
                id="rest-description"
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="운영 기준 메모"
              />
            </div>
            <div className="flex items-end gap-2">
              <Button type="button" onClick={saveDraft} disabled={!canSubmit}>
                <CalendarPlus className="h-4 w-4" />
                {editing ? "수정" : "추가"}
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={resetForm}
                  disabled={saving}
                >
                  취소
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>공식 휴식 기간</CardTitle>
          <CardDescription>날짜 범위 기반 공식 휴식 목록입니다.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              데이터를 불러오는 중입니다.
            </div>
          ) : periods.length === 0 ? (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              등록된 공식 휴식 기간이 없습니다.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>이름</TableHead>
                    <TableHead>유형</TableHead>
                    <TableHead>시작일</TableHead>
                    <TableHead>종료일</TableHead>
                    <TableHead>설명</TableHead>
                    <TableHead>활성 여부</TableHead>
                    <TableHead className="text-right">작업</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {periods.map((period) => (
                    <TableRow
                      key={period.id}
                      className={cn(!period.isActive && "opacity-60")}
                    >
                      <TableCell className="font-medium">{period.name}</TableCell>
                      <TableCell>
                        {OFFICIAL_REST_PERIOD_TYPE_LABELS[period.type]}
                      </TableCell>
                      <TableCell>{period.startDate}</TableCell>
                      <TableCell>{period.endDate}</TableCell>
                      <TableCell className="max-w-[320px] truncate">
                        {period.description || "-"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge active={period.isActive} />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => startEdit(period)}
                            disabled={saving}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            수정
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => toggleActive(period)}
                            disabled={saving}
                          >
                            <Power className="h-3.5 w-3.5" />
                            {period.isActive ? "비활성화" : "활성화"}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => removePeriod(period)}
                            disabled={saving}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            삭제
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
