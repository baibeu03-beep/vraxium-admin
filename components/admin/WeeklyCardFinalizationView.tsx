"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { CheckCircle2, Loader2, RefreshCw, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";
import { ORGANIZATIONS, ORGANIZATION_LABEL } from "@/lib/organizations";
import type {
  FinalizationAggregation,
  FinalizationSeasonOption,
  FinalizationWeekOption,
  FinalizationWeekStatus,
  WeeklyCardFinalizationPreview,
  WeeklyCardFinalizationResult,
} from "@/lib/adminWeeklyCardFinalizationTypes";
import { formatClubDate, formatClubDateTime } from "@/lib/clubDate";

const ALL = "__all__";

type Banner = { kind: "success" | "error" | "info"; message: string } | null;

function formatDateTime(value: string | null | undefined) {
  return formatClubDateTime(value, "—");
}

// 집계 표의 행 정의 — 라벨/키/색조.
const AGG_ROWS: Array<{
  key: keyof FinalizationAggregation;
  label: string;
  tone?: "total" | "challenge" | "success" | "fail" | "rest" | "official" | "pending";
}> = [
  { key: "totalCrew", label: "전체 크루", tone: "total" },
  { key: "growthChallenge", label: "성장 도전", tone: "challenge" },
  { key: "growthSuccess", label: "성장 성공", tone: "success" },
  { key: "growthFail", label: "성장 실패", tone: "fail" },
  { key: "personalRest", label: "개인 휴식", tone: "rest" },
  { key: "officialRest", label: "공식 휴식", tone: "official" },
  { key: "pendingTally", label: "미확정 인원 (아직 집계 중)", tone: "pending" },
];

function toneClass(tone?: string) {
  switch (tone) {
    case "success":
      return "text-emerald-600";
    case "fail":
      return "text-red-600";
    case "rest":
      return "text-sky-600";
    case "official":
      return "text-amber-600";
    case "pending":
      return "text-orange-600";
    case "challenge":
      return "text-indigo-600";
    default:
      return "text-foreground";
  }
}

// 주차 상태 배지(집계 중 / 확정 완료 / snapshot stale).
function StatusBadges({ target }: { target: FinalizationWeekStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
          target.isFinalized
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-amber-200 bg-amber-50 text-amber-700",
        )}
        title={
          target.isFinalized
            ? `확정 완료 · ${formatDateTime(target.resultPublishedAt)}`
            : "집계 중 — 결과 확정 전"
        }
      >
        {target.isFinalized ? "확정 완료" : "집계 중"}
      </span>
      {target.isCurrentWeek && (
        <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          현재 주차(진행 중)
        </span>
      )}
      {target.isOfficialRest && (
        <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800">
          공식 휴식 주차
        </span>
      )}
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
          target.snapshot.isStale
            ? "border-orange-200 bg-orange-50 text-orange-700"
            : "border-emerald-200 bg-emerald-50 text-emerald-700",
        )}
        title={`대상 인원 ${target.snapshot.cohortSize}명 · 최신 ${target.snapshot.fresh} · 갱신 필요 ${target.snapshot.stale} · 미생성 ${target.snapshot.missing}`}
      >
        {target.snapshot.isStale
          ? `갱신 필요 (${target.snapshot.stale + target.snapshot.missing})`
          : "최신 상태"}
      </span>
    </div>
  );
}

