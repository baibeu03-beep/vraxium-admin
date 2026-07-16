"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { adminDialog } from "@/components/ui/admin-dialog";
import { useActionToast } from "@/lib/actionToast";
import { pointColorClass } from "@/components/ui/point-value";
import { getProcessPointLabels } from "@/lib/pointLabels";
import { enhancementStatusTone } from "@/lib/cluster4EnhancementLabels";
import { type ScopeMode } from "@/lib/userScopeShared";
import type { BadgeTone } from "@/components/ui/badge";
import type {
  CrewWeekLineDetailRow,
  CrewWeekLineSummaryDto,
} from "@/lib/adminCrewWeekLineSummary";

// ─────────────────────────────────────────────────────────────────────
// "라인 강화 내역" 탭 — 상단 요약 + 하단 라인 상세 표 + 2차 기입 허용/불가.
//   · 숫자는 전부 크루 카드(/cluster-4-card) 라인 DTO·snapshot SoT 를 표현(재추정 없음).
//   · 2차 기입 허용/불가 = 관리자 수동 override(클럽오픈 && 강화성공 라인만 허용 가능·불가는 언제든).
//     허용 시 크루가 자동 기간 종료 후에도 그 라인 2차 기입을 수정/저장할 수 있다(force-open).
//   · 이 화면은 라인 오픈 여부/강화 결과/평점/포인트/2차 기입 내용을 수정하지 않는다.
// ─────────────────────────────────────────────────────────────────────

const ENHANCEMENT_TONE: Record<"success" | "danger" | "neutral", BadgeTone> = {
  success: "success",
  danger: "danger",
  neutral: "neutral",
};

