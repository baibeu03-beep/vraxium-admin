"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Checkbox, checkedTextClass, checkedRowClass } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { pointColorClass } from "@/components/ui/point-value";
import { getProcessPointLabels } from "@/lib/pointLabels";
import { formatProcessHubLabel } from "@/lib/adminProcessesTypes";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import { type ScopeMode } from "@/lib/userScopeShared";
import ActSupplementDialog from "@/components/admin/ActSupplementDialog";
import WeekTallyingNotice from "@/components/admin/WeekTallyingNotice";
import type { CrewWeekActDetailDto, CrewWeekActRow } from "@/lib/adminCrewWeekActDetail";
import type { CrewActSummary } from "@/shared/crewActSummary";

// 성장 결과 변경 미리보기(서버 409 impact) — 취소 시 성공→실패 확인 팝업에 표시할 전후 값.
type ImpactSide = { growthStatus: string; growthStatusLabel: string; pointA: number };
type GrowthFlip = { before: ImpactSide; after: ImpactSide };

// 회원별·주차별 상세 "액트 체크 내역" 탭 — 상단 요약 + 목록 표 + 체크박스 + 액트 취소(소프트 취소).
//   · 요약 = 서버 DTO(summary) 그대로 표시. 크루 페이지 Detail Log 와 **동일 공통 빌더**
//     (shared/crewActSummary.buildCrewActSummary) 산출값이라 같은 크루·주차면 수치가 일치한다.
//     ⚠ 프론트에서 재계산/DOM 재추산 금지 — reduce 추가 금지(서버 값만 렌더).
//   · 취소 액트는 표에는 "취소됨" 으로 남지만 요약에는 미포함(크루 페이지 정책 승계 — 서버가 제외).
//   · 배치 순서(요구): ① 요약 → ② 액트 보완/취소 버튼 → ③ 표.
//   · 취소는 optimistic 없이 서버 재집계 후 최신 DTO 로 전체 교체 + 상위(주차 요약) 갱신.

