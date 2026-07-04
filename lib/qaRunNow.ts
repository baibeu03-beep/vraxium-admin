// ─────────────────────────────────────────────────────────────────────
// QA "즉시 실행"(run-now) 오케스트레이션 — server-only.
//
// 목적: QA 테스트 기간 동안 "시간이 지나야 도는" 기존 자동 로직을 기다리지 않고 관리자가
//   버튼으로 1회 수동 실행한다. 본 모듈은 **기존 service/function 을 변경 없이 재호출**하는
//   얇은 입구일 뿐이며, 동작은 항상 테스트 사용자/테스트 크루로 fail-closed 스코프된다.
//
//   A1 process_check  : runDueProcessCheckSweep(scope='qa')  — scope_mode='test' 강제(운영 무접촉)
//                       = 기존 POST /api/admin/processes/check/run-due-checks 가 부르는 함수
//   B2 snapshot_batch : recomputeWeeklyCardsSnapshotsForUsers(test_user_markers 전수)
//                       = 기존 GET /api/admin/cluster4/recompute-snapshots 와 동일 재계산 함수(테스트 한정)
//   C5 user_snapshot  : recomputeWeeklyCardsSnapshotsForUsers(선택한 test userIds, fail-closed)
//                       = 기존 POST /api/admin/cluster4/recompute-user-snapshots 가 부르는 함수
//
// qaFixedScope 공존: 본 모듈의 test 한정은 lib/qaFixedScope(QA_HIDE_REAL_USERS 전역 스위치)와
//   독립이다 — 스위치가 켜져 있든 꺼져 있든 run-now 는 항상 test_user_markers 로 자체 fail-closed
//   한다(이중 방어). 두 메커니즘은 충돌하지 않으며 서로의 동작을 바꾸지 않는다.
//
// 불변식(절대 위반 금지):
//   - 자동 스케줄러(GitHub Actions)·lazy 재계산·내부키 라우트는 **건드리지 않는다**. 본 모듈은
//     추가 입구일 뿐 — 버튼을 누르지 않으면 기존 자동 로직은 그대로 동작한다.
//   - 모든 실행은 test 스코프. 실유저는 어떤 경로로도 대상이 되지 않는다(아래 가드).
//   - snapshot-only 조회 구조 불변: 본 모듈은 "쓰기 시점 재계산"만 한다(조회 경로 무변경).
//
// dry-run: 가능한 경우 무변경 미리보기를 먼저 제공한다(대상 식별만, DB write 0).
// 로그: 실행/미리보기 결과를 qa_run_now_log 에 best-effort 기록(테이블 부재/실패 시 무시).
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import {
  runDueProcessCheckSweep,
  findDueProcessCheckItems,
} from "@/lib/processCheckDueSweep";
import { logProcessCheckCompletedForRegular } from "@/lib/adminProcessCheckData";
import {
  recomputeWeeklyCardsSnapshotsForUsers,
  readWeeklyCardsSnapshotBatch,
  type WeeklyCardsSnapshotOutcome,
} from "@/lib/cluster4WeeklyCardsSnapshot";

export type QaRunNowAction = "process_check" | "snapshot_batch" | "user_snapshot";
export type QaRunNowMode = "dry_run" | "execute";
export type QaRunNowOutcome = "success" | "partial" | "failed";

// 테스트 스코프 위반(실유저 혼입) — fail-closed 422.
export class QaRunNowScopeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "QaRunNowScopeError";
    this.status = status;
  }
}

// snapshot 신선도 집계(미리보기/사후 확인 공용). hit=fresh, stale=재계산 필요, miss=행없음, error=조회실패.
type SnapshotFreshness = {
  total: number;
  hit: number;
  staleIsStale: number;
  staleVersionMismatch: number;
  miss: number;
  error: number;
  // 재계산이 필요한(=즉시 실행으로 갱신될) 사용자 수 = stale + miss.
  needsRecompute: number;
};

