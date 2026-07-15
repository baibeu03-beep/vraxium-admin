"use client";

// 강화 상태 수동 수정 모달 — 크루 상세 "클럽 결과(주차)" 표의 [수정] 에서 연다.
//   그 주차 라인들의 [자동 계산] / [수동 설정] / [최종 표시] 를 함께 보여주고, 관리자가
//   강화 성공/실패/대기/제외 로 강제하거나 "자동으로 되돌리기"로 자동 계산값에 복귀시킨다.
//   내부적으로는 read-time overlay(고객 조회 시점에만 덧씌움)이며 snapshot/계산을 바꾸지 않는다.
//   ⚠ 관리자 화면 문구에는 "오버라이드" 표현을 쓰지 않는다(용어: "강화 상태 수동 수정").

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { useActionToast } from "@/lib/actionToast";
import { cn } from "@/lib/utils";
import type {
  Cluster4EnhancementStatus,
  Cluster4LinePartType,
} from "@/shared/cluster4.contracts";

type FlatLine = {
  weekId: string;
  weekNumber: number;
  weekLabel: string;
  seasonKey: string | null;
  partType: Cluster4LinePartType;
  lineTargetId: string | null;
  lineId: string | null;
  lineCode: string | null;
  ordinal: number;
  experienceSlotOrder: number | null;
  label: string;
  autoEnhancementStatus: Cluster4EnhancementStatus;
  autoEnhancementReason: string;
  canOverride: boolean;
};

type OverrideRow = {
  id: string;
  user_id: string;
  week_id: string;
  part_type: string;
  line_target_id: string | null;
  line_id: string | null;
  line_code: string | null;
  line_ordinal: number | null;
  override_status: Cluster4EnhancementStatus;
  source: string;
  note: string | null;
};

const PART_LABEL: Record<Cluster4LinePartType, string> = {
  information: "실무 정보",
  experience: "실무 경험",
  competency: "실무 역량",
  career: "실무 경력",
};

// 허브 표시 순서(고정): 실무 정보 → 실무 경험 → 실무 역량 → 실무 경력.
//   DB/API 응답 순서에 의존하지 않고 여기서 명시적으로 정렬한다(모든 주차·모든 모드 동일).
const PART_ORDER: Record<Cluster4LinePartType, number> = {
  information: 0,
  experience: 1,
  competency: 2,
  career: 3,
};

// 화면 표기용 한글 라벨(요구사항: 강화 성공/실패/대기/제외).
const STATUS_KO: Record<Cluster4EnhancementStatus, string> = {
  success: "강화 성공",
  fail: "강화 실패",
  pending: "강화 대기",
  not_applicable: "강화 제외",
};
const STATUS_TONE: Record<Cluster4EnhancementStatus, string> = {
  success: "bg-emerald-100 text-emerald-800",
  fail: "bg-red-100 text-red-800",
  pending: "bg-amber-100 text-amber-800",
  not_applicable: "bg-muted text-muted-foreground",
};

// select 값: "auto" = 수동 설정 해제(자동 계산값 사용).
type DraftValue = Cluster4EnhancementStatus | "auto";
const OPTIONS: { value: DraftValue; label: string }[] = [
  { value: "auto", label: "자동으로 되돌리기" },
  { value: "success", label: "강화 성공" },
  { value: "fail", label: "강화 실패" },
  { value: "pending", label: "강화 대기" },
  { value: "not_applicable", label: "강화 제외" },
];

function StatusChip({ status }: { status: Cluster4EnhancementStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_TONE[status],
      )}
    >
      {STATUS_KO[status]}
    </span>
  );
}

// 라인 식별 키 — identity(target>id>code) 우선, 없으면 ordinal. GET 라인·override 행 공통.
function matchKey(args: {
  weekId: string;
  partType: string;
  lineTargetId: string | null;
  lineId: string | null;
  lineCode: string | null;
  ordinal: number | null;
}): string {
  const { weekId, partType, lineTargetId, lineId, lineCode, ordinal } = args;
  if (lineTargetId) return `${weekId}|${partType}|t|${lineTargetId}`;
  if (lineId) return `${weekId}|${partType}|i|${lineId}`;
  if (lineCode) return `${weekId}|${partType}|c|${lineCode}`;
  return `${weekId}|${partType}|o|${ordinal}`;
}

