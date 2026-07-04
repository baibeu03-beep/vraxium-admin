// 프로세스 체크 로그창 — 실행 취소 로그 + 완료 로그 행위자(actor) 검증.
//   run: npx tsx --env-file=.env.local scripts/verify-process-check-actor-and-rollback-log.ts
//   전제: admin(:3000) 기동 + process_check v2~v4 + INTERNAL_API_KEY + 관리자 EMAIL.
//
//   이번 수정 초점(요구사항 매핑):
//     #2/#4/#7 완료 로그 행위자:
//        · 운영자 버튼(즉시 검수 = sweep with actor)  → actor_name = 관리자 display_name (자동 검수 아님)
//        · 자동 스케줄(sweep with no actor)            → actor_name = "자동 검수"
//     #1/#3 실행 취소(↩) 로그:
//        · rollbackProcessCheckCompletion → check_rolled_back(또는 미적용 시 check_cancelled 폴백)
//          로그 1건, actor_name = 관리자 display_name.
//     #3 검증: direct(lib) 결과 == HTTP(rollback route) 결과 == board GET 반영.
//     #5 즉시 반영: 액션 직후 board GET(프론트가 refetch 하는 그 엔드포인트)에 즉시 로그 노출.
//     #9/#10 snapshot: 로그/취소(accrue=null)는 snapshot 무접촉 — 재계산 불필요(실측 보고).
//   crawl 은 주입(가짜 매칭)으로 결정화. accrue=null 로 적립/snapshot 격리(로그·actor 동작만 관측).
//   테스트 주차=W13(2026-spring 예외)·test 유저·org=oranke. net-zero(TAG 정리).
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getProcessCheckBoard, logProcessCheckCompletedForRegular } from "@/lib/adminProcessCheckData";
import { runDueProcessCheckSweep } from "@/lib/processCheckDueSweep";
import { rollbackProcessCheckCompletion } from "@/lib/processCheckRollback";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const KEY = process.env.INTERNAL_API_KEY;
const BASE = process.env.WORKER_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.ADMIN_VERIFY_EMAIL ?? "vanuatu.golden@gmail.com";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-rbklog";
const HUB = "info" as const;
const ORG = "oranke";
const PAST = "2020-01-01T00:00:00.000Z";
const AUTO = "자동 검수";
const ROLLBACK_ACTIONS = ["check_rolled_back", "check_cancelled"]; // 미적용 시 폴백(check_cancelled)
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const matchUser = (userId: string) => async () => ({
  matched: [{ userId, nickname: `${TAG} 매칭닉`, reason: "test:match" }],
  review: [] as { nickname: string | null; reason?: string | null }[],
});
const actLogs = (logs: { actName: string; action: string; actorName: string }[], actName: string) =>
  logs.filter((l) => l.actName === actName);

async function adminCookie(): Promise<{ cookie: string; adminId: string }> {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const otp = (link as { properties?: { email_otp?: string } })?.properties?.email_otp;
  if (!otp) throw new Error("magiclink OTP 생성 실패");
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: otp, type: "magiclink" });
  const session = (v as { session?: { access_token: string; refresh_token: string; user?: { id: string } } })?.session;
  if (!session) throw new Error("admin 세션 생성 실패");
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  return { cookie: cap.map((i) => `${i.name}=${i.value}`).join("; "), adminId: session.user?.id ?? "" };
}

async function cleanup() {
  const grp = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  const gIds = (grp as { id: string }[]).map((g) => g.id);
  if (!gIds.length) return;
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
}