export default function WeeklyCardFinalizationView() {
  const [seasons, setSeasons] = useState<FinalizationSeasonOption[]>([]);
  const [weeks, setWeeks] = useState<FinalizationWeekOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);

  const [seasonKey, setSeasonKey] = useState<string>(ALL);
  const [weekNumber, setWeekNumber] = useState<string>(ALL);
  const [org, setOrg] = useState<string>(ALL);

  const [target, setTarget] = useState<FinalizationWeekStatus | null>(null);
  const [aggregation, setAggregation] = useState<FinalizationAggregation | null>(null);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  // 확정 후 자가 검증(데모/일반 동일 DTO 사용하는 실 주차 카드 API 재호출).
  const [demoUserId, setDemoUserId] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    found: boolean;
    userWeekStatus?: string;
    statusLabel?: string;
    stillTallying?: boolean;
  } | null>(null);

  // QA 모드(?mode=test) — 미리보기/확정 모두에 전파해야 백엔드 scope(테스트 코호트·qa_weeks_state)와
  //   정합한다. 미전파 시 테스트 모드 화면에서 확정 버튼이 운영 공표(실사용자 재계산)로 새는 위험.
  const mode = readScopeMode(useSearchParams());

  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), 5000);
    return () => window.clearTimeout(t);
  }, [banner]);

  // 옵션(시즌/주차) 로드.
  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    try {
      const res = await fetch(
        appendModeQuery("/api/admin/weekly-card-finalization/preview", mode),
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "옵션을 불러오지 못했습니다.");
      }
      const data = json.data as WeeklyCardFinalizationPreview;
      setSeasons(data.seasons);
      setWeeks(data.weeks);
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "옵션 로드 실패",
      });
    } finally {
      setOptionsLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  // 선택 시즌의 주차 옵션(weekNumber 보유분).
  const weekOptions = useMemo(() => {
    if (seasonKey === ALL) return [] as FinalizationWeekOption[];
    return weeks
      .filter((w) => w.seasonKey === seasonKey && w.weekNumber != null)
      .sort((a, b) => (a.weekNumber ?? 0) - (b.weekNumber ?? 0));
  }, [weeks, seasonKey]);

  const canQuery = seasonKey !== ALL && weekNumber !== ALL;

  const buildBody = useCallback(
    (mode?: "finalize" | "recompute") => ({
      seasonId: seasonKey,
      weekNumber: Number(weekNumber),
      org: org === ALL ? null : org,
      ...(mode ? { mode } : {}),
    }),
    [seasonKey, weekNumber, org],
  );

  const applyResultPayload = (data: {
    target: FinalizationWeekStatus | null;
    aggregation: FinalizationAggregation | null;
  }) => {
    setTarget(data.target);
    setAggregation(data.aggregation);
  };

  // 1) 집계 미리보기.
  const runPreview = useCallback(async () => {
    if (!canQuery) return;
    setPreviewLoading(true);
    setVerifyResult(null);
    try {
      const params = new URLSearchParams();
      params.set("seasonId", seasonKey);
      params.set("weekNumber", weekNumber);
      if (org !== ALL) params.set("org", org);
      if (mode === "test") params.set("mode", "test");
      const res = await fetch(
        `/api/admin/weekly-card-finalization/preview?${params.toString()}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "미리보기 실패");
      }
      const data = json.data as WeeklyCardFinalizationPreview;
      applyResultPayload(data);
      // 옵션이 비어 있었으면 같이 갱신.
      if (data.weeks.length) setWeeks(data.weeks);
      setBanner({ kind: "info", message: "집계 미리보기를 불러왔습니다." });
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "미리보기 실패",
      });
    } finally {
      setPreviewLoading(false);
    }
  }, [canQuery, seasonKey, weekNumber, org, mode]);

  // 2) snapshot 재계산(확정 플래그 불변).
  const runRecompute = useCallback(async () => {
    if (!canQuery) return;
    setRecomputing(true);
    try {
      const res = await fetch(
        appendModeQuery("/api/admin/weekly-card-finalization/finalize", mode),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildBody("recompute")),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "카드 정보 업데이트 실패");
      }
      const data = json.data as WeeklyCardFinalizationResult;
      applyResultPayload(data);
      setBanner({
        kind: "success",
        message: `카드 정보 업데이트 완료 (요청 ${data.snapshotRecompute.requested} · 성공 ${data.snapshotRecompute.recomputed} · 실패 ${data.snapshotRecompute.failed}).`,
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "카드 정보 업데이트 실패",
      });
    } finally {
      setRecomputing(false);
    }
  }, [canQuery, buildBody, mode]);

  // 3) 집계 확정(공표 + 코호트 재계산).
  const runFinalize = useCallback(async () => {
    if (!canQuery) return;
    setFinalizing(true);
    try {
      const res = await fetch(
        appendModeQuery("/api/admin/weekly-card-finalization/finalize", mode),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildBody("finalize")),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "확정 실패");
      }
      const data = json.data as WeeklyCardFinalizationResult;
      applyResultPayload(data);
      setConfirmOpen(false);
      const already = data.published?.alreadyFinalized;
      setBanner({
        kind: "success",
        message: already
          ? `이미 확정된 주차입니다. 대상 인원의 카드 정보를 업데이트했습니다 (성공 ${data.snapshotRecompute.recomputed}).`
          : `집계 확정 완료. 대상 인원의 카드 정보를 업데이트했습니다 (성공 ${data.snapshotRecompute.recomputed} · 실패 ${data.snapshotRecompute.failed}).`,
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "확정 실패",
      });
    } finally {
      setFinalizing(false);
    }
  }, [canQuery, buildBody, mode]);

  // 확정 후 검증: 실제 주차 카드 API 를 demoUserId 로 재호출해 해당 주차가 더 이상
  // "집계 중"(tallying)이 아님을 확인한다. 데모/일반 동일 DTO(loadWeeklyCards) 경로.
  const runVerify = useCallback(async () => {
    if (!target || !demoUserId.trim()) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch(
        `/api/cluster4/weekly-cards?demoUserId=${encodeURIComponent(demoUserId.trim())}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || json.success === false) {
        throw new Error(json?.error?.message ?? "주차 카드 조회 실패");
      }
      const cards = (json.data ?? []) as Array<{
        weekNumber: number;
        seasonKey: string | null;
        userWeekStatus: string;
        statusLabel: string;
      }>;
      const card = cards.find(
        (c) =>
          c.weekNumber === target.weekNumber && c.seasonKey === target.seasonKey,
      );
      if (!card) {
        setVerifyResult({ found: false });
      } else {
        setVerifyResult({
          found: true,
          userWeekStatus: card.userWeekStatus,
          statusLabel: card.statusLabel,
          stillTallying: card.userWeekStatus === "tallying",
        });
      }
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "검증 실패",
      });
    } finally {
      setVerifying(false);
    }
  }, [target, demoUserId]);

  const seasonLabelByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of seasons) m.set(s.seasonKey, s.seasonLabel);
    return m;
  }, [seasons]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold">주차 카드 집계 확정</h1>
          <p className="text-sm text-muted-foreground">
            특정 시즌/주차의 집계 결과를 확인하고 확정합니다. 확정하면 주차 결과를
            공개하고 대상 인원의 카드 정보를 최신 상태로 업데이트합니다. 사용자별 인정
            상태(성공/실패/휴식)는 변경하지 않습니다.
          </p>
        </div>
        <AdminHelp />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void loadOptions()}
          disabled={optionsLoading}
        >
          <RefreshCw className={cn("mr-2 h-4 w-4", optionsLoading && "animate-spin")} />
          옵션 새로고침
        </Button>
      </div>

      {banner && (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            banner.kind === "success" && "border-emerald-200 bg-emerald-50 text-emerald-700",
            banner.kind === "error" && "border-red-200 bg-red-50 text-red-700",
            banner.kind === "info" && "border-sky-200 bg-sky-50 text-sky-700",
          )}
        >
          {banner.message}
        </div>
      )}

      {/* 선택 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">시즌 · 주차 · 조직 선택</CardTitle>
          <CardDescription>
            조직은 집계 표시 범위이며, 확정/업데이트는 주차 전체 인원에 적용됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">시즌</label>
              <Select
                value={seasonKey}
                onValueChange={(v) => {
                  setSeasonKey(v ?? ALL);
                  setWeekNumber(ALL);
                  setTarget(null);
                  setAggregation(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="시즌 선택">
                    {(v: string | null) =>
                      !v || v === ALL
                        ? "전체"
                        : seasonLabelByKey.get(v)
                          ? `${seasonLabelByKey.get(v)} (${v})`
                          : v}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {seasons.map((s) => (
                    <SelectItem key={s.seasonKey} value={s.seasonKey}>
                      {s.seasonLabel} ({s.seasonKey})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">주차</label>
              <Select
                value={weekNumber}
                onValueChange={(v) => {
                  setWeekNumber(v ?? ALL);
                  setTarget(null);
                  setAggregation(null);
                }}
                disabled={seasonKey === ALL}
              >
                <SelectTrigger>
                  <SelectValue placeholder="주차 선택">
                    {(v: string | null) => {
                      if (!v || v === ALL) return "전체";
                      const w = weekOptions.find((o) => String(o.weekNumber) === v);
                      return w ? w.weekLabel : v;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {weekOptions.map((w) => (
                    <SelectItem key={w.weekId} value={String(w.weekNumber)}>
                      {w.weekLabel}
                      {w.resultPublishedAt ? " · 확정됨" : " · 집계 중"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">조직</label>
              <Select value={org} onValueChange={(v) => setOrg(v ?? ALL)}>
                <SelectTrigger>
                  <SelectValue placeholder="조직">
                    {(v: string | null) =>
                      !v || v === ALL
                        ? "전체"
                        : ORGANIZATION_LABEL[v as keyof typeof ORGANIZATION_LABEL] ?? v}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>전체</SelectItem>
                  {ORGANIZATIONS.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {ORGANIZATION_LABEL[slug]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void runPreview()} disabled={!canQuery || previewLoading}>
              {previewLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              집계 미리보기
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void runRecompute()}
              disabled={!canQuery || recomputing}
            >
              {recomputing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              카드 정보 업데이트
            </Button>
            <Button
              type="button"
              variant="default"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => setConfirmOpen(true)}
              disabled={!canQuery || finalizing || !target}
            >
              집계 확정
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 현재 상태 + 집계 표 */}
      {target && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  {seasonLabelByKey.get(target.seasonKey ?? "") ?? target.seasonKey} ·{" "}
                  {target.weekLabel}
                </CardTitle>
                <CardDescription>
                  {formatClubDate(target.startDate)} ~ {formatClubDate(target.endDate)} · 조직{" "}
                  {org === ALL ? "전체" : ORGANIZATION_LABEL[org as keyof typeof ORGANIZATION_LABEL] ?? org}
                </CardDescription>
              </div>
              <StatusBadges target={target} />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {aggregation && (
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <tbody>
                    {AGG_ROWS.map((row, i) => (
                      <tr
                        key={row.key}
                        className={cn(i % 2 === 1 && "bg-muted/30", "border-b last:border-0")}
                      >
                        <td className="px-4 py-2.5 text-muted-foreground">{row.label}</td>
                        <td
                          className={cn(
"px-4 py-2.5 font-semibold tabular-nums",
                            toneClass(row.tone),
                          )}
                        >
                          {aggregation[row.key].toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {aggregation.uncategorized > 0 && (
                      <tr className="border-t">
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          기타(데이터 없음/진행 중 등)
                        </td>
                        <td className="px-4 py-2 text-xs tabular-nums text-muted-foreground">
                          {aggregation.uncategorized.toLocaleString()}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              집계 기준은 사용자별 주차 인정 상태입니다. 단, PMS 활동 인정 데이터가 있는
              조직·주차는 주간 랭킹과 동일한 PMS 기준(별점 4점 이상 + 확인 별점)으로 산출합니다.
              테스트 계정은 집계 대상에서 제외됩니다. "미확정 인원"은 현재 집계 중으로 표시되는
              인원이며, 확정하면 0이 됩니다.
            </p>
          </CardContent>
        </Card>
      )}

      {/* 확정 후 검증: 실제 주차 카드 API 재호출 */}
      {target && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">확정 반영 검증 (주차 카드 재조회)</CardTitle>
            <CardDescription>
              테스트 유저 ID로 실제 주차 카드를 다시 조회해 해당 주차가 더 이상
              "집계 중"이 아닌지 확인합니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  테스트 유저 ID
                </label>
                <Input
                  value={demoUserId}
                  onChange={(e) => setDemoUserId(e.target.value)}
                  placeholder="00000000-0000-..."
                  className="w-[360px]"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void runVerify()}
                disabled={!demoUserId.trim() || verifying}
              >
                {verifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                주차 카드 재조회
              </Button>
            </div>
            {verifyResult && (
              <div
                className={cn(
                  "rounded-md border px-3 py-2 text-sm",
                  !verifyResult.found
                    ? "border-border bg-muted text-muted-foreground"
                    : verifyResult.stillTallying
                      ? "border-red-200 bg-red-50 text-red-700"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700",
                )}
              >
                {!verifyResult.found ? (
                  `해당 주차(${target.weekLabel}) 카드를 이 유저에게서 찾지 못했습니다 (대상 인원이 아닐 수 있음).`
                ) : verifyResult.stillTallying ? (
                  `아직 "집계 중"입니다. 카드 정보 업데이트가 필요할 수 있습니다.`
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4" />
                    더 이상 "집계 중"이 아닙니다 — {verifyResult.statusLabel}.
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 확정 확인 모달 */}
      {confirmOpen && target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="주차 카드 집계 확정"
            className="w-full max-w-md rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">집계 확정</h2>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={finalizing}
                aria-label="닫기"
                className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mb-4 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
              <div className="font-medium">
                {seasonLabelByKey.get(target.seasonKey ?? "") ?? target.seasonKey} ·{" "}
                {target.weekLabel}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatClubDate(target.startDate)} ~ {formatClubDate(target.endDate)}
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              이 주차를 확정하면 고객 페이지의 해당 주차 카드가 "성장(집계 중)"에서 사용자별
              성공/실패 상태로 전환되고, 대상 인원 전체의 카드 정보가 최신 상태로 업데이트됩니다.
              사용자별 인정 상태 자체는 변경되지 않습니다.
              {target.isFinalized && " (이미 확정된 주차 — 카드 정보 업데이트만 수행됩니다.)"}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmOpen(false)}
                disabled={finalizing}
              >
                취소
              </Button>
              <Button
                type="button"
                className="bg-emerald-600 hover:bg-emerald-700"
                onClick={() => void runFinalize()}
                disabled={finalizing}
              >
                {finalizing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {target.isFinalized ? "카드 정보 업데이트" : "집계 확정"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