export default function EnhancementStatusEditModal({
  userId,
  mode,
  weekId,
  weekName,
  onClose,
}: {
  userId: string;
  mode?: string | null;
  weekId: string;
  weekName: string;
  onClose: () => void;
}) {
  const t = useActionToast();
  const modeQuery = mode ? `&mode=${encodeURIComponent(mode)}` : "";
  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState<FlatLine[]>([]);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const overrideByKey = useMemo(() => {
    const map = new Map<string, OverrideRow>();
    for (const o of overrides) {
      map.set(
        matchKey({
          weekId: o.week_id,
          partType: o.part_type,
          lineTargetId: o.line_target_id,
          lineId: o.line_id,
          lineCode: o.line_code,
          ordinal: o.line_ordinal,
        }),
        o,
      );
    }
    return map;
  }, [overrides]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/cluster4/enhancement-overrides?user_id=${encodeURIComponent(userId)}${modeQuery}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "불러오기에 실패했습니다.");
      }
      const allLines = (json.data?.lines ?? []) as FlatLine[];
      const weekLines = allLines.filter((l) => l.weekId === weekId);
      const allOverrides = (json.data?.overrides ?? []) as OverrideRow[];
      setLines(weekLines);
      setOverrides(allOverrides);
      // draft 초기화(현재 저장된 수동 설정 반영).
      const oMap = new Map<string, OverrideRow>();
      for (const o of allOverrides) {
        oMap.set(
          matchKey({
            weekId: o.week_id,
            partType: o.part_type,
            lineTargetId: o.line_target_id,
            lineId: o.line_id,
            lineCode: o.line_code,
            ordinal: o.line_ordinal,
          }),
          o,
        );
      }
      const nextDrafts: Record<string, DraftValue> = {};
      const nextNotes: Record<string, string> = {};
      for (const l of weekLines) {
        const k = matchKey({ ...l, ordinal: l.ordinal });
        const o = oMap.get(k);
        nextDrafts[k] = o ? o.override_status : "auto";
        nextNotes[k] = o?.note ?? "";
      }
      setDrafts(nextDrafts);
      setNotes(nextNotes);
    } catch (error) {
      console.error("enhancement-overrides load failed", error);
      t.raw("error", "불러오기에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }, [userId, modeQuery, weekId, t]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [load]);

  const saveLine = useCallback(
    async (line: FlatLine) => {
      const key = matchKey({ ...line, ordinal: line.ordinal });
      const draft = drafts[key] ?? "auto";
      const existing = overrideByKey.get(key) ?? null;
      setBusyKey(key);
      let status = 0;
      try {
        if (draft === "auto") {
          if (existing) {
            const res = await fetch(
              `/api/admin/cluster4/enhancement-overrides?id=${encodeURIComponent(existing.id)}${modeQuery}`,
              { method: "DELETE" },
            );
            status = res.status;
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error ?? "해제에 실패했습니다.");
          }
          t.success("reset", "자동 계산값으로 되돌렸습니다.");
        } else {
          const hasIdentity =
            line.lineTargetId != null || line.lineId != null || line.lineCode != null;
          const res = await fetch(`/api/admin/cluster4/enhancement-overrides`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user_id: userId,
              week_id: line.weekId,
              part_type: line.partType,
              line_target_id: line.lineTargetId,
              line_id: line.lineId,
              line_code: line.lineCode,
              // identity 가 없는 placeholder 라인은 ordinal 로 식별.
              line_ordinal: hasIdentity ? undefined : line.ordinal,
              override_status: draft,
              note: notes[key]?.trim() || null,
              mode: mode ?? undefined,
            }),
          });
          status = res.status;
          const json = await res.json();
          if (!res.ok || !json.success) throw new Error(json?.error ?? "저장에 실패했습니다.");
          t.success("save");
        }
        await load();
      } catch (error) {
        console.error("enhancement-override save failed", error);
        t.error("save", status ? { status } : undefined);
      } finally {
        setBusyKey(null);
      }
    },
    [userId, mode, modeQuery, drafts, notes, overrideByKey, load, t],
  );

  // 허브 고정 순서(정보→경험→역량→경력)로 표시 정렬. 같은 허브 안은 원본 ordinal 순.
  //   ⚠ 표시 순서만 바꾸며 각 라인의 ordinal(placeholder 매칭 키)은 원본 값을 그대로 유지한다.
  const sortedLines = useMemo(() => {
    return [...lines].sort((a, b) => {
      const pa = PART_ORDER[a.partType] ?? 99;
      const pb = PART_ORDER[b.partType] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.ordinal - b.ordinal;
    });
  }, [lines]);

  // 표시용 파트별 순번(placeholder 라벨용) — 렌더 중 mutation 없이 미리 계산한다.
  const partIndexByKey = useMemo(() => {
    const counters = new Map<string, number>();
    const out = new Map<string, number>();
    for (const l of sortedLines) {
      const idx = (counters.get(l.partType) ?? 0) + 1;
      counters.set(l.partType, idx);
      out.set(matchKey({ ...l, ordinal: l.ordinal }), idx);
    }
    return out;
  }, [sortedLines]);

  // 표시용 라인 라벨 — 실명이 없으면 "실무 XX · 슬롯 N"(placeholder).
  const displayLabel = (line: FlatLine, indexWithinPart: number): string => {
    const raw = line.label && line.label !== "(라인)" ? line.label : "";
    if (raw) return raw;
    if (line.partType === "experience" && line.experienceSlotOrder != null) {
      return `${PART_LABEL[line.partType]} · 슬롯 ${line.experienceSlotOrder}`;
    }
    return `${PART_LABEL[line.partType]} · ${indexWithinPart}`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busyKey) onClose();
      }}
    >
      <div className="flex max-h-[85vh] modal-w-lg flex-col rounded-xl bg-card shadow-xl ring-1 ring-foreground/10">
        <div className="flex items-start justify-between gap-2 border-b px-5 py-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-base font-semibold">강화 상태 수동 수정</h2>
            <p className="text-xs text-muted-foreground">
              {weekName} · 자동 계산 결과 위에만 적용되며, 저장 즉시 크루 화면에도 동일하게 반영됩니다.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={!!busyKey} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <LoadingState active />
          ) : lines.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
              이 주차에는 강화 상태를 수정할 라인이 없습니다.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {sortedLines.map((line) => {
                  const key = matchKey({ ...line, ordinal: line.ordinal });
                  const existing = overrideByKey.get(key) ?? null;
                  const draft = drafts[key] ?? "auto";
                  const finalStatus: Cluster4EnhancementStatus =
                    draft === "auto" ? line.autoEnhancementStatus : draft;
                  const savedValue: DraftValue = existing ? existing.override_status : "auto";
                  const dirty =
                    draft !== savedValue || (notes[key] ?? "") !== (existing?.note ?? "");
                  const busy = busyKey === key;
                  const idx = partIndexByKey.get(key) ?? 1;
                  return (
                    <div key={key} className="rounded-lg border bg-muted/10 px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                          {PART_LABEL[line.partType]}
                        </span>
                        <span className="text-sm font-medium">{displayLabel(line, idx)}</span>
                        {existing && (
                          <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700">
                            수동 설정됨
                          </span>
                        )}
                      </div>

                      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div className="flex flex-col gap-1">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            자동 계산
                          </div>
                          <StatusChip status={line.autoEnhancementStatus} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            수동 설정
                          </div>
                          <select
                            value={draft}
                            disabled={busy}
                            onChange={(e) =>
                              setDrafts((cur) => ({ ...cur, [key]: e.target.value as DraftValue }))
                            }
                            className="rounded-md border bg-background px-2 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="flex flex-col gap-1">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            최종 표시 {dirty && <span className="text-amber-600">(미저장)</span>}
                          </div>
                          <StatusChip status={finalStatus} />
                        </div>
                      </div>

                      {(draft !== "auto" || existing) && (
                        <div className="mt-2 flex flex-wrap items-end gap-2">
                          <div className="flex flex-1 flex-col gap-1">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              변경 사유 (선택)
                            </div>
                            <Input
                              value={notes[key] ?? ""}
                              disabled={busy || draft === "auto"}
                              maxLength={500}
                              placeholder="예: 소급 인정 처리 — 담당자 확인"
                              onChange={(e) =>
                                setNotes((cur) => ({ ...cur, [key]: e.target.value }))
                              }
                              className="h-8 text-sm"
                            />
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            loading={busy}
                            disabled={!dirty || busy}
                            variant={draft === "auto" ? "outline" : "default"}
                            onClick={() => void saveLine(line)}
                          >
                            {draft === "auto" ? "자동으로 되돌리기" : existing ? "수정 저장" : "저장"}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button type="button" variant="ghost" size="sm" disabled={!!busyKey} onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}
