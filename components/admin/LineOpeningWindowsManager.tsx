"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Power, Trash2, CalendarClock } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// /admin/settings/line-opening-windows — "라인 개설 기간(예외)" 관리.
//   화면1: 현재 자동 정책 상태(개설 대상 주차 + 계산 규칙).
//   화면2: 예외 추가(주차 선택 + 전체/특정 라인 + 등록).
//   화면3: 등록된 예외 목록(활성/비활성 토글 · 삭제).
// 판정: 라인 개설 가능 = 자동 정책 허용 OR 활성 예외 존재. (실제 강제는 info-lines POST 게이트)

type AutoWeek = {
  label: string;
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isOpenTarget: boolean;
  isCurrent: boolean;
  canOpen: boolean;
};

type WeekFormOption = {
  id: string;
  label: string;
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  isOpenTarget: boolean;
  canOpen: boolean;
};

type ActivityType = { id: string; name: string };

type ExceptionWindow = {
  id: string;
  weekId: string;
  activityTypeId: string | null;
  allowOpening: boolean;
  isActive: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  weekLabel: string | null;
  weekStart: string | null;
  weekEnd: string | null;
  activityTypeName: string | null;
};

type Banner = { kind: "success" | "error"; message: string } | null;

function fmtDot(iso: string | null): string {
  if (!iso) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1].slice(2)}.${m[2]}.${m[3]}`;
}

export default function LineOpeningWindowsManager() {
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner>(null);

  // 화면1 — 자동 정책
  const [autoWeek, setAutoWeek] = useState<AutoWeek | null>(null);

  // 화면2 — 예외 추가 폼
  const [weekOptions, setWeekOptions] = useState<WeekFormOption[]>([]);
  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);
  const [formWeekId, setFormWeekId] = useState("");
  const [formScope, setFormScope] = useState<"all" | "lines">("all");
  const [formLineIds, setFormLineIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // 화면3 — 예외 목록
  const [windows, setWindows] = useState<ExceptionWindow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchWindows = useCallback(async () => {
    const res = await fetch("/api/admin/line-opening-windows");
    const json = await res.json();
    if (json.success) setWindows(json.data.windows ?? []);
    else setBanner({ kind: "error", message: json.error ?? "예외 목록 조회 실패" });
  }, []);

  const fetchMeta = useCallback(async () => {
    const [autoRes, weeksRes, typesRes] = await Promise.all([
      fetch("/api/admin/cluster4/weeks-options?limit=3"),
      fetch("/api/admin/line-opening-windows/weeks"),
      fetch("/api/admin/cluster4/activity-types?cluster=practical_info"),
    ]);

    const autoJson = await autoRes.json();
    if (autoJson.success) {
      const opts = (autoJson.data.weeks ?? []) as Array<
        AutoWeek & { weekId?: string }
      >;
      setAutoWeek(opts.find((o) => o.isOpenTarget) ?? null);
    }

    const weeksJson = await weeksRes.json();
    if (weeksJson.success) {
      const opts = (weeksJson.data.weeks ?? []) as WeekFormOption[];
      setWeekOptions(opts);
      // 기본 선택 = 자동 개설 대상 주차(있으면), 없으면 현재 주차.
      const def =
        opts.find((o) => o.isOpenTarget) ?? opts.find((o) => o.isCurrent) ?? opts[0];
      if (def) setFormWeekId((prev) => prev || def.id);
    }

    const typesJson = await typesRes.json();
    if (typesJson.success) {
      setActivityTypes(
        (typesJson.data ?? []).map((t: { id: string; name: string }) => ({
          id: t.id,
          name: t.name,
        })),
      );
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await Promise.all([fetchMeta(), fetchWindows()]);
      } catch {
        setBanner({ kind: "error", message: "데이터를 불러오지 못했습니다" });
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchMeta, fetchWindows]);

  const toggleLine = useCallback((id: string) => {
    setFormLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    if (!formWeekId) {
      setBanner({ kind: "error", message: "주차를 선택해주세요" });
      return;
    }
    if (formScope === "lines" && formLineIds.size === 0) {
      setBanner({ kind: "error", message: "특정 라인 허용 시 최소 1개 선택해주세요" });
      return;
    }
    setSubmitting(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/line-opening-windows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_id: formWeekId,
          scope: formScope,
          activity_type_ids:
            formScope === "lines" ? Array.from(formLineIds) : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setBanner({ kind: "error", message: json.error ?? "예외 등록에 실패했습니다" });
        return;
      }
      setBanner({ kind: "success", message: "예외가 등록되었습니다" });
      setFormScope("all");
      setFormLineIds(new Set());
      await fetchWindows();
    } catch {
      setBanner({ kind: "error", message: "예외 등록 중 오류가 발생했습니다" });
    } finally {
      setSubmitting(false);
    }
  }, [formWeekId, formScope, formLineIds, fetchWindows]);

  const handleToggle = useCallback(
    async (w: ExceptionWindow) => {
      setBusyId(w.id);
      setBanner(null);
      try {
        const res = await fetch(`/api/admin/line-opening-windows/${w.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_active: !w.isActive }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          setBanner({ kind: "error", message: json.error ?? "상태 변경 실패" });
          return;
        }
        await fetchWindows();
      } catch {
        setBanner({ kind: "error", message: "상태 변경 중 오류가 발생했습니다" });
      } finally {
        setBusyId(null);
      }
    },
    [fetchWindows],
  );

  const handleDelete = useCallback(
    async (w: ExceptionWindow) => {
      if (
        !window.confirm(
          `이 예외를 삭제하시겠습니까?\n(${w.weekLabel ?? "주차"} · ${w.activityTypeName ?? "전체 라인"})\n삭제 즉시 자동 정책 외 개설이 차단됩니다.`,
        )
      ) {
        return;
      }
      setBusyId(w.id);
      setBanner(null);
      try {
        const res = await fetch(`/api/admin/line-opening-windows/${w.id}`, {
          method: "DELETE",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          setBanner({ kind: "error", message: json.error ?? "삭제 실패" });
          return;
        }
        setBanner({ kind: "success", message: "예외가 삭제되었습니다" });
        await fetchWindows();
      } catch {
        setBanner({ kind: "error", message: "삭제 중 오류가 발생했습니다" });
      } finally {
        setBusyId(null);
      }
    },
    [fetchWindows],
  );

  const sortedWindows = useMemo(
    () =>
      [...windows].sort((a, b) => {
        // 활성 먼저, 그 다음 주차 시작일 내림차순.
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return (b.weekStart ?? "").localeCompare(a.weekStart ?? "");
      }),
    [windows],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-6 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold">라인 개설 기간 (예외 설정)</h1>
        <p className="text-sm text-muted-foreground">
          자동 정책으로 정해진 개설 가능 주차 외에, 특정 주차/라인을 추가로 열어야 할 때
          예외를 등록합니다. (지난 주차 뒤늦은 개설 · 재개설 · 운영/장애 복구 등)
        </p>
      </div>

      {banner && (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-green-300 bg-green-50 text-green-800"
              : "border-red-300 bg-red-50 text-red-800",
          )}
        >
          {banner.message}
        </div>
      )}

      {/* ── 화면1: 현재 자동 정책 상태 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" /> 현재 자동 정책 상태
          </CardTitle>
          <CardDescription>
            아래 주차는 예외 없이도 항상 개설 가능합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {autoWeek ? (
            <div className="rounded-md border border-input bg-muted/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">현재 자동 개설 대상</p>
              <p className="text-lg font-bold text-foreground">
                {autoWeek.year}년 {autoWeek.seasonName} {autoWeek.weekNumber}주차
              </p>
              <p className="text-sm text-muted-foreground">
                {fmtDot(autoWeek.startDate)} ~ {fmtDot(autoWeek.endDate)}
                {!autoWeek.canOpen && (
                  <span className="ml-2 text-orange-600">(공식 휴식 주차)</span>
                )}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              자동 개설 대상 주차를 계산할 수 없습니다.
            </p>
          )}

          <div className="rounded-md border border-dashed px-4 py-3 text-sm">
            <p className="mb-1 font-semibold text-foreground">계산 규칙 (금요일 경계)</p>
            <ul className="space-y-0.5 text-muted-foreground">
              <li>· 월 · 화 · 수 · 목 → 지난 주차 (N-1)</li>
              <li>· 금 · 토 · 일 → 이번 주차 (N)</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* ── 화면2: 예외 추가 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="h-4 w-4" /> 예외 추가
          </CardTitle>
          <CardDescription>
            선택한 주차를 (전체 라인 또는 특정 라인만) 추가 개설 가능 상태로 엽니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 주차 선택 */}
          <div className="space-y-1">
            <Label htmlFor="exc-week" className="text-sm font-semibold">
              주차 선택
            </Label>
            <select
              id="exc-week"
              className="w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={formWeekId}
              onChange={(e) => setFormWeekId(e.target.value)}
            >
              <option value="">주차를 선택해주세요</option>
              {weekOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label} ({fmtDot(w.startDate)} ~ {fmtDot(w.endDate)})
                  {w.isOpenTarget ? " · 자동 정책" : ""}
                  {w.isCurrent && !w.isOpenTarget ? " · 현재" : ""}
                  {!w.canOpen ? " · 휴식" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* 허용 범위 */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">허용 범위</Label>
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="exc-scope"
                  checked={formScope === "all"}
                  onChange={() => setFormScope("all")}
                />
                해당 주차 전체
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="exc-scope"
                  checked={formScope === "lines"}
                  onChange={() => setFormScope("lines")}
                />
                특정 라인만
              </label>
            </div>
          </div>

          {/* 특정 라인 선택 */}
          {formScope === "lines" && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                실무 정보 라인 목록 (개설 허용할 라인 선택)
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {activityTypes.map((t) => (
                  <label
                    key={t.id}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={formLineIds.has(t.id)}
                      onChange={() => toggleLine(t.id)}
                    />
                    {t.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <Button type="button" onClick={handleCreate} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            예외 등록
          </Button>
        </CardContent>
      </Card>

      {/* ── 화면3: 등록된 예외 목록 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">등록된 예외 목록</CardTitle>
          <CardDescription>
            총 {windows.length}건 · 활성 {windows.filter((w) => w.isActive).length}건
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sortedWindows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              등록된 예외가 없습니다.
            </p>
          ) : (
            sortedWindows.map((w) => (
              <div
                key={w.id}
                className={cn(
                  "flex flex-wrap items-start justify-between gap-3 rounded-md border px-4 py-3",
                  w.isActive ? "border-input" : "border-dashed bg-muted/30",
                )}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-foreground">
                      {w.weekLabel ?? "(주차 정보 없음)"}
                    </p>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                        w.isActive
                          ? "border-green-300 bg-green-50 text-green-700"
                          : "border-gray-300 bg-gray-100 text-gray-500",
                      )}
                    >
                      {w.isActive ? "활성" : "비활성"}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    허용:{" "}
                    <span className="font-medium text-foreground">
                      {w.activityTypeName ?? "전체 라인"}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    등록자: {w.createdByName ?? "-"} · 등록일: {fmtDot(w.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggle(w)}
                    disabled={busyId === w.id}
                  >
                    {busyId === w.id ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Power className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {w.isActive ? "비활성화" : "활성화"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(w)}
                    disabled={busyId === w.id}
                    className="text-red-600 hover:text-red-700"
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    삭제
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
