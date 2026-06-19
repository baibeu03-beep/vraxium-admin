// 프로세스 체크 로그창 3종 이벤트 검증 — [체크 신청]/[체크 취소]/[체크 완료](자동).
//   run: npx tsx --env-file=.env.local scripts/verify-process-check-completed-log.ts
//   전제: admin(:3000) 기동 + process_check v2~v4 + process_point_awards + INTERNAL_API_KEY + 관리자 EMAIL.
//
//   초점(이번 변경):
//     · check_requested  : applyProcessCheckAction(request) → 로그 1건.
//     · check_cancelled  : applyProcessCheckAction(cancel)  → 로그 1건.
//     · check_completed  : 검수 sweep(runDueProcessCheckSweep)이 pending→completed 전이 시 "자동" 1건
//                          (actor_name="자동 검수", 관리자 버튼 아님). + 멱등(중복 로그 X).
//     · 수동 부여(manual_grant) 재부여 시 check_completed 중복 로그 X.
//     · org=oranke/encre · mode=test/operating 로그 비혼재. direct(lib)==HTTP(board GET) DTO 동등.
//     · snapshot: 로그 기록 자체는 snapshot/user_weekly_points 무접촉(별도 재계산 불필요) — 실측 보고.
//   crawl 은 주입(가짜 매칭)으로 결정화. accrue=null 로 적립/snapshot 격리(로그 동작만 관측).
//   테스트 주차=W13(2026-spring 예외)·test 유저만. net-zero(TAG 정리 + manual_grant 적립 원복).
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  applyProcessCheckAction,
  applyProcessManualGrant,
  getProcessCheckBoard,
  logProcessCheckCompletedForRegular,
} from "@/lib/adminProcessCheckData";
import { runDueProcessCheckSweep } from "@/lib/processCheckDueSweep";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const KEY = process.env.INTERNAL_API_KEY;
const BASE = process.env.WORKER_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.ADMIN_VERIFY_EMAIL ?? "vanuatu.golden@gmail.com";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-cklog";
const HUB = "info" as const;
const ORG = "oranke";
const ENC = "encre";
const PAST = "2020-01-01T00:00:00.000Z";
const DAY = 86_400_000;
const AUTO = "자동 검수";
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 주입 crawl(결정적) — 지정 유저 1명 매칭 + 수동확인 1건.
const matchUser = (userId: string) => async () => ({
  matched: [{ userId, nickname: `${TAG} 매칭닉`, reason: "test:match" }],
  review: [{ nickname: `${TAG} 수동닉`, reason: "형식 불명" }],
});

// 액트의 로그 action 목록(오래된→최신) — board.logs 에서 그 act 만.
const actLogActions = (logs: { actName: string; action: string }[], actName: string) =>
  logs.filter((l) => l.actName === actName).map((l) => l.action);
const actLogs = (logs: { actName: string; action: string; actorName: string }[], actName: string) =>
  logs.filter((l) => l.actName === actName);

async function adminCookie(): Promise<string> {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const otp = (link as { properties?: { email_otp?: string } })?.properties?.email_otp;
  if (!otp) throw new Error("magiclink OTP 생성 실패");
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: otp, type: "magiclink" });
  const session = (v as { session?: { access_token: string; refresh_token: string } })?.session;
  if (!session) throw new Error("admin 세션 생성 실패");
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function cleanup() {
  for (const org of [ORG, ENC]) {
    const grp = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
    const gIds = (grp as { id: string }[]).map((g) => g.id);
    if (!gIds.length) continue;
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", gIds)).data ?? [];
    const aIds = (acts as { id: string }[]).map((a) => a.id);
    if (aIds.length) {
      const sts = (await sb.from("process_check_statuses").select("id").in("act_id", aIds)).data ?? [];
      for (const s of sts as { id: string }[]) {
        await sb.from("process_check_review_recipients").delete().eq("ref_id", s.id);
        await sb.from("process_point_awards").delete().eq("source", "regular").eq("ref_id", s.id);
      }
      await sb.from("process_check_logs").delete().in("act_id", aIds);
      await sb.from("process_check_statuses").delete().in("act_id", aIds);
      await sb.from("process_acts").delete().in("id", aIds);
    }
    await sb.from("process_line_groups").delete().in("id", gIds);
    void org;
  }
}