export default function CrewWeekLineHistory({
  userId,
  weekId,
  mode,
  orgSlug,
}: {
  userId: string;
  weekId: string;
  mode: ScopeMode;
  orgSlug: string | null;
}) {
  const t = useActionToast();
  const [summary, setSummary] = useState<CrewWeekLineSummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyLines, setBusyLines] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const ctxQuery = mode === "test" ? "?mode=test" : "";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/members/${userId}/weeks/${weekId}/lines${ctxQuery}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "라인 강화 내역을 불러오지 못했습니다.");
      }
      setSummary(json.data as CrewWeekLineSummaryDto);
    } catch (err) {
      setError(err instanceof Error ? err.message : "라인 강화 내역을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [userId, weekId, ctxQuery]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const poLabels = getProcessPointLabels(summary?.organizationSlug ?? orgSlug);

  const eligibleCount = useMemo(
    () => summary?.lineDetails.filter((r) => r.eligible).length ?? 0,
    [summary],
  );
  const allowedCount = useMemo(
    () => summary?.lineDetails.filter((r) => r.overrideAllowed).length ?? 0,
    [summary],
  );

  const canManage = summary?.canManageSecondEntry === true;
  const anyBusy = bulkBusy || busyLines.size > 0;

  const setLineBusy = useCallback((lineId: string, busy: boolean) => {
    setBusyLines((prev) => {
      const next = new Set(prev);
      if (busy) next.add(lineId);
      else next.delete(lineId);
      return next;
    });
  }, []);

  // 개별 토글 — 허용↔불가. 불가(회수)는 언제든, 허용은 자격 라인만(비자격은 안내만).
  const toggleLine = useCallback(
    async (row: CrewWeekLineDetailRow) => {
      if (!row.lineId || !canManage || anyBusy) return;
      const nextAllowed = !row.overrideAllowed;

      if (nextAllowed && !row.eligible) {
        // 자격 미충족 — 변경하지 않고 안내만(§10). 미오픈 vs 오픈-비성공 구분.
        await adminDialog.alert({
          variant: "warning",
          title: "2차 기입을 허용할 수 없습니다",
          description: row.clubOpen
            ? "오픈되었지만, 강화 성공한 라인이 아니므로 2차 기입을 허용할 수 없습니다."
            : "오픈된 라인이 아니므로, 2차 기입을 허용할 수 없습니다.",
        });
        return;
      }

      setLineBusy(row.lineId, true);
      try {
        const res = await fetch(
          `/api/admin/members/${userId}/weeks/${weekId}/lines/${row.lineId}/second-entry`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ allowed: nextAllowed, mode }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          t.error("update", { status: res.status, message: json?.error });
          return;
        }
        t.success("update", nextAllowed ? "2차 기입을 허용했습니다." : "2차 기입을 닫았습니다.");
        await load(); // 서버 상태 재조회(optimistic 금지)
      } catch {
        t.error("update", "network");
      } finally {
        setLineBusy(row.lineId, false);
      }
    },
    [userId, weekId, mode, canManage, anyBusy, setLineBusy, t, load],
  );

  // 전체 허용 — 오픈+강화성공 라인만. 대상 0 이면 API 미호출.
  const bulkAllow = useCallback(async () => {
    if (!canManage || anyBusy) return;
    if (eligibleCount === 0) {
      await adminDialog.alert({
        variant: "info",
        title: "2차 기입 허용",
        description: "2차 기입을 허용할 수 있는 라인이 없습니다.",
      });
      return;
    }
    const ok = await adminDialog.confirm({
      variant: "default",
      title: "전체 2차 기입 허용",
      description: `2차 기입이 가능한 라인 ${eligibleCount}개를 모두 허용하시겠습니까?\n오픈되어 있고 강화 성공한 라인만 변경됩니다.\n수동으로 허용한 상태는 직접 다시 닫기 전까지 유지됩니다.`,
      confirmLabel: "전체 허용",
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const res = await fetch(
        `/api/admin/members/${userId}/weeks/${weekId}/lines/second-entry/bulk`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "allow", mode }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        t.error("update", { status: res.status, message: json?.error });
        return;
      }
      t.success("update", `${json.data.changedCount}개 라인의 2차 기입을 허용했습니다.`);
      await load();
    } catch {
      t.error("update", "network");
    } finally {
      setBulkBusy(false);
    }
  }, [userId, weekId, mode, canManage, anyBusy, eligibleCount, t, load]);

  // 전체 불가 — 현재 수동 허용된 라인 전량 닫기(과거 비정상 허용 포함).
  const bulkDeny = useCallback(async () => {
    if (!canManage || anyBusy) return;
    if (allowedCount === 0) {
      await adminDialog.alert({
        variant: "info",
        title: "2차 기입 불가",
        description: "현재 수동으로 허용된 라인이 없습니다.",
      });
      return;
    }
    const ok = await adminDialog.confirm({
      variant: "danger",
      title: "전체 2차 기입 불가",
      description: `현재 수동으로 허용된 ${allowedCount}개 라인의 2차 기입을 모두 닫으시겠습니까?`,
      confirmLabel: "전체 불가",
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const res = await fetch(
        `/api/admin/members/${userId}/weeks/${weekId}/lines/second-entry/bulk`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "deny", mode }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        t.error("update", { status: res.status, message: json?.error });
        return;
      }
      t.success("update", `${json.data.changedCount}개 라인의 2차 기입을 닫았습니다.`);
      await load();
    } catch {
      t.error("update", "network");
    } finally {
      setBulkBusy(false);
    }
  }, [userId, weekId, mode, canManage, anyBusy, allowedCount, t, load]);

  const openLineDetail = useCallback(
    (row: CrewWeekLineDetailRow) => {
      void adminDialog.open({
        variant: "custom",
        width: "lg",
        content: <LineDetailContent row={row} poLabelA={poLabels.a} poLabelB={poLabels.b} />,
      });
    },
    [poLabels.a, poLabels.b],
  );

  if (loading && !summary) {
    return <p className="py-8 text-sm text-muted-foreground">라인 강화 내역을 불러오는 중…</p>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
        {error}
      </div>
    );
  }
  if (!summary) {
    return <p className="py-8 text-sm text-muted-foreground">라인 강화 내역이 없습니다.</p>;
  }

  const { lines, results, points, weeklyGrowthRate, confirmed, lineDetails } = summary;

  return (
    <div className="flex flex-col gap-4">
      {/* 첫 줄 — 전체/오픈/미오픈 + 우측 주차 성장률. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-md border bg-muted/30 px-4 py-3">
        <Metric label="전체 라인" value={lines.total} />
        <Metric label="오픈 라인" value={lines.open} />
        <Metric label="미오픈 라인" value={lines.unopened} />
        <div className="ml-auto flex items-center gap-2 whitespace-nowrap">
          <span className="text-xs text-muted-foreground">주차 성장률</span>
          <span className="text-lg font-bold tabular-nums text-foreground">
            {weeklyGrowthRate}%
          </span>
        </div>
      </div>

      {/* 두 번째 줄 — 강화 성공/실패/해당 없음(확정 주차만). */}
      {confirmed ? (
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-md border bg-muted/20 px-4 py-3">
          <Metric label="강화 성공" value={results.success} />
          <Metric label="강화 실패" value={results.failure} />
          <Metric label="해당 없음" value={results.notApplicable} />
        </div>
      ) : (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          성장 결과가 확정(집계 완료)된 이후 라인별 강화 성공/실패/해당 없음 집계와 2차 기입 관리를
          표시합니다.
          {results.pending > 0 ? ` 현재 미판정 라인 ${results.pending}개.` : ""}
        </div>
      )}

      {/* 세 번째 줄 — 라인 강화 결과 획득 포인트(획득 / 획득 가능). */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-md border bg-muted/20 px-4 py-3">
        <PointMetric
          label={`획득 ${poLabels.a}`}
          earned={points.pointA.earned}
          possible={points.pointA.possible}
          colorClass={pointColorClass("a")}
        />
        <PointMetric
          label={`획득 ${poLabels.b}`}
          earned={points.pointB.earned}
          possible={points.pointB.possible}
          colorClass={pointColorClass("b")}
        />
        <PointMetric
          label={`획득 ${poLabels.c}`}
          earned={points.pointC.earned}
          possible={points.pointC.possible}
          colorClass={pointColorClass("c")}
        />
      </div>

      {/* ── 하단 라인 상세 표 + 2차 기입 제어 ── */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canManage || anyBusy}
            onClick={bulkAllow}
            className="gap-1.5 border-emerald-500/60 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-500/10"
          >
            <SwitchTrack tone="green" on />
            전체 · 2차 기입 허용
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canManage || anyBusy}
            onClick={bulkDeny}
            className="gap-1.5 border-red-500/60 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            <SwitchTrack tone="red" on={false} />
            전체 · 2차 기입 불가
          </Button>
        </div>

        <div className="overflow-x-auto rounded-md border">
          {/* table-fixed + colgroup: 헤더/바디 동일 폭. 라인명은 가장 넓게(long-text=좌측),
              나머지 상태·숫자 컬럼은 가운데 정렬. 좁은 화면은 min-w 로 가로 스크롤 유지. */}
          <table className="w-full min-w-[56rem] table-fixed border-collapse text-sm">
            <colgroup>
              <col style={{ width: "32%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "10%" }} />
            </colgroup>
            <thead>
              <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                <th className="px-3 py-2 text-center font-medium">라인명</th>
                <th className="px-3 py-2 text-center font-medium">허브</th>
                <th className="px-3 py-2 text-center font-medium">클럽 오픈</th>
                <th className="px-3 py-2 text-center font-medium">강화 결과</th>
                <th className="px-3 py-2 text-center font-medium">평점</th>
                <th className="px-3 py-2 text-center font-medium">획득 {poLabels.a}</th>
                <th className="px-3 py-2 text-center font-medium">획득 {poLabels.b}</th>
                <th className="px-3 py-2 text-center font-medium">2차 기입</th>
              </tr>
            </thead>
            <tbody>
              {lineDetails.map((row, idx) => (
                <tr
                  key={row.lineId ?? `ph-${idx}`}
                  className="border-b align-middle last:border-b-0 hover:bg-muted/20"
                >
                  <td className="px-3 py-2 text-center">
                    {/* 셀 폭 전체 사용 — 중앙 정렬, 부모 가용 폭까지 채우고 정말 넘칠 때만 말줄임. */}
                    <button
                      type="button"
                      onClick={() => openLineDetail(row)}
                      className="mx-auto block w-full min-w-0 text-center font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                      title={row.lineName}
                    >
                      <span className="block truncate text-center">{row.lineName}</span>
                    </button>
                  </td>
                  <td className="truncate px-3 py-2 text-center text-muted-foreground">
                    {row.hubLabel}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <StatusBadge
                      label={row.clubOpen ? "오픈" : "미오픈"}
                      tone={row.clubOpen ? "info" : "neutral"}
                      size="sm"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <StatusBadge
                      label={row.enhancementLabel}
                      tone={ENHANCEMENT_TONE[enhancementStatusTone(row.enhancementStatus)]}
                      size="sm"
                    />
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-foreground">
                    {row.rating == null ? "-" : row.rating}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-center tabular-nums",
                      row.earnedA > 0 ? pointColorClass("a") : "text-muted-foreground",
                    )}
                  >
                    {row.earnedA}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-center tabular-nums",
                      row.earnedB > 0 ? pointColorClass("b") : "text-muted-foreground",
                    )}
                  >
                    {row.earnedB}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex justify-center">
                      <SecondEntrySwitch
                        row={row}
                        canManage={canManage}
                        busy={row.lineId ? busyLines.has(row.lineId) : false}
                        anyBusy={anyBusy}
                        onToggle={() => toggleLine(row)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 범례 — 스위치 상태 의미(보자마자 이해). */}
        <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <SwitchTrack tone="green" on />
            <span>
              <b className="text-emerald-700 dark:text-emerald-400">허용</b>: 크루 페이지에서 2차 기입을
              수정할 수 있습니다.
            </span>
          </span>
          <span className="flex items-center gap-2">
            <SwitchTrack tone="red" on={false} />
            <span>
              <b className="text-red-600 dark:text-red-400">불가</b>: 크루 페이지에서 2차 기입을 수정할 수
              없습니다.
            </span>
          </span>
          <span className="flex items-center gap-2">
            <SwitchTrack tone="gray" on={false} />
            <Lock className="h-3.5 w-3.5" aria-hidden />
            <span>잠금: 허용할 수 없는 라인입니다(오픈·강화 성공 아님).</span>
          </span>
        </div>

        {!canManage && (
          <p className="text-xs text-muted-foreground">
            2차 기입 허용/불가는 성장 결과가 확정된 주차에서만 관리할 수 있습니다.
          </p>
        )}
      </div>
    </div>
  );
}

