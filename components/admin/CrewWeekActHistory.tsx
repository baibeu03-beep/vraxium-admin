"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pointColorClass } from "@/components/ui/point-value";
import { getProcessPointLabels } from "@/lib/pointLabels";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import { type ScopeMode } from "@/lib/userScopeShared";
import ActSupplementDialog from "@/components/admin/ActSupplementDialog";
import type { CrewWeekActDetailDto, CrewWeekActRow } from "@/lib/adminCrewWeekActDetail";

// 회원별·주차별 상세 "액트 체크 내역" 탭 — 목록 표 + 체크박스 + 액트 취소(소프트 취소).
//   · 요약 지표(활동 완료율·체크 성공/실패·획득/가능 포인트)는 고객 Detail Log 공식 확정 후 제공(보류).
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

  const headerCbRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCbRef.current) headerCbRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

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

  const doCancel = useCallback(async () => {
    setCancelling(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/admin/members/${userId}/weeks/${weekId}/acts/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ awardIds: Array.from(selected), mode }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "액트 취소에 실패했습니다.");
      }
      // 서버가 반환한 최신 DTO 로 전체 교체(optimistic 없음).
      if (json.data?.weekDetail) setDetail(json.data.weekDetail as CrewWeekActDetailDto);
      else await load();
      setSelected(new Set());
      setConfirmOpen(false);
      onChanged(); // 상위 주차 요약(별/방패/번개/성장률) + 타 표면 갱신
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "액트 취소에 실패했습니다.");
    } finally {
      setCancelling(false);
    }
  }, [userId, weekId, selected, mode, load, onChanged]);

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
      {/* 버튼 영역 — [액트 보완] / [액트 취소] */}
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
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-2 py-2 text-center">
                  <input
                    ref={headerCbRef}
                    type="checkbox"
                    aria-label="취소 가능 액트 전체 선택"
                    checked={allSelected}
                    disabled={!editable || cancellableIds.length === 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="whitespace-nowrap px-2 py-2 text-left">결과</th>
                <th className="whitespace-nowrap px-2 py-2 text-left">액트명</th>
                <th className="whitespace-nowrap px-2 py-2 text-left">발생 시점</th>
                <th className="whitespace-nowrap px-2 py-2 text-left">소속 허브</th>
                <th className="whitespace-nowrap px-2 py-2 text-left">소속 라인</th>
                <th className="whitespace-nowrap px-2 py-2 text-right">소요 시간</th>
                <th className="whitespace-nowrap px-2 py-2 text-right">{poLabels.a}</th>
                <th className="whitespace-nowrap px-2 py-2 text-right">{poLabels.b}</th>
                <th className="whitespace-nowrap px-2 py-2 text-right">{poLabels.c}</th>
                <th className="whitespace-nowrap px-2 py-2 text-center">구분</th>
                <th className="whitespace-nowrap px-2 py-2 text-center">종류</th>
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
              <Button type="button" size="sm" loading={cancelling} disabled={cancelling} onClick={doCancel}>
                액트 취소
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
    <tr className={cn("border-b last:border-0", row.cancelled && "opacity-50")}>
      <td className="px-2 py-2 text-center">
        <input
          type="checkbox"
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
      <td className={cn("max-w-[220px] truncate px-2 py-2", row.cancelled && "line-through")} title={row.actName}>
        {row.actName}
      </td>
      <td className="whitespace-nowrap px-2 py-2">
        {formatAdminDateTime(row.occurredAt, { withSeconds: false })}
      </td>
      <td className="max-w-[120px] truncate px-2 py-2" title={row.hubName ?? "-"}>{row.hubName ?? "-"}</td>
      <td className="max-w-[160px] truncate px-2 py-2" title={row.lineName ?? "-"}>{row.lineName ?? "-"}</td>
      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{row.durationMinutes}m</td>
      <td className={cn("whitespace-nowrap px-2 py-2 text-right tabular-nums", pointColorClass("a"))}>{row.pointA}</td>
      <td className={cn("whitespace-nowrap px-2 py-2 text-right tabular-nums", pointColorClass("b"))}>{row.pointB}</td>
      <td className={cn("whitespace-nowrap px-2 py-2 text-right tabular-nums", pointColorClass("c"))}>
        {row.pointC > 0 ? `-${row.pointC}` : 0}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-center">{row.actKindLabel}</td>
      <td className="whitespace-nowrap px-2 py-2 text-center">{row.requirementLabel}</td>
    </tr>
  );
}