function tallySnapshotStates(
  ids: string[],
  states: Map<string, WeeklyCardsSnapshotOutcome>,
): SnapshotFreshness {
  const out: SnapshotFreshness = {
    total: ids.length,
    hit: 0,
    staleIsStale: 0,
    staleVersionMismatch: 0,
    miss: 0,
    error: 0,
    needsRecompute: 0,
  };
  for (const id of ids) {
    const s = states.get(id);
    if (!s) {
      out.miss++;
      continue;
    }
    switch (s.status) {
      case "hit":
        out.hit++;
        break;
      case "stale":
        if (s.reason === "version_mismatch") out.staleVersionMismatch++;
        else out.staleIsStale++;
        break;
      case "miss":
        out.miss++;
        break;
      case "error":
        out.error++;
        break;
    }
  }
  out.needsRecompute = out.staleIsStale + out.staleVersionMismatch + out.miss;
  return out;
}

// ── 감사 로그(best-effort) ─────────────────────────────────────────────
//   qa_run_now_log 부재(미적용)·insert 실패 시 조용히 무시한다(버튼 동작을 막지 않음).
export async function logQaRunNow(entry: {
  action: QaRunNowAction;
  mode: QaRunNowMode;
  outcome: QaRunNowOutcome;
  actor: string | null;
  target: unknown;
  result: unknown;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("qa_run_now_log").insert({
      action: entry.action,
      mode: entry.mode,
      scope: "test",
      outcome: entry.outcome,
      actor: entry.actor,
      target: entry.target ?? null,
      result: entry.result ?? null,
    });
    if (error) {
      console.warn("[qaRunNow] audit log insert failed (action kept)", {
        action: entry.action,
        message: error.message,
      });
    }
  } catch (e) {
    console.warn("[qaRunNow] audit log threw (action kept)", {
      action: entry.action,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

export type QaRunNowLogRow = {
  id: number;
  action: QaRunNowAction;
  mode: QaRunNowMode;
  outcome: QaRunNowOutcome;
  actor: string | null;
  target: unknown;
  result: unknown;
  created_at: string;
};

// 최근 run-now 로그(테이블 부재 시 빈 배열 — 화면이 깨지지 않게).
export async function listQaRunNowLogs(limit = 20): Promise<QaRunNowLogRow[]> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const { data, error } = await supabaseAdmin
    .from("qa_run_now_log")
    .select("id,action,mode,outcome,actor,target,result,created_at")
    .order("created_at", { ascending: false })
    .limit(safeLimit);
  if (error) {
    console.warn("[qaRunNow] listQaRunNowLogs failed (returning empty)", {
      message: error.message,
    });
    return [];
  }
  return (data ?? []) as QaRunNowLogRow[];
}

// ── A1: 프로세스 체크 자동검수 sweep 즉시 실행 ─────────────────────────
//   기존 runDueProcessCheckSweep 를 scope='qa' 로 호출 → scope_mode='test' 항목만 강제 처리
//   (운영 항목 절대 무접촉, fail-safe). 완료 시 points/ledger/snapshot 반영을 확인해 반환한다.
export type ProcessCheckNowResult = {
  mode: QaRunNowMode;
  outcome: QaRunNowOutcome;
  cafeCrawlerConfigured: boolean;
  // due 식별(공통) — "지금 검수할 수 있는 체크 대기 항목" 수.
  dueTotal: number;
  dueTest: number;
  testItems: Array<{ id: string; source: string; organizationSlug: string }>;
  // ── 화면 표시용 집계(execute=실제값 / dry_run=대상만) ──
  completedCount: number;   // 이번에 체크 완료로 바뀐 항목 수.
  stillPendingCount: number; // 아직 대기 중인 항목 수(실패·재시도대기·미처리 포함).
  failures: Array<{ organizationSlug: string; error: string }>; // 실패/보류 항목 사유(raw).
  // execute 시에만
  sweep?: {
    due: number;
    eligible: number;
    succeeded: number;
    failed: number;
    capped: number;
  };
  reflection?: {
    matchedTestUserCount: number;
    ledgerAwardCount: number; // process_point_awards 반영 건수(완료된 ref 기준)
    snapshot: SnapshotFreshness; // 완료된 항목의 매칭 테스트 유저 카드 신선도(사후)
  };
};

export async function runProcessCheckNow(opts: {
  dryRun: boolean;
  onlyIds?: string[] | null;
  actor: string | null;
}): Promise<ProcessCheckNowResult> {
  // 현재 시각 = Date.now()(QA 클록 provider 제거 후 단일 기준 — processCheckDueSweep 와 동일).
  const nowIso = new Date(Date.now()).toISOString();
  const onlyIds = opts.onlyIds ?? null;
  const cafeCrawlerConfigured = Boolean(process.env.CAFE_CRAWLER_URL);

  // due 식별(읽기 전용) — 테스트(scope_mode='test') 항목만 집계해 미리보기/검증에 쓴다.
  const due = await findDueProcessCheckItems(nowIso);
  const testDue = due.filter(
    (d) =>
      (d.scope_mode ?? "operating") === "test" &&
      (!onlyIds || onlyIds.includes(d.id)),
  );
  const testItems = testDue.map((d) => ({
    id: d.id,
    source: d.source,
    organizationSlug: d.organization_slug,
  }));

  if (opts.dryRun) {
    const result: ProcessCheckNowResult = {
      mode: "dry_run",
      outcome: "success",
      cafeCrawlerConfigured,
      dueTotal: due.length,
      dueTest: testDue.length,
      testItems,
      completedCount: 0,
      stillPendingCount: testDue.length, // 대상 확인 단계 — 전부 아직 대기 중.
      failures: [],
    };
    await logQaRunNow({
      action: "process_check",
      mode: "dry_run",
      outcome: "success",
      actor: opts.actor,
      target: { onlyIds, dueTest: testDue.length },
      result,
    });
    return result;
  }

  // ── 실제 실행 — 기존 자동검수 함수를 scope='qa' 로 호출(테스트 항목만, 멱등). ──
  const sweep = await runDueProcessCheckSweep({
    scope: "qa", // ← 운영 env 여도 test 항목만 강제 처리 + qa_action_log 기록(fail-safe)
    onlyIds,
    actor: opts.actor,
    log: (m) => console.log(`[qa-run-now][process-check] ${m}`),
  });

  // 반영 확인: 이번에 완료된 항목의 매칭 테스트 유저 → ledger/snapshot 반영 여부.
  const completedRefIds = sweep.items
    .filter((it) => it.outcome === "completed")
    .map((it) => it.id);
  const reflection = await summarizeProcessCheckReflection(completedRefIds);

  const outcome: QaRunNowOutcome =
    sweep.failed > 0 ? (sweep.succeeded > 0 ? "partial" : "failed") : "success";

  // 실패/보류 항목 사유(raw error) — 화면에서 사용자 친화 메시지로 매핑한다.
  const failures = sweep.items
    .filter((it): it is Extract<typeof it, { outcome: "failed" }> => it.outcome === "failed")
    .map((it) => ({ organizationSlug: it.organizationSlug, error: it.error }));
  // 아직 대기 중 = 검수 대상(테스트 due) − 이번에 완료. 실패·재시도대기·미처리(capped) 포함.
  const stillPendingCount = Math.max(0, testDue.length - sweep.succeeded);

  const result: ProcessCheckNowResult = {
    mode: "execute",
    outcome,
    cafeCrawlerConfigured,
    dueTotal: due.length,
    dueTest: testDue.length,
    testItems,
    completedCount: sweep.succeeded,
    stillPendingCount,
    failures,
    sweep: {
      due: sweep.due,
      eligible: sweep.eligible,
      succeeded: sweep.succeeded,
      failed: sweep.failed,
      capped: sweep.capped,
    },
    reflection,
  };

  await logQaRunNow({
    action: "process_check",
    mode: "execute",
    outcome,
    actor: opts.actor,
    target: { onlyIds, dueTest: testDue.length, completedRefIds },
    result,
  });
  return result;
}

// 완료된 ref_id 들의 매칭 테스트 유저에 대해 ledger(process_point_awards) + snapshot 반영을 요약.
//   읽기 전용. 실패는 격리(부분 결과 반환). matched user 가 없으면 0 집계.
async function summarizeProcessCheckReflection(
  completedRefIds: string[],
): Promise<ProcessCheckNowResult["reflection"]> {
  const empty = {
    matchedTestUserCount: 0,
    ledgerAwardCount: 0,
    snapshot: tallySnapshotStates([], new Map()),
  };
  if (completedRefIds.length === 0) return empty;

  // 1) 매칭된 사용자(match_type='matched') 수집.
  const matchedUserIds = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < completedRefIds.length; i += CHUNK) {
    const chunk = completedRefIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("process_check_review_recipients")
      .select("user_id,match_type")
      .in("ref_id", chunk)
      .eq("match_type", "matched");
    if (error) {
      console.warn("[qaRunNow] reflection recipients read failed", {
        message: error.message,
      });
      continue;
    }
    for (const r of (data ?? []) as { user_id: string | null }[]) {
      if (r.user_id) matchedUserIds.add(r.user_id);
    }
  }

  // 2) ledger 반영 건수(process_point_awards) — 완료 ref 기준.
  let ledgerAwardCount = 0;
  for (let i = 0; i < completedRefIds.length; i += CHUNK) {
    const chunk = completedRefIds.slice(i, i + CHUNK);
    const { count, error } = await supabaseAdmin
      .from("process_point_awards")
      .select("*", { count: "exact", head: true })
      .in("ref_id", chunk);
    if (error) {
      console.warn("[qaRunNow] reflection awards count failed", {
        message: error.message,
      });
      continue;
    }
    ledgerAwardCount += count ?? 0;
  }

  // 3) snapshot 신선도(사후) — 매칭 유저 카드가 갱신됐는지.
  const ids = Array.from(matchedUserIds);
  const states = await readWeeklyCardsSnapshotBatch(ids);
  return {
    matchedTestUserCount: ids.length,
    ledgerAwardCount,
    snapshot: tallySnapshotStates(ids, states),
  };
}

// ── A1(행 단위): 한 '체크 대기' 행을 즉시 검수 ─────────────────────────
//   보드 행 id 를 받아 그 한 건만 검수한다. scheduled_check_at·재시도 게이트를 우회해(즉시 실행)
//   기존 runDueProcessCheckSweep 로 실제 크롤/식별/적립을 태운다. 테스트 항목만(scope='qa').
//
//   ⚠ 즉시 검수 정책(요구): 크롤 결과와 무관하게 **항상 '체크 완료'** 로 만든다(검수 프로세스가
//     끝났으므로). sweep 이 크롤 성공 시 이미 완료하고, 크롤 실패(못 읽음) 등으로 완료하지 못한
//     경우엔 여기서 **강제 완료**한다. 자동 sweep 함수 자체는 무변경 — 이 wrapper 에서만 강제 완료
//     하므로 기존 자동 검수 스케줄은 기존 정책(크롤 실패 시 대기 유지) 그대로다.
//
//   결과 code(모두 체크 완료 — 메시지 구분용):
//     confirmed → 매칭된 크루 발견(인증 내용을 확인했습니다).
//     no_match  → 댓글은 있었지만 대상자 미매칭(인증 댓글은 있었지만 대상자를 찾지 못했습니다).
//     not_found → 댓글 없음/카페 못 읽음(인증 내용을 찾지 못했습니다).
export type ProcessCheckRowNowCode = "confirmed" | "no_match" | "not_found";
export type ProcessCheckRowNowResult = {
  status?: "pending" | "completed" | "not_found";
  source?: "regular" | "irregular";
  statusId?: string;
  completedAt?: string | null;
  ok: boolean; // 체크 완료로 처리됐는가(정상 경로면 항상 true).
  code: ProcessCheckRowNowCode; // 크롤 결과(메시지 매핑용).
};

export async function runProcessCheckRowNow(opts: {
  statusId: string;
  actor: string | null;
  // 정규(process_check_statuses) / 변동(process_irregular_acts) 행 구분. 미지정=정규.
  source?: "regular" | "irregular";
}): Promise<ProcessCheckRowNowResult> {
  const statusId = String(opts.statusId ?? "").trim();
  const source = opts.source === "irregular" ? "irregular" : "regular";
  const table = source === "irregular" ? "process_irregular_acts" : "process_check_statuses";

  const finish = async (
    res: ProcessCheckRowNowResult,
  ): Promise<ProcessCheckRowNowResult> => {
    await logQaRunNow({
      action: "process_check",
      mode: "execute",
      outcome: res.ok ? "success" : "failed",
      actor: opts.actor,
      target: { statusId, source, row: true },
      result: res,
    });
    return res;
  };

  if (!statusId) return finish({ ok: false, code: "not_found", status: "not_found", source, statusId });

  // 1) 실제 크롤/검수 — 기존 sweep 로직(scope='qa' test 한정) + 시각/재시도 게이트 우회.
  //    크롤 성공 시 sweep 이 recipients 기록 + status='completed' 로 만든다(0명이어도 완료).
  const sweep = await runDueProcessCheckSweep({
    scope: "qa",
    onlyIds: [statusId],
    ignoreSchedule: true,
    ignoreRetryGate: true,
    actor: opts.actor,
    log: (m) => console.log(`[qa-run-now][row] ${m}`),
  }).catch((e) => {
    // 크롤 예외(카페 못 읽음)여도 아래에서 강제 완료한다 — 결과는 not_found 메시지.
    console.warn("[qa-run-now][row] sweep threw (will force-complete)", {
      statusId,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  });
  const item = sweep?.items.find((it) => it.id === statusId);
  const matched = item && item.outcome === "completed" ? item.matched : 0;
  const review = item && item.outcome === "completed" ? item.review : 0;

  // 2) 항상 체크 완료 — sweep 이 완료하지 못한(크롤 실패 등) 경우 여기서 강제 완료(pending → completed).
  //    운영 행 보호(fail-closed): scope='qa' sweep 과 동일하게 **테스트 행만** 강제 완료한다. 운영
  //    (scope_mode!=='test') 행이 어떤 경로로 들어와도 상태를 바꾸지 않는다(UI 상 버튼도 테스트 행만 노출).
  const { data: after } = await supabaseAdmin
    .from(table)
    .select("status,scope_mode,completed_at")
    .eq("id", statusId)
    .maybeSingle();
  if (!after) {
    return finish({ ok: false, code: "not_found", status: "not_found", source, statusId });
  }
  if (after.status !== "completed") {
    const completedAt = new Date().toISOString();
    const upd: Record<string, unknown> = {
      status: "completed",
      completed_at: completedAt,
    };
    // checked_crew_count 는 정규 테이블에만 있는 컬럼.
    if (source === "regular") upd.checked_crew_count = matched;
    await supabaseAdmin.from(table).update(upd).eq("id", statusId).eq("status", "pending");
  }

  const { data: finalRow } = await supabaseAdmin
    .from(table)
    .select("status,completed_at")
    .eq("id", statusId)
    .maybeSingle();
  const finalStatus = finalRow?.status === "completed" ? "completed" : "pending";
  if (source === "regular" && finalStatus === "completed") {
    // 즉시 검수는 운영자 버튼 클릭 — 완료 로그 actor_name 은 실제 관리자(자동 검수 아님).
    await logProcessCheckCompletedForRegular(statusId, { adminId: opts.actor ?? null });
  }

  // 3) 메시지 code — 모두 체크 완료. 크롤 결과만 구분.
  const code: ProcessCheckRowNowCode =
    matched > 0 ? "confirmed" : review > 0 ? "no_match" : "not_found";
  return finish({
    ok: finalStatus === "completed",
    code,
    status: finalStatus,
    source,
    statusId,
    completedAt: finalRow?.completed_at ?? null,
  });
}

// ── B2: weekly-cards snapshot 배치 재계산 즉시 실행(테스트 유저 전수) ───
//   기존 recomputeWeeklyCardsSnapshotsForUsers 를 test_user_markers 전수로 호출.
//   운영 전원 재계산은 하지 않는다(테스트 한정) — recompute-snapshots 의 테스트 스코프판.
export type SnapshotBatchNowResult = {
  mode: QaRunNowMode;
  outcome: QaRunNowOutcome;
  testUserCount: number;
  before: SnapshotFreshness;
  after?: SnapshotFreshness;
  recompute?: { requested: number; recomputed: number; failed: number; failedUserIds: string[] };
};

export async function runSnapshotBatchNow(opts: {
  dryRun: boolean;
  actor: string | null;
}): Promise<SnapshotBatchNowResult> {
  const testIds = Array.from(await fetchTestUserMarkerIds());
  const before = tallySnapshotStates(
    testIds,
    await readWeeklyCardsSnapshotBatch(testIds),
  );

  if (opts.dryRun) {
    const result: SnapshotBatchNowResult = {
      mode: "dry_run",
      outcome: "success",
      testUserCount: testIds.length,
      before,
    };
    await logQaRunNow({
      action: "snapshot_batch",
      mode: "dry_run",
      outcome: "success",
      actor: opts.actor,
      target: { testUserCount: testIds.length },
      result,
    });
    return result;
  }

  const recompute = await recomputeWeeklyCardsSnapshotsForUsers(testIds, {
    concurrency: 3,
  });
  const after = tallySnapshotStates(
    testIds,
    await readWeeklyCardsSnapshotBatch(testIds),
  );
  const outcome: QaRunNowOutcome =
    recompute.failed > 0
      ? recompute.recomputed > 0
        ? "partial"
        : "failed"
      : "success";

  const result: SnapshotBatchNowResult = {
    mode: "execute",
    outcome,
    testUserCount: testIds.length,
    before,
    after,
    recompute: {
      requested: recompute.requested,
      recomputed: recompute.recomputed,
      failed: recompute.failed,
      failedUserIds: recompute.failedUserIds,
    },
  };
  await logQaRunNow({
    action: "snapshot_batch",
    mode: "execute",
    outcome,
    actor: opts.actor,
    target: { testUserCount: testIds.length },
    result,
  });
  return result;
}

// ── C5: 특정 테스트 사용자 snapshot 재계산 즉시 실행 ───────────────────
//   선택한 userIds 가 **전원 test_user_markers** 일 때만 실행(하나라도 실유저면 422 fail-closed).
export type UserSnapshotNowResult = {
  mode: QaRunNowMode;
  outcome: QaRunNowOutcome;
  requestedUserIds: string[];
  before: SnapshotFreshness;
  after?: SnapshotFreshness;
  recompute?: { requested: number; recomputed: number; failed: number; failedUserIds: string[] };
};

export async function runUserSnapshotNow(opts: {
  userIds: string[];
  dryRun: boolean;
  actor: string | null;
}): Promise<UserSnapshotNowResult> {
  const ids = Array.from(
    new Set(
      opts.userIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  );
  if (ids.length === 0) {
    throw new QaRunNowScopeError(400, "userIds 가 비어 있습니다.");
  }

  // ── fail-closed 테스트 스코프 가드 — 실유저가 단 1명이라도 있으면 전체 거절(write 0). ──
  const testIds = await fetchTestUserMarkerIds();
  const offenders = ids.filter((id) => !testIds.has(id));
  if (offenders.length > 0) {
    throw new QaRunNowScopeError(
      422,
      `테스트 사용자만 대상입니다 — 실유저/미등록 ${offenders.length}명 포함(test_user_markers 미등재). 실행 차단.`,
    );
  }

  const before = tallySnapshotStates(ids, await readWeeklyCardsSnapshotBatch(ids));

  if (opts.dryRun) {
    const result: UserSnapshotNowResult = {
      mode: "dry_run",
      outcome: "success",
      requestedUserIds: ids,
      before,
    };
    await logQaRunNow({
      action: "user_snapshot",
      mode: "dry_run",
      outcome: "success",
      actor: opts.actor,
      target: { userIds: ids },
      result,
    });
    return result;
  }

  const recompute = await recomputeWeeklyCardsSnapshotsForUsers(ids, {
    concurrency: 3,
  });
  const after = tallySnapshotStates(ids, await readWeeklyCardsSnapshotBatch(ids));
  const outcome: QaRunNowOutcome =
    recompute.failed > 0
      ? recompute.recomputed > 0
        ? "partial"
        : "failed"
      : "success";

  const result: UserSnapshotNowResult = {
    mode: "execute",
    outcome,
    requestedUserIds: ids,
    before,
    after,
    recompute: {
      requested: recompute.requested,
      recomputed: recompute.recomputed,
      failed: recompute.failed,
      failedUserIds: recompute.failedUserIds,
    },
  };
  await logQaRunNow({
    action: "user_snapshot",
    mode: "execute",
    outcome,
    actor: opts.actor,
    target: { userIds: ids },
    result,
  });
  return result;
}