// 토글 스위치 트랙(표시 전용) — ON=오른쪽/초록, OFF=왼쪽/빨강|회색. 표 셀 + 범례 공용.
function SwitchTrack({
  tone,
  on,
  pulse,
}: {
  tone: "green" | "red" | "gray";
  on: boolean;
  pulse?: boolean;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        tone === "green" ? "bg-emerald-500" : tone === "red" ? "bg-red-500" : "bg-muted",
        pulse && "animate-pulse",
      )}
      aria-hidden
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          on ? "translate-x-[1.125rem]" : "translate-x-0.5",
        )}
      />
    </span>
  );
}

// 2차 기입 ON/OFF 스위치 — 허용(ON·초록)/불가(OFF·빨강). 허용 불가 라인은 회색 Disabled + 잠금.
//   클릭 동작·자격 안내·서버 호출은 상위 onToggle(toggleLine) 그대로 — 표시만 스위치로 바꾼다.
function SecondEntrySwitch({
  row,
  canManage,
  busy,
  anyBusy,
  onToggle,
}: {
  row: CrewWeekLineDetailRow;
  canManage: boolean;
  busy: boolean;
  anyBusy: boolean;
  onToggle: () => void;
}) {
  if (!row.lineId) {
    return <span className="text-xs text-muted-foreground">-</span>;
  }
  const allowed = row.overrideAllowed;
  const locked = !allowed && !row.eligible; // 허용 불가(미오픈/강화 실패/해당 없음)
  const label = allowed ? "허용" : "불가";
  // !canManage(집계 전) → 완전 비활성. 그 외엔 클릭 가능(비자격 라인은 클릭 시 안내 팝업).
  const disabled = !canManage || anyBusy;
  const trackTone = !canManage ? "gray" : allowed ? "green" : row.eligible ? "red" : "gray";
  const labelColor = allowed
    ? "text-emerald-700 dark:text-emerald-400"
    : locked || !canManage
      ? "text-muted-foreground"
      : "text-red-600 dark:text-red-400";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={allowed}
      aria-label={`2차 기입 ${label}`}
      disabled={disabled}
      onClick={onToggle}
      title={
        !canManage
          ? "확정된 주차에서만 관리할 수 있습니다."
          : allowed
            ? "클릭하면 2차 기입을 닫습니다(불가)."
            : row.eligible
              ? "클릭하면 2차 기입을 허용합니다."
              : "오픈·강화 성공 라인만 허용할 수 있습니다."
      }
      className={cn(
        "inline-flex items-center gap-2 rounded-md px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled ? "cursor-not-allowed opacity-70" : "hover:opacity-90",
      )}
    >
      <SwitchTrack tone={trackTone} on={allowed} pulse={busy} />
      <span className={cn("text-sm font-medium", labelColor)}>{busy ? "처리 중…" : label}</span>
      {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
    </button>
  );
}

