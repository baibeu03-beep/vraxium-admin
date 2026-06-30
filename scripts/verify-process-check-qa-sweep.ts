/**
 * Phase C — process-check 자동검수 sweep QA 분기 검증 (direct + HTTP).
 *   scope='qa' sweep 이:
 *     · scope_mode='test' 항목만 처리(operating 항목 강제 제외 = fail-safe)
 *     · 테스트 유저 process/points/ledger/uws/snapshot 만 반영(실유저 무접촉)
 *     · qa_action_log(action='sweep') 기록
 *     · 운영 모드 sweep 동작 불변 / 운영·QA 대상 user_id 교집합 0
 *   인지 W13(2026-spring 테스트 예외 주차) + 테스트 유저로만 검증(실유저 무접촉). cleanup 원복.
 *
 *   선행: admin(:3000) + process_point_awards.sql + qa_overlay_state.sql + INTERNAL_API_KEY.
 *   npx tsx --env-file=.env.local scripts/verify-process-check-qa-sweep.ts
 */
import { createClient } from "@supabase/supabase-js";
import { runDueProcessCheckSweep } from "@/lib/processCheckDueSweep";
import { accrueForCompletedRegular, revokeForAct } from "@/lib/processPointAccrual";
import { readWeeklyCardsSnapshot, recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const KEY = process.env.INTERNAL_API_KEY;
const BASE = process.env.WORKER_BASE_URL ?? "http://localhost:3000";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-qasweep";
const PAST = "2020-01-01T00:00:00.000Z";
const ORG = "oranke";
const PER = 7;
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`${ok ? "✅" : "❌"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const matchUser = (userId: string) => async () => ({ matched: [{ userId, nickname: `${TAG} 닉`, reason: "test" }], review: [] as any[] });
const throwCrawl = async () => { throw new Error("crawl boom"); };
const accrue = (_s: "regular" | "irregular", refId: string) => accrueForCompletedRegular(refId);
async function http(body: unknown, qs = "") {
  const res = await fetch(`${BASE}/api/admin/processes/check/run-due-checks${qs}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(KEY ? { "x-internal-api-key": KEY } : {}) }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function cleanup() {
  const grp = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  const gIds = (grp as any[]).map((g) => g.id);
  if (gIds.length) {
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", gIds)).data ?? [];
    const aIds = (acts as any[]).map((a) => a.id);
    if (aIds.length) {
      const sts = (await sb.from("process_check_statuses").select("id").in("act_id", aIds)).data ?? [];
      for (const sid of (sts as any[]).map((s) => s.id)) {
        await sb.from("process_check_review_recipients").delete().eq("ref_id", sid);
        await sb.from("process_point_awards").delete().eq("source", "regular").eq("ref_id", sid);
      }
      await sb.from("process_check_logs").delete().in("act_id", aIds);
      await sb.from("process_check_statuses").delete().in("act_id", aIds);
      await sb.from("process_acts").delete().in("id", aIds);
    }
    await sb.from("process_line_groups").delete().in("id", gIds);
  }
}