export default function CrewWeekActHistory({
  userId,
  weekId,
  mode,
  orgSlug,
  onChanged,
}: {
  userId: string;
  weekId: string;
  mode: ScopeMode;
  orgSlug: string | null;
  onChanged: () => void;
}) {
  const poLabels = getProcessPointLabels(orgSlug);
  const ctxQuery = mode === "test" ? "?mode=test" : "";

  const [detail, setDetail] = useState<CrewWeekActDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [supplementOpen, setSupplementOpen] = useState(false);
  const [cancelFlip, setCancelFlip] = useState<GrowthFlip | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/members/${userId}/weeks/${weekId}/acts${ctxQuery}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "액트 내역을 불러오지 못했습니다.");
      }
      setDetail(json.data as CrewWeekActDetailDto);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "액트 내역을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [userId, weekId, ctxQuery]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const acts = useMemo(() => detail?.acts ?? [], [detail]);
  const editable = detail?.editable ?? false;
  const cancellableIds = useMemo(
    () => acts.filter((a) => a.cancellable).map((a) => a.awardId),
    [acts],
  );
  const allSelected = cancellableIds.length > 0 && cancellableIds.every((id) => selected.has(id));
  const someSelected = cancellableIds.some((id) => selected.has(id));

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (cancellableIds.every((id) => prev.has(id))) return new Set();
      return new Set(cancellableIds);
    });
  }, [cancellableIds]);

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedCount = selected.size;
  const canCancel = editable && selectedCount > 0;

  // confirmGrowthFlip=false: 최초 시도(성장 결과가 성공→실패로 바뀌면 서버가 409 로 확인 요구).
  // confirmGrowthFlip=true: 성장 결과 변경 확인 팝업에서 "그래도 취소" 승인 후 실제 취소.
  const doCancel = useCallback(
    async (confirmGrowthFlip: boolean) => {
      setCancelling(true);
      setActionError(null);
      try {
        const res = await fetch(
          `/api/admin/members/${userId}/weeks/${weekId}/acts/cancel`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ awardIds: Array.from(selected), mode, confirmGrowthFlip }),
          },
        );
        const json = await res.json();
        // 성장 결과가 바뀜 — 저장 전 확인 팝업 표시(아직 취소 미반영).
        if (res.status === 409 && json?.code === "GROWTH_STATUS_WILL_CHANGE") {
          setConfirmOpen(false);
          setCancelFlip(json.impact as GrowthFlip);
          return;
        }
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "액트 취소에 실패했습니다.");
        }
        const d = json.data as {
          weekDetail?: CrewWeekActDetailDto;
          growthStatusChanged?: boolean;
          before?: ImpactSide;
          after?: ImpactSide;
        };
        // 서버가 반환한 최신 DTO 로 전체 교체(optimistic 없음).
        if (d?.weekDetail) setDetail(d.weekDetail);
        else await load();
        setSelected(new Set());
        setConfirmOpen(false);
        setCancelFlip(null);
        if (d?.growthStatusChanged && d.before && d.after) {
          toast(
            "success",
            `액트 취소 완료 — 성장 결과: ${d.before.growthStatusLabel} → ${d.after.growthStatusLabel}`,
          );
        } else {
          toast("success", "선택한 액트를 취소했습니다.");
        }
        onChanged(); // 상위 주차 요약(별/방패/번개/성장률) + 타 표면 갱신
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "액트 취소에 실패했습니다.");
      } finally {
        setCancelling(false);
      }
    },
    [userId, weekId, selected, mode, load, onChanged, toast],
  );

  if (loading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 집계 중(미확정) 주차 — 조회 전용 안내(라인 강화 내역과 동일 컴포넌트·조건). editable = confirmed. */}
      <WeekTallyingNotice confirmed={editable} />

      {/* ① 액트 요약 — 크루 페이지 Detail Log 와 동일 항목/명칭. 서버 DTO 값만 렌더. */}
      {detail?.summary ? <ActSummary summary={detail.summary} poLabels={poLabels} /> : null}

      {/* ② 버튼 영역 — [액트 보완] / [액트 취소] */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {selectedCount > 0 && (
          <span className="mr-1 text-sm text-muted-foreground">{selectedCount}개 선택</span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!editable}
          title={
            !editable
              ? "진행 중이거나 집계 중인 주차에는 액트를 보완할 수 없습니다."
              : undefined
          }
          onClick={() => {
            setActionError(null);
            setSupplementOpen(true);
          }}
        >
          <Pencil className="h-4 w-4" />
          액트 보완
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canCancel}
          title={
            !editable
              ? "진행 중이거나 집계 중인 주차의 액트는 취소할 수 없습니다."
              : selectedCount === 0
                ? "취소할 액트를 선택해 주세요."
                : undefined
          }
          onClick={() => {
            setActionError(null);
            setConfirmOpen(true);
          }}
        >
          <Ban className="h-4 w-4" />
          액트 취소
        </Button>
      </div>

      {actionError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {acts.length === 0 ? (
        <p className="rounded-md border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
          이번 주 수행·적립된 액트 내역이 없습니다.
        </p>
      ) : (
        <div className="overflow-x-auto">
          {/* 헤더·셀 전부 가운데 정렬(예외 없음) — table text-center 상속, 셀은 override 금지. */}
          <table className="w-full border-collapse text-center text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-2 py-2 text-center">
                  <Checkbox
                    indeterminate={someSelected && !allSelected}
                    aria-label="취소 가능 액트 전체 선택"
                    checked={allSelected}
                    disabled={!editable || cancellableIds.length === 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="whitespace-nowrap px-2 py-2">결과</th>
                <th className="whitespace-nowrap px-2 py-2">액트명</th>
                <th className="whitespace-nowrap px-2 py-2">발생 시점</th>
                <th className="whitespace-nowrap px-2 py-2">소속 허브</th>
                <th className="whitespace-nowrap px-2 py-2">소속 라인</th>
                <th className="whitespace-nowrap px-2 py-2">소요 시간</th>
                <th className="whitespace-nowrap px-2 py-2">{poLabels.a}</th>
                <th className="whitespace-nowrap px-2 py-2">{poLabels.b}</th>
                <th className="whitespace-nowrap px-2 py-2">{poLabels.c}</th>
                <th className="whitespace-nowrap px-2 py-2">구분</th>
                <th className="whitespace-nowrap px-2 py-2">종류</th>
              </tr>
            </thead>
            <tbody>
              {acts.map((a) => (
                <ActRowView
                  key={a.awardId}
                  row={a}
                  editable={editable}
                  checked={selected.has(a.awardId)}
                  onToggle={() => toggleOne(a.awardId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !cancelling) setConfirmOpen(false);
          }}
        >
          <div className="modal-w-md rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
            <h2 className="text-base font-semibold">액트 취소</h2>
            <p className="mt-3 text-sm text-foreground">
              선택한 액트 <b>{selectedCount}</b>건을 취소하시겠습니까?
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              액트 취소 시 해당 액트에서 발생한 포인트와 주차 집계 결과가 함께 다시 계산됩니다. 이
              작업은 다른 관리자 화면과 크루 페이지에도 반영됩니다.
            </p>
            {actionError && (
              <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {actionError}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={cancelling}
                onClick={() => setConfirmOpen(false)}
              >
                닫기
              </Button>
              <Button type="button" size="sm" loading={cancelling} disabled={cancelling} onClick={() => void doCancel(false)}>
                액트 취소
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 성장 결과 변경 확인(취소로 성공→실패) — 저장 전(취소 미반영). "그래도 취소" 시에만 실제 반영. */}
      {cancelFlip && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="modal-w-md rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
            <h2 className="text-base font-semibold">성장 결과 변경 확인</h2>
            <p className="mt-3 text-sm text-foreground">
              {detail?.weekLabel ?? "이 주차"} 결과가{" "}
              <b>‘{cancelFlip.before.growthStatusLabel}’</b>에서{" "}
              <b>‘{cancelFlip.after.growthStatusLabel}’</b>(으)로 변경됩니다. 선택한 액트를 취소하시겠습니까?
            </p>
            <dl className="mt-3 space-y-1 rounded-md border bg-muted/20 px-3 py-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">성장 결과</dt>
                <dd className="tabular-nums">
                  {cancelFlip.before.growthStatusLabel} → {cancelFlip.after.growthStatusLabel}
                </dd>
              </div>
              {cancelFlip.before.pointA !== cancelFlip.after.pointA && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">별</dt>
                  <dd className="tabular-nums">
                    {cancelFlip.before.pointA} → {cancelFlip.after.pointA}
                  </dd>
                </div>
              )}
            </dl>
            {actionError && (
              <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {actionError}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={cancelling} onClick={() => setCancelFlip(null)}>
                취소
              </Button>
              <Button type="button" size="sm" loading={cancelling} disabled={cancelling} onClick={() => void doCancel(true)}>
                그래도 취소
              </Button>
            </div>
          </div>
        </div>
      )}

      {supplementOpen && (
        <ActSupplementDialog
          userId={userId}
          weekId={weekId}
          mode={mode}
          orgSlug={orgSlug}
          weekLabel={detail?.weekLabel ?? ""}
          onClose={() => setSupplementOpen(false)}
          onDone={(weekDetail) => {
            // 서버 최신 DTO 로 교체(optimistic 없음) + 상위(주차 요약·타 표면) 갱신.
            if (weekDetail) setDetail(weekDetail);
            else void load();
            setSelected(new Set());
            onChanged();
          }}
        />
      )}
    </div>
  );
}

// 액트 요약 — 크루 페이지 Detail Log "액트 내역 목록" 요약과 동일 항목·명칭·위계.
//   1행: 활동 완료율(progress bar + %) · 2행: 체크 가능/성공/실패/필수/선별
//   3행: 획득 포인트 A/B/C("획득 / 가능") · 4행: 정규/변동 액트
//   포인트 라벨은 조직 config(getProcessPointLabels) 단일 출처 — 별/방패/번개 등 하드코딩 금지.
//   ⚠ 값은 전부 서버 summary 그대로. 여기서 재계산하지 않는다.
function ActSummary({
  summary,
  poLabels,
}: {
  summary: CrewActSummary;
  poLabels: ReturnType<typeof getProcessPointLabels>;
}) {
  const { points } = summary;
  return (
    // data-act-summary: 브라우저 검증이 요약 영역을 특정하는 안정 훅(표시 무영향).
    <div className="flex flex-col gap-2" data-act-summary>
      {/* 1행 — 활동 완료율 · 체크 가능 · 체크 성공 · 체크 실패.
          활동 완료율은 progress bar 없이 **숫자(%)만**(관리자 화면 스타일 — 요구 2026-07-17). */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-md border bg-muted/30 px-4 py-3">
        <SumMetric label="활동 완료율" value={`${summary.rate}%`} />
        <SumMetric label="체크 가능" value={summary.total} />
        <SumMetric label="체크 성공" value={summary.success} valueClassName="text-emerald-700 dark:text-emerald-400" />
        <SumMetric label="체크 실패" value={summary.fail} valueClassName="text-red-600 dark:text-red-400" />
      </div>

      {/* 2행 — 정규 액트 · 변동 액트 · 체크 필수 · 체크 선별. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-md border bg-muted/20 px-4 py-3">
        <SumMetric label="정규 액트" value={summary.regularActCount} />
        <SumMetric label="변동 액트" value={summary.variableActCount} />
        <SumMetric label="체크 필수" value={summary.required} />
        <SumMetric label="체크 선별" value={summary.selective} />
      </div>

      {/* 3행 — 획득 포인트 A/B/C ("획득값 / 획득 가능 총값"). 음수 earned 도 그대로(Math.max 금지).
          라벨 = 조직 point config(getProcessPointLabels) 단일 출처 — 별/방패/번개·투구/화살 하드코딩 금지
          (org 미상이면 중립 Po.A/Po.B/Po.C). */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-md border bg-muted/20 px-4 py-3">
        <SumPointMetric
          label={`획득 ${poLabels.a}`}
          pair={points.pointA}
          colorClass={pointColorClass("a")}
        />
        <SumPointMetric
          label={`획득 ${poLabels.b}`}
          pair={points.pointB}
          colorClass={pointColorClass("b")}
        />
        <SumPointMetric
          label={`획득 ${poLabels.c}`}
          pair={points.pointC}
          colorClass={pointColorClass("c")}
        />
      </div>
    </div>
  );
}

function SumMetric({
  label,
  value,
  valueClassName,
}: {
  label: string;
  /** 숫자 또는 이미 포맷된 문자열("75%") — 서버 값 그대로 렌더(프론트 재계산 없음). */
  value: number | string;
  valueClassName?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-base font-semibold tabular-nums text-foreground", valueClassName)}>
        {value}
      </span>
    </span>
  );
}

// "획득 별 43 / 103" — 획득/가능. available 0 이어도 "0 / 0" 으로 명확히 표기(나눗셈 없음).
function SumPointMetric({
  label,
  pair,
  colorClass,
}: {
  label: string;
  pair: { earned: number; available: number };
  colorClass?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        <span className={cn("text-base font-semibold", colorClass)}>{pair.earned}</span>
        <span className="text-sm text-muted-foreground"> / {pair.available}</span>
      </span>
    </span>
  );
}

function ActRowView({
  row,
  editable,
  checked,
  onToggle,
}: {
  row: CrewWeekActRow;
  editable: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const disabled = !editable || !row.cancellable;
  return (
    <tr className={cn("border-b last:border-0", checkedRowClass(checked), row.cancelled && "opacity-50")}>
      <td className="px-2 py-2 text-center">
        <Checkbox
          aria-label={`${row.actName} 선택`}
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
        />
      </td>
      <td className="whitespace-nowrap px-2 py-2">
        {row.cancelled ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={row.cancelReason ?? undefined}>
            취소됨
          </span>
        ) : (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            {row.resultLabel}
          </span>
        )}
      </td>
      <td className={cn("max-w-[220px] truncate px-2 py-2", checkedTextClass(checked), row.cancelled && "line-through")} title={row.actName}>
        {row.actName}
      </td>
      <td className="whitespace-nowrap px-2 py-2">
        {formatAdminDateTime(row.occurredAt, { withSeconds: false })}
      </td>
      {/* 소속 허브 — enum(experience/info/…) 을 한글 표시명으로. 저장값/DTO 무변경(표시 전용). */}
      <td className="max-w-[120px] truncate px-2 py-2" title={formatProcessHubLabel(row.hubName)}>{formatProcessHubLabel(row.hubName)}</td>
      <td className="max-w-[160px] truncate px-2 py-2" title={row.lineName ?? "-"}>{row.lineName ?? "-"}</td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums">{row.durationMinutes}m</td>
      <td className={cn("whitespace-nowrap px-2 py-2 tabular-nums", pointColorClass("a"))}>{row.pointA}</td>
      <td className={cn("whitespace-nowrap px-2 py-2 tabular-nums", pointColorClass("b"))}>{row.pointB}</td>
      <td className={cn("whitespace-nowrap px-2 py-2 tabular-nums", pointColorClass("c"))}>
        {row.pointC > 0 ? `-${row.pointC}` : 0}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-center">{row.actKindLabel}</td>
      <td className="whitespace-nowrap px-2 py-2 text-center">{row.requirementLabel}</td>
    </tr>
  );
}
