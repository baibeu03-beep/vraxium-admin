"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Power, Trash2, CalendarClock } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { organizationSelectOptions } from "@/lib/organizations";
import { LoadingState } from "@/components/ui/loading-state";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { apiErrorFrom } from "@/lib/apiError";
import { useActionToast } from "@/lib/actionToast";
import { formatClubDate } from "@/lib/clubDate";

// /admin/settings/process-check-windows — "프로세스 체크 예외 주차" 관리.
//   화면1: 기본 주차 정책 안내(현재 시즌 W1~현재주차 · 현재 주차만 편집).
//   화면2: 예외 추가(주차 + 조직 + 허브 선택 → 등록).
//   화면3: 등록된 예외 목록(활성/비활성 토글 · 삭제).
// 판정: 프로세스 체크 주차 선택/편집 = 기본 정책 OR 활성 예외. 예외는 추가 허용(operating 기준).
//   실제 노출/저장 강제는 프로세스 체크 보드(GET/POST) 게이트에서 수행.

// null(전체) 을 나타내는 select 센티널 — 빈 문자열/undefined 회피(명시적 "all").
const ALL = "all";

// value(=저장/조회 slug)는 불변, label 만 조직 표시 SoT(organizationSelectOptions).
const ORG_OPTIONS = [
  { value: ALL, label: "전체 클럽" },
  ...organizationSelectOptions(),
];

const HUB_OPTIONS = [
  { value: ALL, label: "전체 허브" },
  { value: "club", label: "클럽 총괄 급" },
  { value: "info", label: "실무 정보 급" },
  { value: "experience", label: "실무 경험 급" },
  { value: "competency", label: "실무 역량 급" },
  { value: "career", label: "실무 경력 급" },
  { value: "irregular", label: "변동 액트" },
];

function hubLabel(hub: string | null): string {
  if (hub === null) return "전체 허브";
  return HUB_OPTIONS.find((o) => o.value === hub)?.label ?? hub;
}
function orgLabel(org: string | null): string {
  if (org === null) return "전체 클럽";
  return ORG_OPTIONS.find((o) => o.value === org)?.label ?? org;
}

type WeekFormOption = {
  id: string;
  label: string;
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  isOfficialRest: boolean;
};

type ExceptionWindow = {
  id: string;
  weekId: string;
  organizationSlug: string | null;
  hub: string | null;
  allowSelection: boolean;
  isActive: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  weekLabel: string | null;
  weekStart: string | null;
  weekEnd: string | null;
};

type Banner = { kind: "success" | "error"; message: string } | null;