// 라인 상세 팝업(조회 전용) — 기존 라인 DTO 로 확인 가능한 값만 표시.
function LineDetailContent({
  row,
  poLabelA,
  poLabelB,
}: {
  row: CrewWeekLineDetailRow;
  poLabelA: string;
  poLabelB: string;
}) {
  const sub = row.submission;
  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <h2 className="pr-8 text-base font-semibold text-foreground">{row.lineName}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <DRow label="허브" value={row.hubLabel} />
        <DRow label="라인 코드" value={row.displayLineCode ?? "-"} />
        <DRow label="클럽 오픈" value={row.clubOpen ? "오픈" : "미오픈"} />
        <DRow label="강화 결과" value={row.enhancementLabel} />
        <DRow label="판정 근거" value={row.enhancementReason} mono />
        <DRow label="제출 상태" value={row.submissionStatus} mono />
        <DRow label="평점" value={row.rating == null ? "-" : String(row.rating)} />
        <DRow label={`획득 ${poLabelA}`} value={String(row.earnedA)} />
        <DRow label={`획득 ${poLabelB}`} value={String(row.earnedB)} />
        <DRow
          label="2차 기입"
          value={
            (row.overrideAllowed ? "허용(수동)" : "불가") +
            (row.effectiveCanEdit ? " · 현재 편집 가능" : " · 현재 편집 불가")
          }
        />
        <DRow label="기입 시작" value={fmtTime(row.submissionOpensAt)} />
        <DRow label="기입 마감" value={fmtTime(row.submissionClosesAt)} />
      </dl>

      {sub && (
        <div className="flex flex-col gap-2 rounded-md border bg-muted/20 px-3 py-2.5">
          <span className="text-xs font-semibold text-muted-foreground">기존 2차 기입 내용</span>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <DRow label="소제목" value={sub.subtitle?.trim() || "-"} />
            <DRow label="그로스 포인트" value={sub.growthPoint?.trim() || "-"} />
            <DRow label="산출 링크" value={`${sub.outputLinks.length}개`} />
            <DRow label="산출 이미지" value={`${sub.outputImages.length}개`} />
            <DRow label="제출 시각" value={fmtTime(sub.submittedAt)} />
            <DRow label="수정 시각" value={fmtTime(sub.updatedAt)} />
          </dl>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        조회 전용입니다. 라인 오픈 여부·강화 결과·포인트는 이 창에서 변경할 수 없습니다.
      </p>
    </div>
  );
}

function DRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words text-foreground", mono && "font-mono text-xs")}>
        {value}
      </dd>
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-semibold tabular-nums text-foreground">{value}</span>
    </span>
  );
}

function PointMetric({
  label,
  earned,
  possible,
  colorClass,
}: {
  label: string;
  earned: number;
  possible: number;
  colorClass?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        <span className={cn("text-base font-semibold", colorClass)}>{earned}</span>
        <span className="text-sm text-muted-foreground"> / {possible}</span>
      </span>
    </span>
  );
}

// ISO → "YYYY-MM-DD HH:mm". 파싱 불가/없음 → "-".
function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}
