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
import { type CrewIdentity } from "@/components/admin/crew/CrewIdentityCards";
import CrewWeekLineDetailDialog from "@/components/admin/CrewWeekLineDetailDialog";
import WeekTallyingNotice from "@/components/admin/WeekTallyingNotice";
import type { BadgeTone } from "@/components/ui/badge";
import { rawOpenLineGrowthRate } from "@/lib/lineHistoryGrowthRate";
import { formatLineDuration } from "@/lib/adminLineRegistrationsTypes";
import { SortableTh } from "@/components/admin/SortableTh";
import {
  cycleSort,
  sortLineRows,
  type LineSortKey,
  type LineSortRow,
  type LineSortState,
} from "@/shared/detailLogSort";
import type {
  CrewWeekLineDetailRow,
  CrewWeekLineSummaryDto,
} from "@/lib/adminCrewWeekLineSummary";
import type { Cluster4LinePartType } from "@/shared/cluster4.contracts";

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

// 허브별 그룹 정의 — 표시 순서(정보→경험→역량→경력)와 색 계열. partType 이 그룹 키(SoT).
//   색은 허브 구분 보조 수단이며, 라인 텍스트(허브명)로도 반드시 명확히 보이게 한다(요구 §3).
//   다크 모드 대비 유지: 헤더=옅은 tint + 테두리, 허브명=진한 텍스트.
const HUB_GROUPS: {
  partType: Cluster4LinePartType;
  label: string;
  header: string;
  name: string;
}[] = [
  {
    partType: "information",
    label: "실무 정보",
    header: "border-red-300 bg-red-50/70 dark:border-red-500/40 dark:bg-red-500/10",
    name: "text-red-800 dark:text-red-300",
  },
  {
    partType: "experience",
    label: "실무 경험",
    header:
      "border-yellow-300 bg-yellow-50/70 dark:border-yellow-500/40 dark:bg-yellow-500/10",
    name: "text-yellow-800 dark:text-yellow-300",
  },
  {
    partType: "competency",
    label: "실무 역량",
    header:
      "border-emerald-300 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-500/10",
    name: "text-emerald-800 dark:text-emerald-300",
  },
  {
    partType: "career",
    label: "실무 경력",
    header: "border-sky-300 bg-sky-50/70 dark:border-sky-500/40 dark:bg-sky-500/10",
    name: "text-sky-800 dark:text-sky-300",
  },
];

// 허브 그룹 요약 카운트 — 상단 전체 요약과 동일한 raw 라인 행 기준(clubOpen / enhancementStatus).
//   강화율 = rawOpenLineGrowthRate(단일 SoT 재사용) — 오픈 라인 중 강화 성공 비율(raw 행).
type HubStats = {
  total: number;
  open: number;
  unopened: number;
  success: number;
  failure: number;
  notApplicable: number;
  growthRate: number;
};

function computeHubStats(rows: readonly CrewWeekLineDetailRow[]): HubStats {
  const total = rows.length;
  const open = rows.filter((r) => r.clubOpen).length;
  return {
    total,
    open,
    unopened: total - open,
    success: rows.filter((r) => r.enhancementStatus === "success").length,
    failure: rows.filter((r) => r.enhancementStatus === "fail").length,
    notApplicable: rows.filter((r) => r.enhancementStatus === "not_applicable").length,
    growthRate: rawOpenLineGrowthRate(rows),
  };
}

// 관리자 라인 행(CrewWeekLineDetailRow) → 공통 정렬 정규화 행(LineSortRow). 표시값 아닌 원본값으로 정렬.
//   · 소요시간/평점/포인트는 숫자 그대로 · 강화결과/유형은 화면 라벨 · 허브는 partType(어드민은 그룹 분리라
//     허브 키 정렬은 쓰지 않지만 계약 충족을 위해 채운다). stableKey = lineId 우선(없으면 파생·결정적).
function toLineSortRow(row: CrewWeekLineDetailRow): LineSortRow {
  return {
    stableKey: row.lineId ?? `${row.partType}:${row.lineName}:${row.lineTargetId ?? ""}`,
    result: row.enhancementLabel,
    name: row.lineName,
    hubToken: row.partType,
    kind: row.type ?? "",
    duration: row.estimatedDurationMinutes,
    rating: row.rating,
    pointA: row.earnedA,
    pointB: row.earnedB,
    pointC: row.earnedC,
    growthRequirement: "",
    clubOpen: row.clubOpen,
  };
}