function fmtDot(iso: string | null): string {
  if (!iso) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1].slice(2)}.${m[2]}.${m[3]}`;
}

export default function ProcessCheckWindowsManager() {
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [banner, setBanner] = useState<Banner>(null);
  const confirm = useConfirm();
  const t = useActionToast();

  // 화면2 — 예외 추가 폼
  const [weekOptions, setWeekOptions] = useState<WeekFormOption[]>([]);
  const [formWeekId, setFormWeekId] = useState("");
  const [formOrg, setFormOrg] = useState<string>(ALL);
  const [formHub, setFormHub] = useState<string>(ALL);
  const [submitting, setSubmitting] = useState(false);

  // 화면3 — 예외 목록
  const [windows, setWindows] = useState<ExceptionWindow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchWindows = useCallback(async () => {
    const res = await fetch("/api/admin/process-check-windows");
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.success) setWindows(json.data.windows ?? []);
    else {
      const err = apiErrorFrom(res, json, "예외 목록을 불러오지 못했습니다");
      console.error("[process-check-windows] list failed", err);
      setBanner({ kind: "error", message: err.userMessage });
    }
  }, []);

  const fetchWeeks = useCallback(async () => {
    const res = await fetch("/api/admin/process-check-windows/weeks");
    const json = await res.json();
    if (json.success) {
      const opts = (json.data.weeks ?? []) as WeekFormOption[];
      setWeekOptions(opts);
      // 기본 선택 = 현재 주차(있으면), 없으면 첫 옵션.
      const def = opts.find((o) => o.isCurrent) ?? opts[0];
      if (def) setFormWeekId((prev) => prev || def.id);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await Promise.all([fetchWeeks(), fetchWindows()]);
      } catch {
        setBanner({ kind: "error", message: "데이터를 불러오지 못했습니다" });
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchWeeks, fetchWindows]);

  const handleCreate = useCallback(async () => {
    if (!formWeekId) {
      setBanner({ kind: "error", message: "주차를 선택해주세요" });
      return;
    }
    setSubmitting(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/process-check-windows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_id: formWeekId,
          organization_slug: formOrg, // "all" = 전체 클럽(서버가 null 로 변환)
          hub: formHub, // "all" = 전체 허브
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "예외 등록에 실패했습니다.");
      }
      t.success("create", "예외가 등록되었습니다.");
      await fetchWindows();
    } catch (err) {
      console.error("[process-check-windows] create failed", err);
      t.apiError("create", err, "예외 등록에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }, [formWeekId, formOrg, formHub, fetchWindows]);

  const handleToggle = useCallback(
    async (w: ExceptionWindow) => {
      setBusyId(w.id);
      try {
        const res = await fetch(`/api/admin/process-check-windows/${w.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_active: !w.isActive }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw apiErrorFrom(res, json, "예외 상태 변경에 실패했습니다.");
        }
        await fetchWindows();
      } catch (err) {
        console.error("[process-check-windows] toggle failed", err);
        t.apiError("update", err, "예외 상태 변경에 실패했습니다.");
      } finally {
        setBusyId(null);
      }
    },
    [fetchWindows],
  );

  const handleDelete = useCallback(
    async (w: ExceptionWindow) => {
      if (
        !(await confirm({
          ...CONFIRM.delete,
          description: `이 예외를 삭제하시겠습니까?\n(${w.weekLabel ?? "주차"} · ${orgLabel(w.organizationSlug)} · ${hubLabel(w.hub)})\n삭제 즉시 이 주차는 기본 정책만 따릅니다(드롭다운에서 제외).`,
        }))
      ) {
        return;
      }
      setBusyId(w.id);
      try {
        const res = await fetch(`/api/admin/process-check-windows/${w.id}`, {
          method: "DELETE",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw apiErrorFrom(res, json, "예외 삭제에 실패했습니다.");
        }
        t.success("delete", "예외가 삭제되었습니다.");
        await fetchWindows();
      } catch (err) {
        console.error("[process-check-windows] delete failed", err);
        t.apiError("delete", err, "예외 삭제에 실패했습니다.");
      } finally {
        setBusyId(null);
      }
    },
    [fetchWindows, confirm],
  );

  // 화면1 표시용 — 현재 기본 선택 주차(operating 현재 주차). line-opening 의 "자동 개설 대상"에 대응.
  const currentWeek = useMemo(
    () => weekOptions.find((o) => o.isCurrent) ?? null,
    [weekOptions],
  );

  const sortedWindows = useMemo(
    () =>
      [...windows].sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return (b.weekStart ?? "").localeCompare(a.weekStart ?? "");
      }),
    [windows],
  );

  if (loading) {
    return <LoadingState active />;
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">프로세스 체크 예외 주차</h1>
        <AdminHelp />
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

      {/* ── 화면1: 현재 기본 정책 상태 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" /> 현재 기본 정책 상태
            <AdminHelpIconButton
              helpKey="admin.settings.processCheckWindows.section.basePolicy"
              title="현재 기본 정책 상태"
              size="sm"
            />
          </CardTitle>
          <CardDescription>
            아래 주차는 예외 없이도 항상 선택·편집 가능합니다. 예외는 이 정책을{" "}
            <span className="font-semibold">대체하지 않고 추가로 허용</span>합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {currentWeek ? (
            <div className="rounded-md border border-input bg-muted/30 px-4 py-3">
              <div className="inline-flex items-center gap-1">
                <span className="text-xs text-muted-foreground">
                  현재 기본 선택(편집 가능) 주차
                </span>
                <AdminHelpIconButton
                  helpKey="admin.settings.processCheckWindows.label.currentWeek"
                  title="현재 기본 선택(편집 가능) 주차"
                  size="xs"
                />
              </div>
              <p className="text-lg font-bold text-foreground">
                {currentWeek.year}년 {currentWeek.seasonName} {currentWeek.weekNumber}주차
              </p>
              <p className="text-sm text-muted-foreground">
                {formatClubDate(currentWeek.startDate)} ~ {formatClubDate(currentWeek.endDate)}
                {currentWeek.isOfficialRest && (
                  <span className="ml-2 text-orange-600">(공식 휴식 주차)</span>
                )}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">현재 주차를 계산할 수 없습니다.</p>
          )}

          <div className="rounded-md border border-dashed px-4 py-3 text-sm">
            <div className="mb-1 inline-flex items-center gap-1">
              <span className="font-semibold text-foreground">기본 정책</span>
              <AdminHelpIconButton
                helpKey="admin.settings.processCheckWindows.label.basePolicy"
                title="기본 정책"
                size="xs"
              />
            </div>
            <ul className="space-y-0.5 text-muted-foreground">
              <li>· 드롭다운 기본 노출 = 현재 시즌 1주차 ~ 현재 주차 (미래 주차 미노출)</li>
              <li>· 편집 가능 = 현재 주차만 (과거 주차 = 조회 전용)</li>
              <li>· 예외 허용 주차는 위 범위 밖이어도 드롭다운에 추가되고 편집 가능해집니다.</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* ── 화면2: 예외 추가 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="h-4 w-4" /> 예외 추가
            <AdminHelpIconButton
              helpKey="admin.settings.processCheckWindows.section.addException"
              title="예외 추가"
              size="sm"
            />
          </CardTitle>
          <CardDescription>
            선택한 주차를 (선택한 클럽·허브 범위에서) 프로세스 체크 드롭다운에서 추가로 선택·편집 가능하게 엽니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 주차 선택 */}
          <div className="space-y-1">
            <Label
              htmlFor="pcw-week"
              className="inline-flex items-center gap-1 text-sm font-semibold"
            >
              주차 선택
              <AdminHelpIconButton
                helpKey="admin.settings.processCheckWindows.input.week"
                title="주차 선택"
                size="xs"
              />
            </Label>
            <select
              id="pcw-week"
              className="w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={formWeekId}
              onChange={(e) => setFormWeekId(e.target.value)}
            >
              <option value="">주차를 선택해주세요</option>
              {weekOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label} ({formatClubDate(w.startDate)} ~ {formatClubDate(w.endDate)})
                  {w.isCurrent ? " · 현재" : ""}
                  {w.isOfficialRest ? " · 휴식" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* 조직 / 허브 범위 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label
                htmlFor="pcw-org"
                className="inline-flex items-center gap-1 text-sm font-semibold"
              >
                클럽 범위
                <AdminHelpIconButton
                  helpKey="admin.settings.processCheckWindows.input.org"
                  title="클럽 범위"
                  size="xs"
                />
              </Label>
              <select
                id="pcw-org"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={formOrg}
                onChange={(e) => setFormOrg(e.target.value)}
              >
                {ORG_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label
                htmlFor="pcw-hub"
                className="inline-flex items-center gap-1 text-sm font-semibold"
              >
                프로세스 허브 범위
                <AdminHelpIconButton
                  helpKey="admin.settings.processCheckWindows.input.hub"
                  title="프로세스 허브 범위"
                  size="xs"
                />
              </Label>
              <select
                id="pcw-hub"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={formHub}
                onChange={(e) => setFormHub(e.target.value)}
              >
                {HUB_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <Button type="button" loading={submitting} onClick={handleCreate}>
            예외 등록
          </Button>
        </CardContent>
      </Card>

      {/* ── 화면3: 등록된 예외 목록 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            등록된 예외 목록
            <AdminHelpIconButton
              helpKey="admin.settings.processCheckWindows.section.exceptionList"
              title="등록된 예외 목록"
              size="sm"
            />
            <AdminHelpIconButton
              helpKey="admin.settings.processCheckWindows.badge.status"
              title="활성 상태"
              size="sm"
            />
          </CardTitle>
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
                          : "border-input bg-muted text-muted-foreground",
                      )}
                    >
                      {w.isActive ? "활성" : "비활성"}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    범위:{" "}
                    <span className="font-medium text-foreground">{orgLabel(w.organizationSlug)}</span>
                    {" · "}
                    <span className="font-medium text-foreground">{hubLabel(w.hub)}</span>
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
                    loading={busyId === w.id}
                    onClick={() => handleToggle(w)}
                  >
                    <Power className="mr-1.5 h-3.5 w-3.5" />
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
