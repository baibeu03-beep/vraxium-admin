"use client";

// QA 즉시 실행(B2 + C5) — weekly-cards snapshot 재계산 패널 2종.
//   테스트 모드 페이지에 삽입. 모두 test 스코프(B2=test 전수, C5=선택한 test userIds).
//   B2: POST /api/admin/qa/run-now/snapshot-batch
//   C5: POST /api/admin/qa/run-now/user-snapshot
//   조회(snapshot-only) 구조·자동 lazy 재계산·내부키 라우트는 무변경 — 쓰기 시점 재계산만 추가.

import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ConfirmModal,
  FreshnessLine,
  OutcomeBadge,
  QaRunNowLogList,
  ResultView,
  useRunNow,
  type RunOutcome,
  type SnapshotFreshness,
} from "@/components/admin/QaRunNowShared";

type RecomputeStat = {
  requested: number;
  recomputed: number;
  failed: number;
  failedUserIds: string[];
};

type BatchResult = {
  mode: "dry_run" | "execute";
  outcome: RunOutcome;
  testUserCount: number;
  before: SnapshotFreshness;
  after?: SnapshotFreshness;
  recompute?: RecomputeStat;
};

type UserResult = {
  mode: "dry_run" | "execute";
  outcome: RunOutcome;
  requestedUserIds: string[];
  before: SnapshotFreshness;
  after?: SnapshotFreshness;
  recompute?: RecomputeStat;
};

type TestUserRow = {
  userId: string;
  name: string;
  organizationName: string | null;
  teamName: string | null;
};

