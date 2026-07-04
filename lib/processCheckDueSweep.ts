// 프로세스 체크 자동 검수 sweep — 서버 인프로세스(canonical TS) 구현.
//
//   검수 시점(scheduled_check_at)이 도래한 [체크 신청] 항목을 일괄 처리한다:
//     크롤링(외부 크롤러 서비스/로컬 폴백) → 크루 식별(org+mode 스코프) →
//     결과 저장(process_check_review_recipients) + status='completed' + 포인트 적립.
//
//   대상:
//     · 정규  : process_check_statuses (status='pending' · scheduled_check_at<=now · review_link)
//     · 변동  : process_irregular_acts (kind='review_request' · status='pending' · scheduled<=now · review_link)
//
//   이 모듈은 `scripts/process-check-worker.mjs`(로컬 PC 워커·백업)의 runOnce 와 "동일 의미"를
//   서버에서 돌릴 수 있게 TS 로 옮긴 것이다. 차이는 I/O 경유 방식뿐(워커=HTTP self-call,
//   여기=인프로세스 lib 직접 호출). 재시도/쿨다운/스코프 가드/멱등 적립 정책은 동일하게 유지한다.
//   호출: /api/admin/processes/check/run-due-checks (내부 키) ← 외부 스케줄러 5~10분.
//
//   멱등성:
//     · findDue 는 status='pending' 만 조회 → 완료된 행은 재폴링되지 않는다.
//     · 적립(accrueForCompletedAct)은 원장(process_point_awards) UNIQUE(source,ref_id,user_id)
//       upsert + 합산 재계산이라, 같은 항목을 여러 번 처리해도 포인트가 중복되지 않는다.
//     · recipients 는 (source,ref_id) delete 후 재삽입 → 수렴(중복 누적 없음).
//   ⚠ snapshot/user_weekly_points 변경은 "적립 lib" 내부에서만 일어난다(여기서 직접 건드리지 않음).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchCafeNicknames } from "@/lib/cafeCrawlerClient";
import {
  loadCrewRecords,
  matchCafeComments,
} from "@/lib/cluster4CafeLineMatch";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";
import { isOrganizationSlug } from "@/lib/organizations";
import { accrueForCompletedAct, type AccrualSource } from "@/lib/processPointAccrual";
import { logProcessCheckCompletedForRegular } from "@/lib/adminProcessCheckData";
import { type StateScope, logQaAction } from "@/lib/operationalState";

// 워커와 동일 env 이름으로 재시도/쿨다운 정책을 공유한다(동작 일치).
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS ?? 5);
const COOLDOWN_MS = Number(process.env.WORKER_COOLDOWN_MS ?? 600_000);
// 한 번의 sweep 에서 처리할 최대 항목 수(serverless 타임아웃 보호). 초과분은 다음 폴링에 catch-up.
const DEFAULT_MAX_ITEMS = Number(process.env.PROCESS_CHECK_SWEEP_MAX_ITEMS ?? 25);

export type SweepMatched = { userId: string | null; nickname: string | null; reason?: string | null };
export type SweepReview = { nickname: string | null; reason?: string | null };
export type SweepCrawlAndMatch = (
  org: string,
  mode: string,
  url: string,
) => Promise<{ matched: SweepMatched[]; review: SweepReview[] }>;
export type SweepAccrue = (source: AccrualSource, refId: string) => Promise<unknown>;

type DueItem = {
  id: string;
  organization_slug: string;
  scope_mode: string | null;
  review_link: string | null;
  attempt_count: number | null;
  last_attempt_at: string | null;
  source: AccrualSource;
  table: "process_check_statuses" | "process_irregular_acts";
};

export type SweepItemResult =
  | {
      id: string;
      source: AccrualSource;
      organizationSlug: string;
      mode: ScopeMode;
      outcome: "completed";
      matched: number;
      review: number;
      accrued: number | null; // 적립된 user 수(스킵/실패 시 null)
      accrualSkippedReason?: string;
    }
  | {
      id: string;
      source: AccrualSource;
      organizationSlug: string;
      mode: ScopeMode;
      outcome: "failed";
      attempt: number;
      error: string;
    };

