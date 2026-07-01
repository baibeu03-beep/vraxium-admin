/**
 * QA 즉시 실행(run-now) 검증 — A1 프로세스 체크 / B2 snapshot 배치 / C5 사용자 snapshot.
 *
 * 안전 원칙(기본 무변경):
 *   - 기본은 dry-run/읽기만 수행한다(운영·테스트 데이터 무변경). 실제 재계산 실행 검증은
 *     QA_RUN_NOW_EXECUTE=1 일 때만(테스트 유저 snapshot 재계산 — 멱등·테스트 한정).
 *   - 본 라우트는 관리자 "세션" 인증이라 스크립트에서 직접 인증이 어렵다. HTTP 는 (a) 미인증 401
 *     게이트를 항상 확인하고, (b) QA_ADMIN_COOKIE 가 주어지면 인증 HTTP↔direct 동치를 확인한다.
 *
 *   npx tsx --env-file=.env.local scripts/verify-qa-run-now.ts
 *   (실행 검증 포함) QA_RUN_NOW_EXECUTE=1 npx tsx --env-file=.env.local scripts/verify-qa-run-now.ts
 */
import { createClient } from "@supabase/supabase-js";
import {
  runProcessCheckNow,
  runSnapshotBatchNow,
  runUserSnapshotNow,
  QaRunNowScopeError,
} from "@/lib/qaRunNow";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = process.env.WORKER_BASE_URL ?? "http://localhost:3000";
const ADMIN_COOKIE = process.env.QA_ADMIN_COOKIE ?? null;
const DO_EXECUTE = process.env.QA_RUN_NOW_EXECUTE === "1";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`${ok ? "✅" : "❌"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const TABLE = "cluster4_weekly_card_snapshots";

async function countOperational() {
  const [pubW, uwp, qaW] = await Promise.all([
    sb.from("weeks").select("id", { count: "exact", head: true }).not("result_published_at", "is", null),
    sb.from("user_weekly_points").select("user_id", { count: "exact", head: true }),
    sb.from("qa_weeks_state").select("week_id", { count: "exact", head: true }),
  ]);
  return { pubW: pubW.count ?? 0, uwp: uwp.count ?? 0, qaW: qaW.count ?? 0 };
}

async function http(path: string, body: unknown, withCookie: boolean) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withCookie && ADMIN_COOKIE) headers["cookie"] = ADMIN_COOKIE;
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

async function main() {
  // 0) qa_run_now_log 적용 여부 안내(미적용이어도 실행은 정상 — best-effort 로깅).
  const { error: logErr } = await sb.from("qa_run_now_log").select("id").limit(1);
  console.log(
    logErr
      ? `⚠ qa_run_now_log 미적용(${logErr.message}) — 실행 시 감사로그만 skip(액션 무관). SQL Editor 적용 권장.`
      : "✅ qa_run_now_log 적용됨",
  );

  const testIds = Array.from(await fetchTestUserMarkerIds());
  ck("[준비] 테스트 유저 존재(test_user_markers)", testIds.length > 0, `count=${testIds.length}`);

  // 실유저(마커 미등재) 1명 확보 — 누수/fail-closed 검증용.
  const { data: someUsers } = await sb.from("user_profiles").select("user_id").limit(500);
  const markerSet = new Set(testIds);
  const realUserId =
    ((someUsers ?? []) as { user_id: string }[]).map((r) => r.user_id).find((id) => !markerSet.has(id)) ??
    null;
  ck("[준비] 실유저(비-테스트) 샘플 확보", Boolean(realUserId), realUserId ?? "none");

  // ── 1) DIRECT dry-run 운영 무변경 ──────────────────────────────────
  const before = await countOperational();

  const pc = await runProcessCheckNow({ dryRun: true, actor: "verify" });
  ck("[A1 dry] mode=dry_run", pc.mode === "dry_run");
  ck("[A1 dry] 테스트 due <= 전체 due", pc.dueTest <= pc.dueTotal, `${pc.dueTest}/${pc.dueTotal}`);
  ck(
    "[A1 dry] testItems 전부 dueTest 와 정합",
    pc.testItems.length === pc.dueTest,
    `${pc.testItems.length}`,
  );

  const sb2 = await runSnapshotBatchNow({ dryRun: true, actor: "verify" });
  ck("[B2 dry] mode=dry_run", sb2.mode === "dry_run");
  ck("[B2 dry] testUserCount=마커 수", sb2.testUserCount === testIds.length, `${sb2.testUserCount}`);
  ck("[B2 dry] before 신선도 집계 total=마커 수", sb2.before.total === testIds.length);

  if (testIds.length > 0) {
    const us = await runUserSnapshotNow({ userIds: [testIds[0]], dryRun: true, actor: "verify" });
    ck("[C5 dry] 테스트 유저 1명 미리보기 성공", us.mode === "dry_run" && us.before.total === 1);
  }

  const afterDry = await countOperational();
  ck(
    "[무변경] dry-run 후 운영 카운트(weeks 공표/uwp/qa_weeks_state) 불변",
    before.pubW === afterDry.pubW && before.uwp === afterDry.uwp && before.qaW === afterDry.qaW,
    `pubW ${before.pubW}→${afterDry.pubW} uwp ${before.uwp}→${afterDry.uwp} qa ${before.qaW}→${afterDry.qaW}`,
  );

  // ── 2) C5 fail-closed: 실유저 포함 시 422(write 0) ────────────────
  if (realUserId) {
    let threw422 = false;
    try {
      await runUserSnapshotNow({ userIds: [realUserId], dryRun: true, actor: "verify" });
    } catch (e) {
      threw422 = e instanceof QaRunNowScopeError && e.status === 422;
    }
    ck("[C5 fail-closed] 실유저 단독 → 422 거절", threw422);

    // 테스트+실유저 혼합도 전체 거절(부분 실행 금지).
    let mixed422 = false;
    try {
      await runUserSnapshotNow({
        userIds: [...(testIds[0] ? [testIds[0]] : []), realUserId],
        dryRun: true,
        actor: "verify",
      });
    } catch (e) {
      mixed422 = e instanceof QaRunNowScopeError && e.status === 422;
    }
    ck("[C5 fail-closed] 테스트+실유저 혼합 → 전체 422(부분 실행 금지)", mixed422);
  }

  // ── 3) 실유저 snapshot 누수 0 — (옵션) 실제 실행 시 실유저 computed_at 불변 ──
  if (DO_EXECUTE && realUserId) {
    const beforeReal = await sb
      .from(TABLE)
      .select("computed_at,is_stale")
      .eq("user_id", realUserId)
      .maybeSingle();

    const execRes = await runSnapshotBatchNow({ dryRun: false, actor: "verify" });
    ck(
      "[B2 exec] 테스트 전수 재계산 완료(테스트 한정)",
      execRes.mode === "execute" && Boolean(execRes.recompute),
      `recomputed=${execRes.recompute?.recomputed}/${execRes.recompute?.requested}`,
    );

    const afterReal = await sb
      .from(TABLE)
      .select("computed_at,is_stale")
      .eq("user_id", realUserId)
      .maybeSingle();
    ck(
      "[누수 0] 실유저 snapshot computed_at 불변(테스트 배치 실행에도)",
      (beforeReal.data?.computed_at ?? null) === (afterReal.data?.computed_at ?? null),
      `${beforeReal.data?.computed_at ?? "none"} → ${afterReal.data?.computed_at ?? "none"}`,
    );

    // 운영 weeks/uwp 도 불변(snapshot 재계산은 weeks/uwp 를 쓰지 않음).
    const afterExec = await countOperational();
    ck(
      "[누수 0] 실행 후 weeks 공표/uwp 불변",
      before.pubW === afterExec.pubW && before.uwp === afterExec.uwp,
      `pubW ${before.pubW}→${afterExec.pubW} uwp ${before.uwp}→${afterExec.uwp}`,
    );
  } else {
    console.log("ℹ 실행(execute) 검증 생략 — QA_RUN_NOW_EXECUTE=1 로 켜면 누수 0 검증까지 수행.");
  }

  // ── 4) HTTP 인증 게이트(항상): 미인증 → 401 ───────────────────────
  const routes = [
    "/api/admin/qa/run-now/process-check",
    "/api/admin/qa/run-now/snapshot-batch",
    "/api/admin/qa/run-now/user-snapshot",
  ];
  let allGated = true;
  for (const p of routes) {
    const res = await http(p, { mode: "dry_run" }, false).catch(() => ({ status: 0 }));
    if (res.status !== 401) allGated = false;
  }
  ck("[HTTP 게이트] 미인증 POST 전부 401(requireAdmin)", allGated);

  const logsRes = await fetch(`${BASE}/api/admin/qa/run-now/logs`).catch(() => ({ status: 0 }) as any);
  ck("[HTTP 게이트] 미인증 logs GET 401", (logsRes as any).status === 401);

  // ── 5) (옵션) 인증 HTTP ↔ direct 동치 — QA_ADMIN_COOKIE 제공 시 ──
  if (ADMIN_COOKIE) {
    const hpc = await http("/api/admin/qa/run-now/process-check", { mode: "dry_run" }, true);
    const dpc = await runProcessCheckNow({ dryRun: true, actor: "verify" });
    ck(
      "[direct==HTTP] A1 dry-run dueTest 동일",
      hpc.status === 200 && hpc.json?.data?.dueTest === dpc.dueTest,
      `http=${hpc.json?.data?.dueTest} direct=${dpc.dueTest}`,
    );
    const hsb = await http("/api/admin/qa/run-now/snapshot-batch", { mode: "dry_run" }, true);
    ck(
      "[direct==HTTP] B2 dry-run testUserCount 동일",
      hsb.status === 200 && hsb.json?.data?.testUserCount === testIds.length,
      `http=${hsb.json?.data?.testUserCount} direct=${testIds.length}`,
    );
    if (realUserId) {
      const hbad = await http("/api/admin/qa/run-now/user-snapshot", { mode: "dry_run", userIds: [realUserId] }, true);
      ck("[direct==HTTP] C5 실유저 → 422", hbad.status === 422, `status=${hbad.status}`);
    }
  } else {
    console.log("ℹ 인증 HTTP↔direct 동치 검증 생략 — QA_ADMIN_COOKIE 제공 시 수행.");
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