export default function CrewWeekLineHistory({
  userId,
  weekId,
  weekLabel,
  mode,
  orgSlug,
  member,
  onChanged,
}: {
  userId: string;
  weekId: string;
  weekLabel?: string | null;
  mode: ScopeMode;
  orgSlug: string | null;
  member: CrewIdentity | null;
  onChanged?: () => void;
}) {
  const t = useActionToast();
  const [summary, setSummary] = useState<CrewWeekLineSummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyLines, setBusyLines] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const ctxQuery = mode === "test" ? "?mode=test" : "";

  // 라인 표 정렬 상태 — 4개 허브 그룹 공통(한 컬럼을 누르면 모든 허브 표가 같은 기준으로 정렬).
  //   null=기본(허브 그룹 순서 = 공식 허브 순서, 그룹 내부는 서버 결정적 순서 유지).
  //   다른 사용자/주차로 이동하면 초기화(탭 전환 후 복귀는 유지 · 모달 재오픈은 재마운트라 기본).
  //   초기화는 effect 대신 렌더 중 파생 상태 리셋(React 권장 패턴 — cascading render 없음).
  const [sort, setSort] = useState<LineSortState>(null);
  const sortScope = `${userId}:${weekId}`;
  const [prevSortScope, setPrevSortScope] = useState(sortScope);
  if (prevSortScope !== sortScope) {
    setPrevSortScope(sortScope);
    setSort(null);
  }
  const dirOf = useCallback((key: LineSortKey) => (sort?.key === key ? sort.dir : null), [sort]);
  const onSortKey = useCallback((key: LineSortKey) => setSort((s) => cycleSort(s, key)), []);

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
        // 자격 미충족 — 변경하지 않고 안내만(§10). 대상자 아님 > 미오픈 > 오픈-비성공 순으로 이유 구분.
        await adminDialog.alert({
          variant: "warning",
          title: "2차 기입을 허용할 수 없습니다",
          description:
            row.lineTargetId == null
              ? "이 크루가 대상자로 배정된 라인이 아니므로(대상자 아님) 2차 기입을 허용할 수 없습니다."
              : !row.clubOpen
                ? "오픈된 라인이 아니므로, 2차 기입을 허용할 수 없습니다."
                : "오픈되었지만, 강화 성공한 라인이 아니므로 2차 기입을 허용할 수 없습니다.",
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

  // 라인명 클릭 → 상세 팝업. 실제 라인 = 라인 상세·수정 팝업. 실무 역량 placeholder(라인명 -)
  //   = 라인 선택(강화 성공 전환) 팝업. 그 외 placeholder 는 상세 없음.
  const [detailLineId, setDetailLineId] = useState<string | null>(null);
  const [compSelectOpen, setCompSelectOpen] = useState(false);
  // 실무 경험 오픈+비대상(강화 실패) 슬롯 = 라인 선택(강화 성공 전환) 팝업. lineId 가 없어도 유형으로 연다.
  const [expSelectRow, setExpSelectRow] = useState<CrewWeekLineDetailRow | null>(null);
  const openLineDetail = useCallback((row: CrewWeekLineDetailRow) => {
    if (row.isCompetencyPlaceholder) setCompSelectOpen(true);
    else if (row.isExperiencePlaceholder) setExpSelectRow(row);
    else if (row.lineId) setDetailLineId(row.lineId);
  }, []);

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

  // 휴식 주차 — 일반 주차와 달리 라인 목록(정보 8행·경험 5행 등)을 만들지 않고 조회 전용 휴식 상태만.
  if (summary.isRestWeek) {
    return (
      <div className="rounded-md border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
        휴식 주차입니다. 이 주차에는 라인 강화 내역이 없습니다.
      </div>
    );
  }

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
        <WeekTallyingNotice confirmed={confirmed}>
          {results.pending > 0 ? (
            <p className="mt-1">{`현재 미판정 라인 ${results.pending}개.`}</p>
          ) : null}
        </WeekTallyingNotice>
      )}

      {/* 세 번째 줄 — 라인 강화 결과 획득 포인트(획득 / 획득 가능). A/B만(라인 정책상 Point C 없음). */}
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

        {/* ── 허브별 그룹: [요약 헤더 + 해당 허브 라인 테이블] 한 세트를 4개 허브로 반복 ──
            하나의 긴 혼합 테이블 대신, 허브별 별도 섹션/테이블로 분리(요구 §1). 그룹 간 간격 space-y-5. */}
        <div className="flex flex-col gap-5">
          {HUB_GROUPS.map((group) => {
            const rows = lineDetails.filter((r) => r.partType === group.partType);
            const stats = computeHubStats(rows);
            return (
              <section key={group.partType} className="flex flex-col gap-2">
                <HubSummaryHeader group={group} stats={stats} confirmed={confirmed} />
                {rows.length === 0 ? (
                  <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    이 주차에 오픈된 {group.label} 라인이 없습니다.
                  </div>
                ) : (
                  <HubLineTable
                    rows={rows}
                    poLabels={poLabels}
                    canManage={canManage}
                    busyLines={busyLines}
                    anyBusy={anyBusy}
                    onToggle={toggleLine}
                    onOpenDetail={openLineDetail}
                    sort={sort}
                    dirOf={dirOf}
                    onSortKey={onSortKey}
                  />
                )}
              </section>
            );
          })}
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

      {detailLineId ? (
        <CrewWeekLineDetailDialog
          userId={userId}
          weekId={weekId}
          lineId={detailLineId}
          mode={mode}
          member={member}
          onClose={() => setDetailLineId(null)}
          onSaved={() => {
            void load();
            onChanged?.();
          }}
        />
      ) : null}

      {compSelectOpen ? (
        <CrewWeekLineDetailDialog
          userId={userId}
          weekId={weekId}
          lineId={null}
          competencyPlaceholder
          placeholderEditable={canManage}
          weekLabel={weekLabel ?? null}
          orgSlug={summary?.organizationSlug ?? orgSlug}
          mode={mode}
          member={member}
          onClose={() => setCompSelectOpen(false)}
          onSaved={() => {
            void load();
            onChanged?.();
          }}
        />
      ) : null}

      {expSelectRow ? (
        <CrewWeekLineDetailDialog
          userId={userId}
          weekId={weekId}
          lineId={null}
          experiencePlaceholder
          experienceCategory={expSelectRow.experienceCategory}
          experienceCategoryLabel={expSelectRow.type}
          placeholderEditable={canManage}
          weekLabel={weekLabel ?? null}
          orgSlug={summary?.organizationSlug ?? orgSlug}
          mode={mode}
          member={member}
          onClose={() => setExpSelectRow(null)}
          onSaved={() => {
            void load();
            onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

// 허브 요약 헤더 — 허브명(색 계열) + 전체/오픈/미오픈/성공/실패/해당없음/강화율. flex-wrap 유지.
//   진행·집계 중 주차(미확정)면 성공/실패/해당없음/강화율 대신 "집계 전"만 표시(기존 정책·요구 §2).
function HubSummaryHeader({
  group,
  stats,
  confirmed,
}: {
  group: (typeof HUB_GROUPS)[number];
  stats: HubStats;
  confirmed: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-4 py-2.5 text-sm",
        group.header,
      )}
    >
      <span className={cn("inline-flex items-center gap-1.5 text-base font-bold", group.name)}>
        {group.label}
      </span>
      <HubStat label="전체" value={stats.total} />
      <HubStat label="오픈" value={stats.open} />
      <HubStat label="미오픈" value={stats.unopened} />
      {confirmed ? (
        <>
          <HubStat label="강화 성공" value={stats.success} />
          <HubStat label="강화 실패" value={stats.failure} />
          <HubStat label="해당 없음" value={stats.notApplicable} />
          <HubStat label="허브 강화율" value={`${stats.growthRate}%`} />
        </>
      ) : (
        <span className="text-muted-foreground">
          · <span className="font-semibold text-foreground">집계 전</span>
        </span>
      )}
    </div>
  );
}

function HubStat({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="whitespace-nowrap text-muted-foreground">
      · {label}{" "}
      <strong className="font-semibold tabular-nums text-foreground">{value}</strong>
    </span>
  );
}

// 허브 그룹 1개의 라인 테이블 — 허브 컬럼 제거(그룹으로 이미 분리, 요구 §4). 라인명만 좌측 정렬,
//   나머지 컬럼 중앙 정렬. 독립 rounded border 컨테이너 + 자체 overflow-x-auto(그룹별 가로 스크롤).
function HubLineTable({
  rows,
  poLabels,
  canManage,
  busyLines,
  anyBusy,
  onToggle,
  onOpenDetail,
  sort,
  dirOf,
  onSortKey,
}: {
  rows: CrewWeekLineDetailRow[];
  poLabels: ReturnType<typeof getProcessPointLabels>;
  canManage: boolean;
  busyLines: Set<string>;
  anyBusy: boolean;
  onToggle: (row: CrewWeekLineDetailRow) => void;
  onOpenDetail: (row: CrewWeekLineDetailRow) => void;
  sort: LineSortState;
  dirOf: (key: LineSortKey) => "asc" | "desc" | null;
  onSortKey: (key: LineSortKey) => void;
}) {
  // 기본(sort=null)이면 서버 결정적 순서 유지 · 사용자 정렬 시 공통 comparator 적용(허브 내부 정렬).
  const sortedRows = sort ? sortLineRows(rows, sort, toLineSortRow) : rows;
  return (
    <div className="overflow-x-auto rounded-md border">
      {/* table-fixed + colgroup: 헤더/바디 동일 폭. 허브 컬럼 제거로 라인명 폭 확보(좌측 정렬),
          나머지 상태·숫자 컬럼은 가운데 정렬. 좁은 화면은 min-w 로 가로 스크롤 유지.
          소요 시간 컬럼 추가(2026-07-17) — 라인명이 좁아지지 않도록 min-w 를 56→60rem 으로 함께
          올려 라인명 실폭을 유지한다(32%×56rem ≈ 28%×60rem). */}
      <table className="w-full min-w-[60rem] table-fixed border-collapse text-sm">
        <colgroup>
          <col style={{ width: "8%" }} />
          <col style={{ width: "28%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "7%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "10%" }} />
        </colgroup>
        <thead>
          <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
            <SortableTh label="유형" dir={dirOf("kind")} onSort={() => onSortKey("kind")} className="px-3" />
            <SortableTh label="라인명" dir={dirOf("name")} onSort={() => onSortKey("name")} className="px-3" />
            <SortableTh label="소요 시간" dir={dirOf("duration")} onSort={() => onSortKey("duration")} className="px-3" />
            <SortableTh label="클럽 오픈" dir={dirOf("clubOpen")} onSort={() => onSortKey("clubOpen")} className="px-3" />
            <SortableTh label="강화 결과" dir={dirOf("result")} onSort={() => onSortKey("result")} className="px-3" />
            <SortableTh label="평점" dir={dirOf("rating")} onSort={() => onSortKey("rating")} className="px-3" />
            <SortableTh label={`획득 ${poLabels.a}`} dir={dirOf("pointA")} onSort={() => onSortKey("pointA")} className="px-3" />
            <SortableTh label={`획득 ${poLabels.b}`} dir={dirOf("pointB")} onSort={() => onSortKey("pointB")} className="px-3" />
            <th className="px-3 py-2 text-center font-medium">2차 기입</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, idx) => (
            <tr
              key={row.lineId ?? `ph-${idx}`}
              className="border-b align-middle last:border-b-0 hover:bg-muted/20"
            >
              <td className="truncate px-3 py-2 text-center text-muted-foreground">
                {row.type ?? "-"}
              </td>
              <td className="px-3 py-2 text-left">
                {/* 라인명 본문만 좌측 정렬(헤더는 중앙 유지). 클릭 영역은 셀 폭 전체 사용,
                    부모 가용 폭까지 채우고 정말 넘칠 때만 말줄임(tooltip 유지). */}
                <button
                  type="button"
                  onClick={() => onOpenDetail(row)}
                  className="block w-full min-w-0 text-left font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                  title={
                    row.isCompetencyPlaceholder
                      ? "실무 역량 라인 선택"
                      : row.isExperiencePlaceholder
                        ? "실무 경험 라인 선택(강화 성공 전환)"
                        : row.lineName
                  }
                >
                  <span className="block truncate text-left">
                    {row.isCompetencyPlaceholder ? "-" : row.lineName}
                  </span>
                </button>
              </td>
              {/* 소요 시간 — 라인 마스터(line_registrations) 원장 값. 개설 여부와 무관하게 표시된다.
                  공통 formatter 단일 SoT · 미설정/마스터 매핑 실패는 '-'(회색). */}
              <td className="px-3 py-2 text-center tabular-nums">
                {row.estimatedDurationMinutes === null ? (
                  <span className="text-muted-foreground">{formatLineDuration(null)}</span>
                ) : (
                  formatLineDuration(row.estimatedDurationMinutes)
                )}
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
                    onToggle={() => onToggle(row)}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
              : row.lineTargetId == null
                ? "대상자로 배정된 라인이 아니어서 허용할 수 없습니다(대상자 아님)."
                : "오픈·강화 성공 라인만 허용할 수 있습니다."
      }
      className={cn(
        "inline-flex items-center gap-2 rounded-md px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled ? "cursor-not-allowed opacity-70" : "hover:opacity-90",
      )}
    >
      <SwitchTrack tone={trackTone} on={allowed} pulse={busy} />
      <span className={cn("text-sm font-medium", labelColor)}>{busy ? "처리 중…" : label}</span>
      {locked && !busy && row.lineTargetId == null && (
        <span className="text-[11px] text-muted-foreground">대상자 아님</span>
      )}
      {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
    </button>
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