export type SweepResult = {
  due: number;
  eligible: number;
  succeeded: number;
  failed: number;
  capped: number; // maxItems 로 이번에 미룬(다음 폴링) 항목 수
  items: SweepItemResult[];
};

// ── 만기 항목 조회(정규+변동) — 워커 findDueItems 와 동일 조건 ───────────────────
//   ignoreSchedule=true 면 scheduled_check_at 게이트를 생략한다(검수 예정 시각 전이라도 후보).
//   기본(false)은 자동 스케줄과 동일(시각 도래 항목만) — 옵션 미지정 시 동작 바이트 동일.
export async function findDueProcessCheckItems(
  nowIso: string,
  opts: { ignoreSchedule?: boolean } = {},
): Promise<DueItem[]> {
  const sel = "id,organization_slug,scope_mode,review_link,attempt_count,last_attempt_at";
  let regQ = supabaseAdmin
    .from("process_check_statuses")
    .select(sel)
    .eq("status", "pending")
    .not("review_link", "is", null);
  let irrQ = supabaseAdmin
    .from("process_irregular_acts")
    .select(sel)
    .eq("kind", "review_request")
    .eq("status", "pending")
    .not("review_link", "is", null);
  if (!opts.ignoreSchedule) {
    regQ = regQ.lte("scheduled_check_at", nowIso);
    irrQ = irrQ.lte("scheduled_check_at", nowIso);
  }
  const [{ data: reg }, { data: irr }] = await Promise.all([regQ, irrQ]);
  type Row = Omit<DueItem, "source" | "table">;
  return [
    ...((reg ?? []) as Row[]).map(
      (r): DueItem => ({ ...r, source: "regular", table: "process_check_statuses" }),
    ),
    ...((irr ?? []) as Row[]).map(
      (r): DueItem => ({ ...r, source: "irregular", table: "process_irregular_acts" }),
    ),
  ];
}

// 기본 인프로세스 크롤+매칭 — cafe-line-crew(POST) 라우트와 "동일 로직"을 직접 수행한다.
//   닉네임 수집(fetchCafeNicknames: 운영=외부 크롤러/로컬=Playwright) → org+mode 모집단으로 좁혀 매칭.
//   ⚠ 매칭 입력 자체를 org+mode 풀로 한정하므로 동명이인/타 모드 유입을 1차 차단한다(2차 가드는 sweep).
// export: 검증 스크립트가 이 "실제" 매칭 경로(부수효과 없음: 크롤+스코프+매칭만)를 mock 크롤러로
//   직접 구동해 cafe-line-crew(POST) 와의 파리티를 확인할 수 있도록 한다(런타임 동작 무변).
export async function inProcessCrawlAndMatch(
  org: string,
  mode: string,
  url: string,
): Promise<{ matched: SweepMatched[]; review: SweepReview[] }> {
  const collected = await fetchCafeNicknames(url);
  if (!collected.ok) {
    throw new Error(`crawl_failed(${collected.error}): ${collected.message}`);
  }
  const scopeMode: ScopeMode = mode === "test" ? "test" : "operating";
  const scope = await resolveUserScope(scopeMode, isOrganizationSlug(org) ? org : null);
  const crews = scope.filter(await loadCrewRecords(org), (c) => c.userId);
  // cafe-line-crew(POST) 와 동일: test 모집단이면 크루 이름의 단일 T 접두를 벗겨 실명 댓글과 대조한다.
  //   scope.mode 는 resolveUserScope 가 QA_HIDE_REAL_USERS 를 반영해 해소한 "실효 모드"(요청 mode 아님).
  //   operating 은 stripTestPrefix=false → 강민지↔T강민지 를 절대 동일인으로 보지 않음(기존 동작 불변).
  const result = matchCafeComments(collected.data.nicknames, crews, {
    stripTestPrefix: scope.mode === "test",
  });
  return {
    matched: result.matched.map((m) => ({
      userId: m.crew.userId,
      nickname: m.nickname,
      reason: m.matchReason,
    })),
    review: result.review.map((r) => ({ nickname: r.nickname, reason: r.reason })),
  };
}