// ─── B2: 테스트 유저 전수 snapshot 배치 재계산 ─────────────────────────
function SnapshotBatchPanel() {
  const { run, busy, result, error, ranAt } = useRunNow<BatchResult>(
    "/api/admin/qa/run-now/snapshot-batch",
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [logKey, setLogKey] = useState(0);

  const runDry = async () => {
    if (await run({ mode: "dry_run" })) setLogKey((n) => n + 1);
  };
  const runExec = async () => {
    const ok = await run({ mode: "execute" });
    setConfirmOpen(false);
    if (ok) setLogKey((n) => n + 1);
  };

  const r = result;
  const summary =
    r == null ? null : (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <OutcomeBadge outcome={r.outcome} />
          <span className="text-muted-foreground">
            {r.mode === "execute" ? "재계산 완료" : "미리보기"} · 테스트 유저 {r.testUserCount}명
          </span>
        </div>
        <FreshnessLine label="실행 전" f={r.before} />
        {r.after && <FreshnessLine label="실행 후" f={r.after} />}
        {r.recompute && (
          <div className="text-xs text-muted-foreground tabular-nums">
            재계산: 요청 {r.recompute.requested} · 성공 {r.recompute.recomputed} · 실패{" "}
            {r.recompute.failed}
          </div>
        )}
      </div>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          [QA] snapshot 배치 재계산 (테스트 전수)
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
            테스트 한정
          </span>
        </CardTitle>
        <CardDescription>
          <b>테스트 사용자 전원</b>의 주차 카드 snapshot 을 지금 재계산합니다(stale/miss 즉시
          수렴). 운영 사용자는 대상이 아니며, 조회 경로(snapshot-only)와 자동 lazy 재계산은 그대로
          동작합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={runDry} disabled={busy}>
            {busy ? "확인 중…" : "미리보기 (변경 없음)"}
          </Button>
          <Button onClick={() => setConfirmOpen(true)} disabled={busy}>
            지금 재계산 (테스트 전수)
          </Button>
        </div>
        <ResultView result={result} error={error} summary={summary} />
        <QaRunNowLogList action="snapshot_batch" refreshKey={logKey + ranAt} />
      </CardContent>

      <ConfirmModal
        open={confirmOpen}
        title="테스트 유저 snapshot 전수 재계산"
        confirmLabel="재계산"
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={runExec}
        body={
          <p>
            test_user_markers 에 등재된 <b>모든 테스트 사용자</b>의 주차 카드 snapshot 을 지금
            재계산합니다. 멱등 — 여러 번 실행해도 안전합니다.
          </p>
        }
      />
    </Card>
  );
}

// ─── C5: 선택한 테스트 유저 snapshot 재계산 ───────────────────────────
function UserSnapshotPanel() {
  const { run, busy, result, error, ranAt } = useRunNow<UserResult>(
    "/api/admin/qa/run-now/user-snapshot",
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [logKey, setLogKey] = useState(0);

  const [users, setUsers] = useState<TestUserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setUsersLoading(true);
      try {
        const res = await fetch("/api/admin/test-users", { cache: "no-store" });
        const json = await res.json();
        if (!cancelled && json.success) {
          setUsers(
            (json.data ?? []).map((u: TestUserRow) => ({
              userId: u.userId,
              name: u.name,
              organizationName: u.organizationName,
              teamName: u.teamName,
            })),
          );
        }
      } catch {
        // 목록 로드 실패는 무시(선택 불가 상태로 표시).
      } finally {
        if (!cancelled) setUsersLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setSelected(new Set(users.map((u) => u.userId)));
  const clearAll = () => setSelected(new Set());

  const runDry = async () => {
    if (selectedIds.length === 0) return;
    if (await run({ mode: "dry_run", userIds: selectedIds })) setLogKey((n) => n + 1);
  };
  const runExec = async () => {
    const ok = await run({ mode: "execute", userIds: selectedIds });
    setConfirmOpen(false);
    if (ok) setLogKey((n) => n + 1);
  };

  const r = result;
  const summary =
    r == null ? null : (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <OutcomeBadge outcome={r.outcome} />
          <span className="text-muted-foreground">
            {r.mode === "execute" ? "재계산 완료" : "미리보기"} · 대상{" "}
            {r.requestedUserIds.length}명
          </span>
        </div>
        <FreshnessLine label="실행 전" f={r.before} />
        {r.after && <FreshnessLine label="실행 후" f={r.after} />}
        {r.recompute && (
          <div className="text-xs text-muted-foreground tabular-nums">
            재계산: 성공 {r.recompute.recomputed} · 실패 {r.recompute.failed}
          </div>
        )}
      </div>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          [QA] 선택한 테스트 유저 snapshot 재계산
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
            테스트 한정
          </span>
        </CardTitle>
        <CardDescription>
          선택한 <b>테스트 사용자</b>의 주차 카드 snapshot 만 즉시 재계산합니다. 실유저가
          섞이면 서버에서 전체가 거절됩니다(fail-closed). 카드/랭킹/목록 반영을 빠르게 확인할 때
          사용하세요.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {usersLoading ? "테스트 유저 로딩…" : `선택 ${selected.size} / ${users.length}명`}
          </span>
          <span className="flex gap-2">
            <Button variant="outline" size="sm" onClick={selectAll} disabled={busy || usersLoading}>
              전체 선택
            </Button>
            <Button variant="outline" size="sm" onClick={clearAll} disabled={busy || usersLoading}>
              선택 해제
            </Button>
          </span>
        </div>

        <div className="max-h-56 overflow-auto rounded-md border">
          {users.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              {usersLoading ? "로딩 중…" : "테스트 유저가 없습니다."}
            </div>
          ) : (
            <ul className="divide-y text-sm">
              {users.map((u) => (
                <li key={u.userId}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-muted/40">
                    <input
                      type="checkbox"
                      checked={selected.has(u.userId)}
                      onChange={() => toggle(u.userId)}
                      disabled={busy}
                    />
                    <span className="font-medium">{u.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {[u.organizationName, u.teamName].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={runDry}
            disabled={busy || selectedIds.length === 0}
          >
            {busy ? "확인 중…" : "미리보기 (변경 없음)"}
          </Button>
          <Button onClick={() => setConfirmOpen(true)} disabled={busy || selectedIds.length === 0}>
            선택 재계산
          </Button>
        </div>

        <ResultView result={result} error={error} summary={summary} />
        <QaRunNowLogList action="user_snapshot" refreshKey={logKey + ranAt} />
      </CardContent>

      <ConfirmModal
        open={confirmOpen}
        title="선택한 테스트 유저 snapshot 재계산"
        confirmLabel="재계산"
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={runExec}
        body={
          <p>
            선택한 <b>{selectedIds.length}명</b>의 주차 카드 snapshot 을 재계산합니다. 실유저가
            포함되면 전체가 거절됩니다(test_user_markers 검증). 멱등.
          </p>
        }
      />
    </Card>
  );
}

export default function QaRunNowSnapshotPanels() {
  return (
    <div className="flex flex-col gap-4">
      <SnapshotBatchPanel />
      <UserSnapshotPanel />
    </div>
  );
}