async function main() {
  if (!KEY) { console.log("⚠ INTERNAL_API_KEY 미설정 — HTTP 검증 불가"); process.exit(2); }
  if ((await sb.from("qa_action_log").select("id").limit(1)).error) { console.log("⚠ qa_action_log 미적용"); process.exit(2); }
  if ((await sb.from("process_point_awards").select("id").limit(1)).error) { console.log("⚠ process_point_awards 미적용"); process.exit(2); }

  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const realUser = oranke.find((u) => !markers.has(u.user_id))?.user_id;
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,start_date").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  ck("[전제] test유저·실유저·W13", !!user && !!realUser && !!week?.id);
  if (!user || !realUser || !week?.id) { console.log(`\n${pass} pass / ${fail} fail`); process.exit(2); }
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const pointsOf = async (uid: string) => ((await sb.from("user_weekly_points").select("points").eq("user_id", uid).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any)?.points ?? 0;
  const snapAt = async (uid: string) => { const s = await readWeeklyCardsSnapshot(uid); return s.status === "hit" || s.status === "stale" ? (s as any).computedAt : null; };

  const origUserRow = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  const realPtsBefore = await pointsOf(realUser);
  const realSnapBefore = await snapAt(realUser);
  const logMaxBefore = ((await sb.from("qa_action_log").select("id").eq("action", "sweep").order("id", { ascending: false }).limit(1)).data?.[0] as any)?.id ?? 0;

  await cleanup();
  // ── 시드: test 항목 2개 + operating 항목 1개(전부 W13·pending·scheduled past) ──
  const grp = (await sb.from("process_line_groups").insert({ hub: "info", name: `${TAG} 라인급` }).select("id").single()).data as any;
  const mkAct = async (n: number) => (await sb.from("process_acts").insert({
    line_group_id: grp.id, hub: "info", act_name: `${TAG} 액트${n}`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: PER, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
  }).select("id").single()).data as any;
  const mkStatus = async (actId: string, link: string, scope_mode: string) => (await sb.from("process_check_statuses").insert({
    organization_slug: ORG, hub: "info", week_id: week.id, line_group_id: grp.id, act_id: actId,
    status: "pending", review_link: link, scheduled_check_at: PAST, scope_mode,
  }).select("id").single()).data as any;
  const aT = await mkAct(1), aOp = await mkAct(2), aT2 = await mkAct(3), aT3 = await mkAct(4);
  const testStatus = (await mkStatus(aT.id, "https://cafe.naver.com/x/1", "test")).id;
  const opStatus = (await mkStatus(aOp.id, "https://cafe.naver.com/x/2", "operating")).id;
  const testStatus2 = (await mkStatus(aT2.id, "https://example.com/not-cafe", "test")).id; // HTTP 실패 경로용
  const testStatus3 = (await mkStatus(aT3.id, "https://cafe.naver.com/x/3", "test")).id;    // direct 실패 경로용(쿨다운 분리)
  ck("[시드] test 3 + operating 1", !!testStatus && !!opStatus && !!testStatus2 && !!testStatus3);

  // 적립은 user_weekly_points = process_point_awards(user,week) 합 재계산이므로, 검증 기준은
  //   "스윕 직전 원장 합(ledgerBefore)" + PER. (user_weekly_points 저장값은 원장과 다를 수 있음.)
  const ledgerSum = async () => (((await sb.from("process_point_awards").select("point_check").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w)).data ?? []) as any[]).reduce((s, r) => s + (r.point_check || 0), 0);
  const ledgerBefore = await ledgerSum();

  // ── 1) QA sweep(scope='qa') — test 항목만 처리, operating 항목 강제 제외 ──
  const r = await runDueProcessCheckSweep({ scope: "qa", onlyIds: [testStatus, opStatus], crawlAndMatch: matchUser(user), accrue });
  ck("[1 QA sweep] succeeded=1(test만)·op 제외", r.succeeded === 1 && r.items.length === 1 && r.items[0].id === testStatus, J({ ok: r.succeeded, ids: r.items.map((i) => i.id) }));
  const opRow = (await sb.from("process_check_statuses").select("status").eq("id", opStatus).maybeSingle()).data as any;
  ck("[2 operating 항목 미처리] pending 유지", opRow?.status === "pending");
  const opLed = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("ref_id", opStatus)).count ?? 0;
  ck("[3 operating 항목 ledger 0]", opLed === 0);

  // 테스트 유저 반영(요구1·4·8) — points = 원장합. 스윕으로 PER 원장 1건 추가 → before+PER.
  ck("[4 테스트 유저 points = ledgerBefore + PER]", (await pointsOf(user)) === ledgerBefore + PER, `before=${ledgerBefore} after=${await pointsOf(user)} (+${PER})`);
  const rec = (await sb.from("process_check_review_recipients").select("user_id,scope_mode").eq("ref_id", testStatus)).data ?? [];
  ck("[5 recipients=테스트 유저·scope_mode=test]", (rec as any[]).some((x) => x.user_id === user && x.scope_mode === "test"));
  ck("[6 교집합0] QA 대상 user_id ⊆ test_user_markers", (rec as any[]).every((x) => !x.user_id || markers.has(x.user_id)));
  const snap = await readWeeklyCardsSnapshot(user);
  ck("[7 테스트 유저 snapshot invalidate→재계산(hit)]", snap.status === "hit");

  // 실유저 무접촉(요구2).
  ck("[8 실유저 points 불변]", (await pointsOf(realUser)) === realPtsBefore);
  ck("[9 실유저 snapshot 불변]", (await snapAt(realUser)) === realSnapBefore);

  // qa_action_log(요구7).
  const newLogs = (await sb.from("qa_action_log").select("id,action,after_json").eq("action", "sweep").gt("id", logMaxBefore)).data ?? [];
  ck("[10 qa_action_log sweep 기록]", (newLogs as any[]).length >= 1 && (newLogs as any[]).some((l) => (l.after_json?.itemIds ?? []).includes(testStatus)));

  // ── 11) fail-safe — scope='qa' + modes=['operating'] 도 test 항목만(operating 강제 제외) ──
  const rFs = await runDueProcessCheckSweep({ scope: "qa", modes: ["operating"], onlyIds: [opStatus], crawlAndMatch: matchUser(realUser), accrue });
  ck("[11 fail-safe] scope=qa면 operating 항목 eligible 0", rFs.eligible === 0);

  // ── 12) direct == HTTP (operating 항목이 qa scope 에서 제외되는 관측 동일) ──
  const dOp = await runDueProcessCheckSweep({ scope: "qa", onlyIds: [opStatus], crawlAndMatch: matchUser(user), accrue });
  const hOp = await http({ onlyIds: [opStatus] }, "?mode=test");
  ck("[12 direct==HTTP] qa scope operating 항목 eligible 0 동일", dOp.eligible === 0 && hOp.status === 200 && hOp.json?.data?.eligible === 0, J({ direct: dOp.eligible, http: hOp.json?.data?.eligible }));
  // 13) HTTP qa scope 가 test 항목을 포함해 처리(실 크롤=invalid_url→failed) == direct(throwCrawl→failed).
  //   쿨다운 회피 위해 HTTP=testStatus2 / direct=testStatus3(별개 항목).
  const hT = await http({ onlyIds: [testStatus2] }, "?mode=test");
  const dT = await runDueProcessCheckSweep({ scope: "qa", onlyIds: [testStatus3], crawlAndMatch: throwCrawl, accrue });
  ck("[13 direct==HTTP] qa scope test 항목 처리(둘 다 failed=1)", hT.json?.data?.failed === 1 && dT.failed === 1, J({ http: hT.json?.data?.failed, direct: dT.failed }));

  // ── 14) 운영 모드 sweep 회귀 — scope 미지정(operating)은 modes/항목 분기 불변(operating 항목 처리 가능) ──
  //   실유저 무접촉 위해 accrue=null(적립 없음)·crawl 빈매칭으로 operating 항목 완료만 관측.
  const rOp = await runDueProcessCheckSweep({ onlyIds: [opStatus], crawlAndMatch: async () => ({ matched: [], review: [] }), accrue: null });
  ck("[14 운영 sweep 회귀] scope 미지정 operating 항목 처리(succeeded=1)", rOp.succeeded === 1 && rOp.items[0]?.id === opStatus);

  // ── cleanup 원복 ── (내 시드 원장만 제거 — 사전 존재 원장은 보존)
  await revokeForAct("regular", testStatus).catch(() => {}); // testStatus 원장행만 삭제 + 재계산
  await cleanup(); // TAG ref_id 기반 recipients/ledger/statuses/acts/group 정리
  // user_weekly_points 를 스윕 직전 저장값으로 원복(원장 합과 다를 수 있는 사전 상태 보존).
  if (origUserRow) await sb.from("user_weekly_points").update({ points: origUserRow.points, advantages: origUserRow.advantages, penalty: origUserRow.penalty, checks_migrated: origUserRow.checks_migrated }).eq("id", origUserRow.id);
  else await sb.from("user_weekly_points").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  await sb.from("qa_action_log").delete().eq("action", "sweep").gt("id", logMaxBefore);
  const ledLeft = await ledgerSum();
  ck("[15 cleanup] 내 원장 제거(=ledgerBefore)·points 원복·실유저 불변", ledLeft === ledgerBefore && (await pointsOf(user)) === (origUserRow?.points ?? 0) && (await pointsOf(realUser)) === realPtsBefore, `ledger ${ledgerBefore}→${ledLeft}`);

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