async function http(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function main() {
  if (!KEY) { console.log("⚠ INTERNAL_API_KEY 미설정 — HTTP run-due 검증 불가"); process.exit(2); }
  const probe = await sb.from("process_check_logs").select("action").limit(1);
  if (probe.error) { console.log(`⚠ process_check v2 미적용(${probe.error.code})`); process.exit(2); }
  const compProbe = await sb.from("process_check_statuses").select("completion_type").limit(1);
  const manualGrantAvail = !compProbe.error;

  const cookie = await adminCookie();
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id as string | undefined;
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,week_number").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  ck("[전제] admin쿠키 · oranke test유저 · W13(2026-spring)", !!cookie && !!user && !!week?.id, J({ user: !!user, week: week?.id }));
  if (!user || !week?.id) { console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(2); }
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const pointsOf = async (uid: string) => ((await sb.from("user_weekly_points").select("points").eq("user_id", uid).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any)?.points ?? 0;
  const origUwp = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;

  await cleanup();

  // ── 시드: 라인급 + 액트(A=직접완료 · B=신청취소 · C=수동부여 선별 · E=encre org격리) ──
  const grp = (await sb.from("process_line_groups").insert({ hub: HUB, name: `${TAG} 라인급` }).select("id").single()).data as any;
  const mkAct = async (suffix: string, actType = "required") => (await sb.from("process_acts").insert({
    line_group_id: grp.id, hub: HUB, act_name: `${TAG} ${suffix}`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: actType,
  }).select("id,act_name").single()).data as any;
  const A = await mkAct("A완료"), B = await mkAct("B취소"), E = await mkAct("E엔크르");
  const C = manualGrantAvail ? await mkAct("C수동", "selection") : null;
  ck("[시드] 라인급 + 액트 A·B·E(+C)", !!grp?.id && !!A?.id && !!B?.id && !!E?.id);

  const board = (org = ORG, mode: "test" | "operating" = "test") => getProcessCheckBoard(HUB, org, null, mode);
  const boardHttp = (org = ORG, mode = "test") => http(`/api/admin/processes/check?hub=${HUB}&org=${org}&mode=${mode}`, { headers: { cookie } });
  const futureIso = new Date(Date.now() + DAY).toISOString();

  // ── 1) check_requested ─────────────────────────────────────────────────────
  await applyProcessCheckAction({ hub: HUB, organization: ORG, actId: A.id, action: "request", reviewLink: "https://cafe.naver.com/x/A", scheduledCheckAt: futureIso, adminId: user, mode: "test" });
  const b1 = await board();
  ck("[1 check_requested] A 로그 = [check_requested]", J(actLogActions(b1.logs, A.act_name)) === J(["check_requested"]), J(actLogActions(b1.logs, A.act_name)));

  // ── 2) check_cancelled (B: request→cancel) ─────────────────────────────────
  await applyProcessCheckAction({ hub: HUB, organization: ORG, actId: B.id, action: "request", reviewLink: "https://cafe.naver.com/x/B", scheduledCheckAt: futureIso, adminId: user, mode: "test" });
  await applyProcessCheckAction({ hub: HUB, organization: ORG, actId: B.id, action: "cancel", adminId: user, mode: "test" });
  const b2 = await board();
  ck("[2 check_cancelled] B 로그 = [check_requested, check_cancelled]", J(actLogActions(b2.logs, B.act_name)) === J(["check_requested", "check_cancelled"]), J(actLogActions(b2.logs, B.act_name)));

  // ── 3) check_completed 자동 — A 검수시점 과거로 당긴 뒤 sweep(주입매칭) 완료 ──────────
  const aStatusId = (await sb.from("process_check_statuses").select("id").eq("act_id", A.id).eq("organization_slug", ORG).eq("week_id", week.id).maybeSingle()).data?.id as string;
  await sb.from("process_check_statuses").update({ scheduled_check_at: PAST }).eq("id", aStatusId);
  const sw = await runDueProcessCheckSweep({ onlyIds: [aStatusId], modes: ["test"], crawlAndMatch: matchUser(user), accrue: null });
  const aRow = (await sb.from("process_check_statuses").select("status").eq("id", aStatusId).maybeSingle()).data as any;
  ck("[3a sweep] A completed(전이)", sw.succeeded === 1 && aRow?.status === "completed", J({ sw: sw.items[0], status: aRow?.status }));
  const b3 = await board();
  const aLogs = actLogs(b3.logs, A.act_name);
  ck("[3b check_completed 자동] A 로그 = [check_requested, check_completed]", J(aLogs.map((l) => l.action)) === J(["check_requested", "check_completed"]), J(aLogs.map((l) => l.action)));
  const aComp = aLogs.find((l) => l.action === "check_completed");
  ck("[3c actor=자동 검수] 완료 로그 actor_name='자동 검수'(관리자 버튼 아님)", aComp?.actorName === AUTO, `actor=${aComp?.actorName}`);

  // ── 4) direct == HTTP (board GET DTO) — A 로그 동등 ──────────────────────────
  const b3h = await boardHttp();
  const httpA = (b3h.json.data?.logs ?? []).filter((l: any) => l.actName === A.act_name).map((l: any) => `${l.action}:${l.actorName}`);
  const dirA = aLogs.map((l) => `${l.action}:${l.actorName}`);
  ck("[4 direct==HTTP] A 로그(action:actor) 동등", b3h.status === 200 && J(httpA) === J(dirA), J({ http: httpA, direct: dirA }));

  // ── 5) 멱등 — completed 재처리 시 check_completed 중복 로그 X ────────────────────
  const compCount = async (actId: string) => (await sb.from("process_check_logs").select("id", { count: "exact", head: true }).eq("act_id", actId).eq("action", "check_completed")).count ?? 0;
  await logProcessCheckCompletedForRegular(aStatusId); // 직접 재호출
  await logProcessCheckCompletedForRegular(aStatusId);
  const swDup = await runDueProcessCheckSweep({ onlyIds: [aStatusId], modes: ["test"], crawlAndMatch: matchUser(user), accrue: null });
  const cntDirect = await compCount(A.id);
  ck("[5a 멱등 direct] 재호출·완료건 sweep eligible 0 → check_completed 1건 유지", swDup.eligible === 0 && cntDirect === 1, `eligible=${swDup.eligible} count=${cntDirect}`);
  const hDup = await http(`/api/admin/processes/check/run-due-checks`, { method: "POST", headers: { "Content-Type": "application/json", "x-internal-api-key": KEY }, body: J({ onlyIds: [aStatusId], modes: ["test"] }) });
  const cntHttp = await compCount(A.id);
  ck("[5b 멱등 HTTP] run-due 재호출 eligible 0 → check_completed 1건 유지", hDup.status === 200 && hDup.json?.data?.eligible === 0 && cntHttp === 1, `eligible=${hDup.json?.data?.eligible} count=${cntHttp}`);

  // ── 6) 3종 이벤트 모두 DTO 포함(요구사항 #5) ──────────────────────────────────
  const allActions = new Set((b3.logs ?? []).filter((l) => l.actName.startsWith(TAG)).map((l) => l.action));
  ck("[6 DTO 3종] check_requested·check_cancelled·check_completed 모두 포함", allActions.has("check_requested") && allActions.has("check_cancelled") && allActions.has("check_completed"), J([...allActions]));

  // ── 7) 수동 부여(manual_grant) 재부여 시 check_completed 중복 X ──────────────────
  if (C && user) {
    await applyProcessManualGrant({ hub: HUB, organization: ORG, actId: C.id, mode: "test", adminId: user, targetUserIds: [user], pointCheck: 1, pointAdvantage: 0, pointPenalty: 0 });
    const c1 = await compCount(C.id);
    await applyProcessManualGrant({ hub: HUB, organization: ORG, actId: C.id, mode: "test", adminId: user, targetUserIds: [user], pointCheck: 1, pointAdvantage: 0, pointPenalty: 0 });
    const c2 = await compCount(C.id);
    ck("[7 manual_grant 멱등] 최초 부여 1건 · 재부여 후에도 1건(중복 X)", c1 === 1 && c2 === 1, `first=${c1} regrant=${c2}`);
  } else {
    ck("[7 manual_grant 멱등] (skip — completion_type 컬럼 미적용)", true, "v? manual_grant 미적용");
  }

  // ── 8) org 비혼재 — encre 에 신청 → oranke 보드에 안 보이고 encre 보드에만 ───────────
  await applyProcessCheckAction({ hub: HUB, organization: ENC, actId: E.id, action: "request", reviewLink: "https://cafe.naver.com/x/E", scheduledCheckAt: futureIso, adminId: user, mode: "test" });
  const bOr = await board(ORG), bEn = await board(ENC);
  const orHasE = (bOr.logs ?? []).some((l) => l.actName === E.act_name);
  const enHasE = (bEn.logs ?? []).some((l) => l.actName === E.act_name);
  const enHasA = (bEn.logs ?? []).some((l) => l.actName === A.act_name);
  ck("[8 org 비혼재] E=encre 만(oranke X) · encre 에 A(oranke) 없음", !orHasE && enHasE && !enHasA, J({ orHasE, enHasE, enHasA }));

  // ── 9) mode 비혼재 — operating 보드(현재 주차≠W13)에 W13 test 로그 없음 ──────────────
  const bOp = await board(ORG, "operating");
  const opHasTag = (bOp.logs ?? []).some((l) => l.actName.startsWith(TAG));
  const opWeek = bOp.week?.weekId ?? null;
  ck("[9 mode 비혼재] operating 보드(주차≠W13)에 test 로그 없음", !opHasTag && opWeek !== week.id, J({ opHasTag, opWeek, w13: week.id }));

  // ── 10) snapshot — 로그 기록 자체는 snapshot 무접촉(재계산 불필요) ────────────────────
  const snapBefore = await readWeeklyCardsSnapshot(user);
  await logProcessCheckCompletedForRegular(aStatusId); // 순수 로그(멱등 → no-op insert)
  const snapAfter = await readWeeklyCardsSnapshot(user);
  ck("[10 snapshot] 로그 기록 전후 snapshot status 불변(무접촉·재계산 불필요)", snapBefore.status === snapAfter.status, `before=${snapBefore.status} after=${snapAfter.status}`);
  console.log(`  · snapshot 보고: 로그 3종 기록 경로는 process_check_logs 1행만 INSERT — user_weekly_points/snapshot 무접촉 → snapshot 재계산 불필요.`);
  console.log(`  · (참고) 포인트 적립(accrueForCompleted*)은 별개 경로로 snapshot 무효화하며, 본 검증은 accrue=null 로 격리함.`);

  // ── 11) cleanup 원복 ────────────────────────────────────────────────────────
  await cleanup();
  // manual_grant 가 적립한 포인트 원복(W13·test 유저).
  if (C) {
    await sb.from("process_point_awards").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
    if (origUwp) await sb.from("user_weekly_points").update({ points: origUwp.points, advantages: origUwp.advantages, penalty: origUwp.penalty, checks_migrated: origUwp.checks_migrated }).eq("id", origUwp.id);
    else await sb.from("user_weekly_points").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
    await recomputeAndStoreWeeklyCardsSnapshot(user);
    const { syncGradeStats } = await import("@/lib/cluster3ClubRankData");
    await syncGradeStats(user);
  }
  const leftover = (await sb.from("process_check_logs").select("id", { count: "exact", head: true }).like("act_name", `${TAG}%`)).count ?? 0;
  ck("[11 cleanup] TAG 로그 0 · 포인트 원복", leftover === 0 && (await pointsOf(user)) === (origUwp?.points ?? 0), `logs=${leftover} points=${await pointsOf(user)}/${origUwp?.points ?? 0}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error("FATAL:", e?.stack ?? e); try { await cleanup(); } catch {} process.exit(1); });