// ── 만기 항목 1괄 처리 — 워커 runOnce 와 동일 의미(주입형: 검증이 crawl/accrue 주입) ──────
//   onlyIds: 지정 시 해당 id 만(검증 스크립트가 자기 시드만 건드리도록 — 운영은 미지정).
//   maxItems: 이번 sweep 처리 상한(초과분은 capped 로 보고하고 다음 폴링에 catch-up).
export async function runDueProcessCheckSweep(opts: {
  now?: number;
  orgs?: string[] | null;
  modes?: string[] | null;
  onlyIds?: string[] | null;
  maxItems?: number;
  crawlAndMatch?: SweepCrawlAndMatch;
  accrue?: SweepAccrue | null;
  log?: (m: string) => void;
  // 운영(operating·기본)/QA(qa) 분기. Action Service 공통 — 향후 운영 자동 fallback 도 같은 함수 사용.
  //   scope="qa" → 처리 대상을 scope_mode='test' 항목으로 **강제 한정**(modes 입력 무시·fail-safe)
  //     + 실행 결과를 qa_action_log(action='sweep')에 기록. 테스트 크루만 대상이 됨이 보장된다.
  //   scope 미지정/operating → 기존 동작 바이트 동일(modes 입력 그대로·qa 로깅 없음).
  scope?: StateScope;
  actor?: string | null;
  // QA "즉시 실행" 전용(opt-in) — 기본 false(자동 스케줄 동작 바이트 동일).
  //   ignoreSchedule  : scheduled_check_at 게이트 우회(검수 예정 시각 전이라도 처리).
  //   ignoreRetryGate : attempt_count/cooldown 재시도 게이트 우회(방금 실패한 항목도 즉시 재실행).
  //   둘 다 GitHub Actions 자동 sweep 은 미지정 → 운영 스케줄은 그대로 유지된다.
  ignoreSchedule?: boolean;
  ignoreRetryGate?: boolean;
} = {}): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const orgs = opts.orgs ?? null;
  const scope: StateScope = opts.scope ?? "operating";
  // fail-safe: QA sweep 은 scope='qa' 가 명시될 때만, 그리고 그 때는 무조건 test 항목만 처리한다.
  //   (호출부가 modes 에 operating 을 넣어도 QA 에서는 절대 운영 항목을 건드리지 않는다.)
  const modes = scope === "qa" ? ["test"] : (opts.modes ?? null);
  const onlyIds = opts.onlyIds ?? null;
  const maxItems = Math.max(1, opts.maxItems ?? DEFAULT_MAX_ITEMS);
  const crawlAndMatch = opts.crawlAndMatch ?? inProcessCrawlAndMatch;
  const accrue = opts.accrue === undefined ? accrueForCompletedAct : opts.accrue;
  const log = opts.log ?? (() => {});
  const ignoreSchedule = opts.ignoreSchedule === true;
  const ignoreRetryGate = opts.ignoreRetryGate === true;

  const nowIso = new Date(now).toISOString();
  const due = await findDueProcessCheckItems(nowIso, { ignoreSchedule });

  // 쓰기 직전 스코프 재검증용 테스트 유저 집합(sweep 당 1회). 조회 실패 → 빈 집합(fail-safe:
  //   operating 전원 통과 / test 전원 차단 → 실유저 절대 유입 안 됨, lib/userScope 와 동일 축).
  const { data: markerRows } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testIds = new Set(((markerRows ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter(Boolean));

  // org/mode 한정 + (옵션)id 화이트리스트 + 재시도 소진/쿨다운 필터 — 워커 eligible 과 동일.
  const eligibleAll = due.filter(
    (d) =>
      (!orgs || orgs.includes(d.organization_slug)) &&
      (!modes || modes.includes(d.scope_mode ?? "operating")) &&
      (!onlyIds || onlyIds.includes(d.id)) &&
      // 재시도 게이트(소진/쿨다운) — ignoreRetryGate 면 우회(QA 즉시 실행).
      (ignoreRetryGate ||
        ((d.attempt_count ?? 0) < MAX_ATTEMPTS &&
          (!d.last_attempt_at || now - Date.parse(d.last_attempt_at) >= COOLDOWN_MS))),
  );
  const eligible = eligibleAll.slice(0, maxItems);
  const capped = eligibleAll.length - eligible.length;
  if (capped > 0) log(`⚠ maxItems=${maxItems} 도달 — ${capped}건은 다음 폴링으로 미룸(catch-up)`);

  let succeeded = 0;
  let failed = 0;
  const items: SweepItemResult[] = [];

  for (const item of eligible) {
    const mode: ScopeMode = item.scope_mode === "test" ? "test" : "operating";
    try {
      const { matched, review } = await crawlAndMatch(
        item.organization_slug,
        mode,
        item.review_link ?? "",
      );

      // ── 쓰기 직전 스코프 재검증(defense-in-depth) — cafe 매칭이 이미 org+mode 로 좁히지만,
      //   다른 write 경로(createManualGrant·info-lines·competency)와 동일하게 2차 가드를 둔다.
      //   matched user_id 전원이 (item.scope_mode 모집단) AND (item.organization_slug 소속)이어야.
      //   하나라도 어긋나면 throw → recipients 미기록 · attempt_count++ (fail-closed).
      const matchedIds = matched.map((m) => m.userId).filter((x): x is string => Boolean(x));
      if (matchedIds.length) {
        const modeOffenders = matchedIds.filter((id) => (mode === "test") !== testIds.has(id));
        if (modeOffenders.length) {
          throw new Error(
            `scope violation(mode=${mode}): ${modeOffenders.length} user(s) out of test/operating scope`,
          );
        }
        const { data: profRows, error: profErr } = await supabaseAdmin
          .from("user_profiles")
          .select("user_id,organization_slug")
          .in("user_id", matchedIds);
        if (profErr) throw new Error(`org check: ${profErr.message}`);
        const orgById = new Map(
          ((profRows ?? []) as { user_id: string; organization_slug: string | null }[]).map((r) => [
            r.user_id,
            r.organization_slug,
          ]),
        );
        const orgOffenders = matchedIds.filter((id) => orgById.get(id) !== item.organization_slug);
        if (orgOffenders.length) {
          throw new Error(
            `scope violation(org=${item.organization_slug}): ${orgOffenders.length} cross-org user(s)`,
          );
        }
      }

      // 결과 저장(멱등: source+ref_id delete 후 재삽입).
      await supabaseAdmin
        .from("process_check_review_recipients")
        .delete()
        .eq("source", item.source)
        .eq("ref_id", item.id);
      const rows = [
        ...matched.map((m) => ({
          source: item.source,
          ref_id: item.id,
          organization_slug: item.organization_slug,
          scope_mode: mode,
          user_id: m.userId,
          nickname: m.nickname,
          match_type: "matched",
          match_reason: m.reason ?? null,
        })),
        ...review.map((r) => ({
          source: item.source,
          ref_id: item.id,
          organization_slug: item.organization_slug,
          scope_mode: mode,
          user_id: null,
          nickname: r.nickname,
          match_type: "review",
          match_reason: r.reason ?? null,
        })),
      ];
      if (rows.length) {
        const { error } = await supabaseAdmin.from("process_check_review_recipients").insert(rows);
        if (error) throw new Error(`recipients insert: ${error.message}`);
      }

      // 완료 처리 (user_weekly_points/snapshot 무접촉 — 적립 lib 이 담당).
      //   성공도 처리 기록을 남긴다 — last_attempt_at(언제) + attempt_count(몇 번째 시도에 성공).
      //   완료 행은 findDue(status='pending')에서 재폴링되지 않으므로 retry 게이트에 무해.
      const completedAt = new Date(now).toISOString();
      const upd: Record<string, unknown> = {
        status: "completed",
        completed_at: completedAt,
        last_error: null,
        attempt_count: (item.attempt_count ?? 0) + 1,
        last_attempt_at: completedAt,
      };
      if (item.source === "regular") upd.checked_crew_count = matched.length;
      const { error: uErr } = await supabaseAdmin.from(item.table).update(upd).eq("id", item.id);
      if (uErr) throw new Error(`complete update: ${uErr.message}`);

      // ── 체크 완료 로그(자동) — 정규 행이 completed 로 전이되는 순간 1회 기록(요구사항 #3).
      //   관리자 버튼 이벤트가 아니므로 actor_name="자동 검수". 멱등(같은 스코프 중복 로그 X)은 helper 내부.
      //   변동(irregular)은 process_check_logs(허브 기반) 미사용 → 정규만. best-effort(로그 실패가 완료를 안 깸).
      if (item.source === "regular") {
        try {
          // 운영자가 [즉시 검수]를 눌러 태운 sweep 이면 actor=관리자 이름, 자동 스케줄이면 opts.actor
          //   미지정 → 완료 로그가 "자동 검수" 라벨로 남는다(runProcessCheckRowNow 만 actor 전달).
          await logProcessCheckCompletedForRegular(item.id, { adminId: opts.actor ?? null });
        } catch (logErr) {
          log(`  ↳ 완료 로그 실패(격리) ${item.id}: ${String((logErr as Error)?.message ?? logErr).slice(0, 200)}`);
        }
      }

      // ── 포인트 적립(완료 즉시) — 원장 멱등·user_weekly_points 재계산·snapshot 무효화(lib SoT).
      //   best-effort: 적립 실패가 완료 처리를 되돌리지 않는다(완료는 멱등 재실행으로 적립 재시도 가능).
      //   era 경계(operating=summer+/test=+W13)·org/mode 스코프는 적립 lib 내부에서 강제.
      let accrued: number | null = null;
      let accrualSkippedReason: string | undefined;
      if (accrue) {
        try {
          const acc = (await accrue(item.source, item.id)) as
            | { ok?: boolean; skipped?: boolean; reason?: string; accruedUserIds?: string[] }
            | undefined;
          if (acc?.skipped) {
            accrualSkippedReason = acc.reason;
            log(`  ↳ 적립 ${item.source} ${item.id}: skip(${acc.reason})`);
          } else {
            accrued = acc?.accruedUserIds?.length ?? 0;
            log(`  ↳ 적립 ${item.source} ${item.id}: accrued ${accrued}`);
          }
        } catch (accErr) {
          log(
            `  ↳ 적립 실패(격리) ${item.id}: ${String(
              (accErr as Error)?.message ?? accErr,
            ).slice(0, 200)}`,
          );
        }
      }

      succeeded++;
      items.push({
        id: item.id,
        source: item.source,
        organizationSlug: item.organization_slug,
        mode,
        outcome: "completed",
        matched: matched.length,
        review: review.length,
        accrued,
        ...(accrualSkippedReason ? { accrualSkippedReason } : {}),
      });
      log(
        `✓ ${item.source} ${item.id} (${item.organization_slug}/${mode}) → matched ${matched.length} · review ${review.length}`,
      );
    } catch (e) {
      failed++;
      const attempt = (item.attempt_count ?? 0) + 1;
      const msg = String((e as Error)?.message ?? e).slice(0, 500);
      await supabaseAdmin
        .from(item.table)
        .update({
          attempt_count: attempt,
          last_attempt_at: new Date(now).toISOString(),
          last_error: msg,
        })
        .eq("id", item.id);
      items.push({
        id: item.id,
        source: item.source,
        organizationSlug: item.organization_slug,
        mode,
        outcome: "failed",
        attempt,
        error: msg,
      });
      log(`✗ ${item.source} ${item.id} attempt ${attempt}/${MAX_ATTEMPTS}: ${msg}`);
    }
  }

  const result: SweepResult = { due: due.length, eligible: eligible.length, succeeded, failed, capped, items };

  // ── QA sweep 추적(요구사항 #7) — scope='qa' 실행만 qa_action_log(action='sweep')에 기록 ──
  //   운영 sweep 은 기록하지 않는다(운영 동작 불변). best-effort(로깅 실패가 sweep 을 안 깸).
  if (scope === "qa") {
    const accruedTotal = items.reduce(
      (n, it) => n + (it.outcome === "completed" ? (it.accrued ?? 0) : 0),
      0,
    );
    await logQaAction({
      action: "sweep",
      weekId: null,
      before: { due: result.due, eligible: result.eligible, onlyIds, orgs },
      after: {
        succeeded: result.succeeded,
        failed: result.failed,
        capped: result.capped,
        accruedRecipients: accruedTotal,
        itemIds: items.map((it) => it.id),
      },
      actor: opts.actor ?? null,
    });
  }

  return result;
}
