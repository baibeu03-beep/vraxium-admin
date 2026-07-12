"use client";

// QA 즉시 실행(run-now) 패널 공용 UI — 확인 모달 / 결과 표시 / 로그 목록 / 실행 훅.
//   3개 버튼(A1·B2·C5)이 공유한다. 모든 실행은 서버에서 test 스코프로 fail-closed 되며,
//   본 컴포넌트는 표시/입구일 뿐 — 자동 로직을 직접 호출하지 않는다.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type RunOutcome = "success" | "partial" | "failed";

type ApiEnvelope<T> = { success: boolean; data?: T; error?: string | null };

// ── 실행 훅 — 중복 클릭 방지(busy) + 성공/실패 결과 보존 ──────────────────
//   busy 동안 모든 버튼을 disabled 로 두고, in-flight ref 로 더블-서밋도 차단한다.
export function useRunNow<T = unknown>(endpoint: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ranAt, setRanAt] = useState<number>(0);
  const inFlight = useRef(false);

  const run = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      if (inFlight.current) return false; // 중복 클릭 가드(상태 업데이트 경합 방지)
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as ApiEnvelope<T>;
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "실행에 실패했습니다.");
        }
        setResult((json.data ?? null) as T | null);
        setRanAt(Date.now());
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "실행에 실패했습니다.");
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [endpoint],
  );

  return { run, busy, result, error, ranAt };
}

// (확인 모달은 공통 adminDialog.confirm 로 대체됨 — components/ui/admin-dialog.tsx)

const OUTCOME_META: Record<RunOutcome, { label: string; className: string }> = {
  success: { label: "성공", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  partial: { label: "부분 성공", className: "border-amber-200 bg-amber-50 text-amber-800" },
  failed: { label: "실패", className: "border-red-200 bg-red-50 text-red-700" },
};

export function OutcomeBadge({ outcome }: { outcome: RunOutcome }) {
  const meta = OUTCOME_META[outcome] ?? OUTCOME_META.failed;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

// ── 결과 표시 — 요약 라인 + 원본 JSON(접기). ───────────────────────────
export function ResultView({
  result,
  error,
  summary,
}: {
  result: unknown;
  error: string | null;
  summary?: React.ReactNode;
}) {
  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (result == null) return null;
  return (
    <div className="flex flex-col gap-2">
      {summary && <div className="text-sm">{summary}</div>}
      <details className="rounded-md border bg-muted/30">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
          원본 응답(JSON) 보기
        </summary>
        <pre className="max-h-72 overflow-auto px-3 pb-3 text-[11px] leading-relaxed">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}

// snapshot 신선도 요약 객체(서버 SnapshotFreshness 미러).
export type SnapshotFreshness = {
  total: number;
  hit: number;
  staleIsStale: number;
  staleVersionMismatch: number;
  miss: number;
  error: number;
  needsRecompute: number;
};

export function FreshnessLine({ label, f }: { label: string; f?: SnapshotFreshness | null }) {
  if (!f) return null;
  return (
    <div className="text-xs text-muted-foreground tabular-nums">
      {label}: 전체 {f.total} · 최신 {f.hit} · 재계산필요 {f.needsRecompute}
      {f.error > 0 ? ` · 조회실패 ${f.error}` : ""}
    </div>
  );
}

// ── 로그 목록 — qa_run_now_log 최근 N건(action 필터). ──────────────────
type QaRunNowLogRow = {
  id: number;
  action: string;
  mode: string;
  outcome: RunOutcome;
  actor: string | null;
  created_at: string;
};

export function QaRunNowLogList({
  action,
  refreshKey,
}: {
  action: string;
  refreshKey: number;
}) {
  const [rows, setRows] = useState<QaRunNowLogRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/qa/run-now/logs?limit=50", {
          cache: "no-store",
        });
        const json = (await res.json()) as ApiEnvelope<QaRunNowLogRow[]>;
        if (!cancelled && json.success) {
          setRows((json.data ?? []).filter((r) => r.action === action).slice(0, 10));
        }
      } catch {
        // 로그 조회 실패는 조용히 무시(패널 본 기능과 무관).
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [action, refreshKey]);

  return (
    <div className="rounded-md border">
      <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
        최근 실행 로그 {loading ? "…" : `(${rows.length})`}
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">기록 없음</div>
      ) : (
        <ul className="divide-y text-xs">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="flex items-center gap-2">
                <OutcomeBadge outcome={r.outcome} />
                <span className="text-muted-foreground">
                  {r.mode === "execute" ? "실행" : "미리보기"}
                </span>
                <span className="text-muted-foreground">{r.actor ?? "—"}</span>
              </span>
              <span className="tabular-nums text-muted-foreground">
                {new Date(r.created_at).toLocaleString("ko-KR", { hour12: false })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