async function http(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

// pending 상태 시드행 하나를 sweep 대상으로 만들어 completed 로 전이(주입 매칭). actor 유무로 로그 행위자 분기.
async function seedCompleted(actId: string, weekId: string, user: string, actor: string | null) {
  const stId = (await sb.from("process_check_statuses").insert({
    organization_slug: ORG, hub: HUB, week_id: weekId, act_id: actId,
    line_group_id: (await sb.from("process_acts").select("line_group_id").eq("id", actId).single()).data!.line_group_id,
    status: "pending", scope_mode: "test", review_link: "https://cafe.naver.com/x/seed",
    scheduled_check_at: PAST, requested_at: PAST, requested_by: user,
  }).select("id").single()).data!.id as string;
  // scope='qa'(test 강제) + 주입 crawl + actor 전달/미전달. accrue=null 로 적립 격리.
  const sw = await runDueProcessCheckSweep({
    scope: "qa", onlyIds: [stId], ignoreSchedule: true, ignoreRetryGate: true,
    crawlAndMatch: matchUser(user), accrue: null, actor,
  });
  return { stId, sw };
}

async function main() {
  if (!KEY) { console.log("⚠ INTERNAL_API_KEY 미설정"); process.exit(2); }
  const probe = await sb.from("process_check_logs").select("action").limit(1);
  if (probe.error) { console.log(`⚠ process_check v2 미적용(${probe.error.code})`); process.exit(2); }

  const { cookie, adminId } = await adminCookie();
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? []) as any[];
  const uRow = oranke.find((u) => markers.has(u.user_id));
  const user = uRow?.user_id as string | undefined; // 시드 매칭 크루(테스트 유저)
  // 로그인 관리자(운영자) — HTTP rollback route 가 세션에서 해소하는 그 사람. direct 도 동일 actor 로 맞춰 비교.
  const adminName = ((await sb.from("user_profiles").select("display_name").eq("user_id", adminId).maybeSingle()).data as any)?.display_name?.trim() || "관리자";
  // 보드가 실제로 선택하는 "현재 test 주차"에 시드한다(하드코딩 W13 은 오늘 기준 선택 목록 밖 → 폴백됨).
  const board0 = await getProcessCheckBoard(HUB, ORG, null, "test");
  const week = { id: board0.selectedWeekId as string | null };
  ck("[전제] admin쿠키 · oranke test유저 · 현재 test 주차", !!cookie && !!user && !!week.id, J({ user: !!user, adminName, week: week.id, weekName: board0.selectedWeek?.weekName }));
  if (!user || !week.id) { console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(2); }

  await cleanup();
  const grp = (await sb.from("process_line_groups").insert({ hub: HUB, name: `${TAG} 라인급` }).select("id").single()).data as any;
  const mkAct = async (suffix: string) => (await sb.from("process_acts").insert({
    line_group_id: grp.id, hub: HUB, act_name: `${TAG} ${suffix}`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
  }).select("id,act_name").single()).data as any;
  const A = await mkAct("A자동"), B = await mkAct("B운영자"), Cc = await mkAct("C취소HTTP");
  ck("[시드] 라인급 + 액트 A(자동)·B(운영자)·C(HTTP취소)", !!grp?.id && !!A?.id && !!B?.id && !!Cc?.id);

  const board = () => getProcessCheckBoard(HUB, ORG, null, "test", null, null, week.id);
  const boardHttp = () => http(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=test&week=${week.id}`, { headers: { cookie } });
  // 그라운드 트루스(직독) — process_check_logs 를 act_id 로 직접 조회(주차 필터 무관). 오래된→최신.
  const dbLogs = async (actId: string) => (((await sb.from("process_check_logs")
    .select("action,actor_name,created_at").eq("act_id", actId).order("created_at", { ascending: true })).data ?? []) as any[])
    .map((l) => ({ action: l.action as string, actorName: l.actor_name as string }));

  // ── 1) 자동 sweep(actor 미전달) → 완료 로그 actor="자동 검수" (#4/#7) ─────────────────
  const { stId: aSt, sw: aSw } = await seedCompleted(A.id, week.id, user, null);
  ck("[1a] A 자동 sweep 완료(전이)", aSw.succeeded === 1, J(aSw.items[0]));
  const aComp = actLogs((await board()).logs, A.act_name).find((l) => l.action === "check_completed");
  ck("[1b #4/#7] 자동 완료 로그 actor_name='자동 검수'", aComp?.actorName === AUTO, `actor=${aComp?.actorName}`);

  // ── 2) 운영자 즉시 검수(actor 전달) → 완료 로그 actor=관리자 이름 (#2) ─────────────────
  //   즉시 검수 route(runProcessCheckRowNow)가 태우는 것과 동일: sweep(scope=qa) + actor 전달.
  const { stId: bSt, sw: bSw } = await seedCompleted(B.id, week.id, user, adminId);
  ck("[2a] B 운영자 sweep 완료(전이)", bSw.succeeded === 1, J(bSw.items[0]));
  const bComp = actLogs((await board()).logs, B.act_name).find((l) => l.action === "check_completed");
  ck("[2b #2] 운영자 완료 로그 actor=관리자 이름(자동 검수 아님)", bComp?.actorName === adminName && bComp?.actorName !== AUTO, `actor=${bComp?.actorName} expect=${adminName}`);

  // ── 3) direct==HTTP — board GET 이 완료 로그 actor 를 동일하게 반영 (#5 즉시반영) ────────
  const bh = await boardHttp();
  const httpComp = (bh.json.data?.logs ?? []).filter((l: any) => l.actName === B.act_name && l.action === "check_completed").map((l: any) => l.actorName);
  ck("[3 direct==HTTP] B 완료 로그 actor HTTP=direct", bh.status === 200 && J(httpComp) === J([bComp?.actorName]), J({ http: httpComp, direct: bComp?.actorName }));

  // ── 4) 실행 취소 direct — rollbackProcessCheckCompletion(A) → 로그 1건 actor=관리자 (#1/#3) ─
  const beforeA = actLogs((await board()).logs, A.act_name).length;
  const rbA = await rollbackProcessCheckCompletion({ statusId: aSt, actor: adminId });
  const aRowStatus = (await sb.from("process_check_statuses").select("status").eq("id", aSt).maybeSingle()).data as any;
  const aLogsAfter = actLogs((await board()).logs, A.act_name);
  const aRbk = aLogsAfter[aLogsAfter.length - 1]; // 최신(맨 아래=최신)
  ck("[4a #1 direct] rollback 성공 → status pending", rbA.ok && rbA.status === "pending" && aRowStatus?.status === "pending", J({ ok: rbA.ok, status: rbA.status }));
  ck("[4b #1] 실행 취소 로그 1건 신규 추가", aLogsAfter.length === beforeA + 1, `before=${beforeA} after=${aLogsAfter.length}`);
  ck("[4c #3] 실행 취소 로그 actor=관리자 이름", aRbk?.actorName === adminName && aRbk?.actorName !== AUTO, `actor=${aRbk?.actorName}`);
  ck("[4d] 실행 취소 로그 action = check_rolled_back(또는 폴백 check_cancelled)", ROLLBACK_ACTIONS.includes(aRbk?.action ?? ""), `action=${aRbk?.action}`);
  const migrationApplied = aRbk?.action === "check_rolled_back";
  console.log(`  · action='${aRbk?.action}' → 마이그레이션(2026-07-04) ${migrationApplied ? "적용됨(정식 라벨 '실행 취소')" : "미적용(폴백 check_cancelled·적용 후 '실행 취소')"}`);

  // ── 5) 실행 취소 HTTP — /api/admin/processes/check/rollback(C) → 동일 결과 (#3 direct==HTTP) ─
  const { stId: cSt } = await seedCompleted(Cc.id, week.id, user, adminId);
  const beforeC = actLogs((await board()).logs, Cc.act_name).length;
  const rbHttp = await http(`/api/admin/processes/check/rollback`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie }, body: J({ statusId: cSt }),
  });
  const cLogsAfter = actLogs((await board()).logs, Cc.act_name);
  const cRbk = cLogsAfter[cLogsAfter.length - 1];
  ck("[5a #1 HTTP] rollback route 200 · status pending", rbHttp.status === 200 && rbHttp.json?.success && rbHttp.json?.data?.status === "pending", J({ status: rbHttp.status, data: rbHttp.json?.data?.status }));
  ck("[5b #1 HTTP] 실행 취소 로그 1건 신규 추가", cLogsAfter.length === beforeC + 1, `before=${beforeC} after=${cLogsAfter.length}`);
  ck("[5c #3 HTTP] 실행 취소 로그 actor=관리자 이름", cRbk?.actorName === adminName && cRbk?.actorName !== AUTO, `actor=${cRbk?.actorName}`);
  ck("[5d #3 direct==HTTP] direct(A)·HTTP(C) 실행 취소 로그 action·actor 동일", aRbk?.action === cRbk?.action && aRbk?.actorName === cRbk?.actorName, J({ direct: `${aRbk?.action}:${aRbk?.actorName}`, http: `${cRbk?.action}:${cRbk?.actorName}` }));

  // ── 6) 멱등 — 이미 pending(취소됨) 행 rollback 재호출 → 추가 로그 X ────────────────────
  const beforeIdem = actLogs((await board()).logs, A.act_name).length;
  const rbIdem = await rollbackProcessCheckCompletion({ statusId: aSt, actor: adminId });
  const afterIdem = actLogs((await board()).logs, A.act_name).length;
  ck("[6 멱등] pending 재-rollback → no-op(추가 로그 없음)", rbIdem.ok && afterIdem === beforeIdem, `status=${rbIdem.status} before=${beforeIdem} after=${afterIdem}`);

  // ── 7) snapshot — accrue=null 경로는 로그/취소가 snapshot 무접촉(#9/#10) ─────────────────
  const snapBefore = await readWeeklyCardsSnapshot(user);
  await logProcessCheckCompletedForRegular(bSt, { adminId: adminId }); // 멱등 → no-op(이미 기록)
  await rollbackProcessCheckCompletion({ statusId: bSt, actor: adminId });
  const snapAfter = await readWeeklyCardsSnapshot(user);
  ck("[7 #9] 로그/취소(accrue=null) 전후 snapshot status 불변", snapBefore.status === snapAfter.status, `before=${snapBefore.status} after=${snapAfter.status}`);
  console.log(`  · #10 보고: 실행 취소 로그는 process_check_logs 1행 INSERT 뿐 — snapshot 무접촉.`);
  console.log(`  · rollback 의 snapshot 재계산은 '적립된 포인트를 회수한 유저'가 있을 때만 발생(기존 동작·본 수정 무변). accrue=null 이라 revokedUserIds=[] → 재계산 스킵.`);

  // ── 7.5) 재검수 허용 — 완료→실행취소→재검수 시 새 [체크 완료] 로그가 시간순으로 남는가 ─────────
  //   (되돌림-인지 dedup: 최신 이벤트가 되돌림이면 재검수는 새 완료 로그로 기록).
  const D = await mkAct("D재검수");
  const { stId: dSt } = await seedCompleted(D.id, week.id, user, adminId); // 완료#1
  await rollbackProcessCheckCompletion({ statusId: dSt, actor: adminId }); // 실행 취소
  // 재검수 — 같은 행(pending) 을 다시 sweep(주입 매칭) → 완료#2.
  await runDueProcessCheckSweep({ scope: "qa", onlyIds: [dSt], ignoreSchedule: true, ignoreRetryGate: true, crawlAndMatch: matchUser(user), accrue: null, actor: adminId });
  const dSeq = (await dbLogs(D.id)).map((l) => `${l.action}:${l.actorName}`);
  const dCompleteCount = (await dbLogs(D.id)).filter((l) => l.action === "check_completed").length;
  ck("[7.5 재검수] 완료→취소→재검수 = [완료, 취소, 완료] 시간순(완료 로그 2건)", dCompleteCount === 2 && dSeq.length === 3 && dSeq[dSeq.length - 1].startsWith("check_completed"), J(dSeq));

  // ── 8) cleanup ────────────────────────────────────────────────────────────────
  await cleanup();
  const leftover = (await sb.from("process_check_logs").select("id", { count: "exact", head: true }).like("act_name", `${TAG}%`)).count ?? 0;
  ck("[8 cleanup] TAG 로그 0", leftover === 0, `logs=${leftover}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error("FATAL:", e?.stack ?? e); try { await cleanup(); } catch {} process.exit(1); });
