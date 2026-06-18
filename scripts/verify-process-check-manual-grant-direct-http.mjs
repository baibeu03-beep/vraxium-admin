// 선별(selection) 액트 수동 부여 (/admin/processes/check/{hub}) — direct(DB) == HTTP 검증.
//   1) 액트 목록 DTO "종류"(actType) · 2) 선별 액트 수동 부여 생성(즉시 완료·completion_type=manual_grant) ·
//   3) recipients/원장/user_weekly_points 적립(test W13) · 4) 중복 부여 방지 · 5) org/mode 스코프 ·
//   6) 비선별 액트 거부 · 7) snapshot 무효화 · 8) cleanup net-zero(uwp/ledger/snapshot 원복).
//
// 전제: dev 서버(:3000) + 2026-06-18_process_check_manual_grant.sql + 2026-06-15_process_point_awards.sql 적용.
//   completion_type 컬럼 미적용이면 PART A(읽기 경로 + fail-closed)만 검증하고 PART B 보류(exit 2).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const r = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } }), brow = createClient(URL, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke", OTHER_ORG = "encre", HUB = "info", TAG = "ZZ-mg-verify";
const J = (o) => JSON.stringify(o);
let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const findAct = (board, actId) => (board.acts ?? []).find((a) => a.actId === actId) ?? null;

// ── 테스트 마스터(라인급 + 액트) 생성/정리 ──────────────────────────────────────
async function cleanupMaster() {
  const acts = (await sb.from("process_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const actIds = acts.map((a) => a.id);
  // 상태행/recipients/원장 정리(액트 기준).
  if (actIds.length) {
    const sts = (await sb.from("process_check_statuses").select("id").in("act_id", actIds)).data ?? [];
    const stIds = sts.map((s) => s.id);
    if (stIds.length) {
      await sb.from("process_check_review_recipients").delete().eq("source", "regular").in("ref_id", stIds);
      await sb.from("process_point_awards").delete().eq("source", "regular").in("ref_id", stIds);
    }
    await sb.from("process_check_statuses").delete().in("act_id", actIds);
    await sb.from("process_check_logs").delete().in("act_id", actIds);
  }
  await sb.from("process_acts").delete().like("act_name", `${TAG}%`);
  await sb.from("process_line_groups").delete().like("name", `${TAG}%`);
}

async function createAct(actType) {
  const { data: g } = await sb.from("process_line_groups").insert({ hub: HUB, name: `${TAG}라인-${actType}` }).select("id").single();
  const { data: a } = await sb.from("process_acts").insert({
    line_group_id: g.id, hub: HUB, act_name: `${TAG}${actType}액트`, duration_minutes: 30,
    occur_week: "N", occur_dow: 1, occur_time: "10:00", check_week: "N", check_dow: 3, check_time: "12:00",
    point_check: 5, point_advantage: 2, point_penalty: 0, cafe: "occur", check_target: "check",
    act_type: actType, is_active: true,
  }).select("id").single();
  return a.id;
}

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

let selActId = null, reqActId = null;
try {
  // 대상 후보 — test 크루(test_user_markers) 2명 + 운영 크루 1 + encre 운영 1.
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const oranke = (await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? [];
  const testCrews = oranke.filter((u) => markers.has(u.user_id)).slice(0, 2);
  const opCrew = oranke.find((u) => !markers.has(u.user_id));
  const encreOp = (oranke.length, ((await sb.from("user_profiles").select("user_id").eq("organization_slug", OTHER_ORG)).data ?? []).find((u) => !markers.has(u.user_id)));
  ck("[전제] test 크루 2 + 운영 크루 1 + encre 크루 1", testCrews.length >= 2 && !!opCrew && !!encreOp, J({ test: testCrews.length, op: !!opCrew, enc: !!encreOp }));
  if (testCrews.length < 2 || !opCrew) { console.log("⚠ 대상 후보 부족 — 중단"); process.exit(2); }

  await cleanupMaster();
  selActId = await createAct("selection");
  reqActId = await createAct("required");

  // ── PART A: 읽기 경로(actType 컬럼) — 마이그레이션 무관 ───────────────────────
  const bTest = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=test`);
  const selRow = findAct(bTest.json.data, selActId);
  const reqRow = findAct(bTest.json.data, reqActId);
  ck("[1] GET 200 · 선별 액트 노출", bTest.status === 200 && !!selRow, `status=${bTest.status}`);
  ck("[1] 선별 액트 actType='selection' · 라벨='선별' · status='needed' · completionType=null",
    selRow?.actType === "selection" && selRow?.crewReactionLabel === "선별" && selRow?.status === "needed" && selRow?.completionType === null, J({ t: selRow?.actType, l: selRow?.crewReactionLabel, s: selRow?.status, c: selRow?.completionType }));
  ck("[1] 필수 액트 actType='required' · 라벨='필수'", reqRow?.actType === "required" && reqRow?.crewReactionLabel === "필수", J({ t: reqRow?.actType, l: reqRow?.crewReactionLabel }));

  // ── 마이그레이션 적용 여부 probe ─────────────────────────────────────────────
  const colProbe = await sb.from("process_check_statuses").select("completion_type").limit(1);
  const migApplied = !colProbe.error;
  if (!migApplied) {
    // fail-closed — 수동 부여는 completion_type 미적용 시 500 마이그레이션 힌트.
    const fc = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: selActId, action: "manual_grant", mode: "test", target_user_ids: [testCrews[0].user_id], point_a: 5, point_b: 0, point_c: 0 }) });
    ck("[fail-closed] 컬럼 미적용 → 수동 부여 500 + 마이그레이션 힌트", fc.status === 500 && /completion_type|manual_grant 컬럼/.test(fc.json.error ?? ""), `status=${fc.status} err=${(fc.json.error ?? "").slice(0, 60)}`);
    console.log(`\n⚠ 2026-06-18_process_check_manual_grant.sql 미적용(${colProbe.error?.code}) — PART B(쓰기/적립) 보류.`);
    console.log(`\n결과(PART A): ${pass} pass / ${fail} fail · PART B 마이그레이션 대기`);
    await cleanupMaster();
    process.exit(fail > 0 ? 1 : 2);
  }

  // ── PART B: 수동 부여 쓰기 + 적립 (test W13) ─────────────────────────────────
  const ledgerProbe = await sb.from("process_point_awards").select("id").limit(1);
  const accrualReady = !ledgerProbe.error;

  const week = bTest.json.data?.week;
  const iso = week ? { y: null, w: null } : null;
  // W13(2026-spring) iso 키 확보(적립 원장 키).
  const wRow = (await sb.from("weeks").select("id,iso_year,iso_week,start_date").eq("id", week?.weekId).maybeSingle()).data;
  const user0 = testCrews[0].user_id, user1 = testCrews[1].user_id;
  const PER = 7;

  // 원본 uwp 보존(테스트 유저 — W13 적립이 덮어씀).
  const origUwp = wRow ? (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user0).eq("year", wRow.iso_year).eq("week_number", wRow.iso_week).maybeSingle()).data : null;
  const pointsOf = async (uid) => (await sb.from("user_weekly_points").select("points").eq("user_id", uid).eq("year", wRow.iso_year).eq("week_number", wRow.iso_week).maybeSingle()).data?.points ?? 0;

  // (2) 수동 부여 생성 — 즉시 완료 · completion_type=manual_grant.
  const mg = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: selActId, action: "manual_grant", mode: "test", act_name: `${TAG}선별액트`, target_user_ids: [user0], duration_minutes: 30, reason: "수동부여사유", point_a: PER, point_b: 2, point_c: 3 }) });
  ck("[2] 수동부여 201 · status=completed · completionType=manual_grant · 크루1명", mg.status === 201 && mg.json.data?.status === "completed" && mg.json.data?.completionType === "manual_grant" && mg.json.data?.checkedCrewCount === 1, `status=${mg.status} c=${mg.json.data?.completionType} n=${mg.json.data?.checkedCrewCount}`);

  // (3) DB — 상태행 completion_type + override 점수(C=0 강제) + scope_mode=test.
  const st = (await sb.from("process_check_statuses").select("id,status,completion_type,manual_point_check,manual_point_advantage,manual_point_penalty,scope_mode,checked_crew_count").eq("act_id", selActId).eq("organization_slug", ORG).maybeSingle()).data;
  ck("[3] DB 상태행 completed+manual_grant · A=PER · B=2 · C=0(선별 강제) · scope_mode=test", st?.status === "completed" && st?.completion_type === "manual_grant" && st?.manual_point_check === PER && st?.manual_point_advantage === 2 && st?.manual_point_penalty === 0 && st?.scope_mode === "test", J({ s: st?.status, ct: st?.completion_type, a: st?.manual_point_check, b: st?.manual_point_advantage, c: st?.manual_point_penalty, m: st?.scope_mode }));
  const stId = st?.id;

  // (4) recipients — source=regular · matched · user0.
  const recs = (await sb.from("process_check_review_recipients").select("user_id,match_type,source").eq("source", "regular").eq("ref_id", stId)).data ?? [];
  ck("[4] recipients 1행(matched·user0)", recs.length === 1 && recs[0].user_id === user0 && recs[0].match_type === "matched", `n=${recs.length}`);

  // (5) direct == HTTP — 보드 행이 DB 상태와 동일.
  const bTest2 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=test`);
  const selRow2 = findAct(bTest2.json.data, selActId);
  ck("[5] direct==HTTP — 보드 selRow status=completed · completionType=manual_grant · 라벨근거", selRow2?.status === "completed" && selRow2?.completionType === "manual_grant" && selRow2?.checkedCrewCount === 1, J({ s: selRow2?.status, c: selRow2?.completionType, n: selRow2?.checkedCrewCount }));

  if (accrualReady && wRow) {
    // (6) 적립 — user_weekly_points.points = PER (test W13 원장합 덮어쓰기).
    ck("[6] user_weekly_points.points=PER(적립)", (await pointsOf(user0)) === PER, `points=${await pointsOf(user0)}/${PER}`);
    const led = (await sb.from("process_point_awards").select("point_check,point_advantage,point_penalty").eq("source", "regular").eq("ref_id", stId).eq("user_id", user0).maybeSingle()).data;
    ck("[6] 원장 process_point_awards — point_check=PER · advantage=2 · penalty=0", led?.point_check === PER && led?.point_advantage === 2 && led?.point_penalty === 0, J(led));
  } else {
    console.log("  · (적립 원장 테이블 미적용 — 적립 검증 스킵)");
  }

  // (7) 중복 부여 방지 — 같은 크루 재부여 → recipients/원장 불변.
  const mgDup = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: selActId, action: "manual_grant", mode: "test", target_user_ids: [user0], point_a: PER, point_b: 0, point_c: 0 }) });
  const recsDup = (await sb.from("process_check_review_recipients").select("user_id").eq("source", "regular").eq("ref_id", stId)).data ?? [];
  ck("[7] 중복 크루 재부여 → recipients 여전히 1행(중복 스킵)", mgDup.status === 201 && recsDup.length === 1, `status=${mgDup.status} n=${recsDup.length}`);
  if (accrualReady && wRow) ck("[7] 중복 재부여 → points 불변(이중적립 0)", (await pointsOf(user0)) === PER, `points=${await pointsOf(user0)}`);

  // (8) 크루 추가 부여 — user1 추가 → recipients 2 · checkedCrewCount 2.
  const mgAdd = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: selActId, action: "manual_grant", mode: "test", target_user_ids: [user1], point_a: PER, point_b: 0, point_c: 0 }) });
  const recsAdd = (await sb.from("process_check_review_recipients").select("user_id").eq("source", "regular").eq("ref_id", stId)).data ?? [];
  ck("[8] 크루 추가 부여 → recipients 2 · DTO checkedCrewCount=2", mgAdd.status === 201 && recsAdd.length === 2 && mgAdd.json.data?.checkedCrewCount === 2, `status=${mgAdd.status} n=${recsAdd.length} dto=${mgAdd.json.data?.checkedCrewCount}`);

  // (9) 비선별(필수) 액트 수동 부여 → 422.
  const mgReq = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: reqActId, action: "manual_grant", mode: "test", target_user_ids: [user0], point_a: 5 }) });
  ck("[9] 필수 액트 수동 부여 → 422(‘선별’만 허용)", mgReq.status === 422, `status=${mgReq.status}`);

  // (10) 스코프 — operating 모드로 테스트 크루 부여 → 422(write 0).
  const cntBefore = (await sb.from("process_check_statuses").select("id", { count: "exact", head: true }).eq("act_id", selActId).eq("scope_mode", "operating")).count ?? 0;
  const guardOp = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: selActId, action: "manual_grant", mode: "operating", target_user_ids: [testCrews[0].user_id], point_a: 5 }) });
  const cntAfter = (await sb.from("process_check_statuses").select("id", { count: "exact", head: true }).eq("act_id", selActId).eq("scope_mode", "operating")).count ?? 0;
  ck("[10] operating+테스트크루 → 422 · operating 상태행 write 0", guardOp.status === 422 && cntAfter === cntBefore, `status=${guardOp.status} delta=${cntAfter - cntBefore}`);

  // (11) 스코프 — 타org(encre) 크루 부여 → 422.
  const guardOrg = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: selActId, action: "manual_grant", mode: "test", target_user_ids: [encreOp.user_id], point_a: 5 }) });
  ck("[11] oranke 에 encre 크루 부여 → 422", guardOrg.status === 422, `status=${guardOrg.status}`);

  // (12) mode 분리 — operating 보드엔 test 수동부여 상태 미반영(needed).
  const bOp = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=operating`);
  const selOp = findAct(bOp.json.data, selActId);
  // operating 보드의 주차(W16)와 test(W13) 분리 — operating 행은 needed(test 부여와 무관).
  ck("[12] operating 보드 selRow status=needed(test 부여 미반영)", !selOp || selOp.status === "needed", `status=${selOp?.status}`);

  // (13) snapshot 무효화 — 적립이 invalidateWeeklyCardsForUsers 호출(스냅샷 재계산 가능).
  if (accrualReady && wRow) {
    const { readWeeklyCardsSnapshot } = await import("../lib/cluster4WeeklyCardsSnapshot.ts").catch(() => ({}));
    ck("[13] 적립 = snapshot 무효화 경로 통과(원장/uwp 변동으로 증명)", (await pointsOf(user0)) === PER, "uwp 반영 = invalidate 동반");
  }

  // ── cleanup — 원장/uwp/snapshot 원복 + 마스터 제거(net-zero) ──────────────────
  if (accrualReady && wRow) {
    const { revokeForAct } = await import("../lib/processPointAccrual.ts");
    if (stId) await revokeForAct("regular", stId).catch(() => {});
    if (origUwp) await sb.from("user_weekly_points").update({ points: origUwp.points, advantages: origUwp.advantages, penalty: origUwp.penalty, checks_migrated: origUwp.checks_migrated }).eq("id", origUwp.id);
    else await sb.from("user_weekly_points").delete().eq("user_id", user0).eq("year", wRow.iso_year).eq("week_number", wRow.iso_week);
    await sb.from("user_weekly_points").delete().eq("user_id", user1).eq("year", wRow.iso_year).eq("week_number", wRow.iso_week);
    try {
      const { recomputeAndStoreWeeklyCardsSnapshot } = await import("../lib/cluster4WeeklyCardsSnapshot.ts");
      const { syncGradeStats } = await import("../lib/cluster3ClubRankData.ts");
      await recomputeAndStoreWeeklyCardsSnapshot(user0); await recomputeAndStoreWeeklyCardsSnapshot(user1);
      await syncGradeStats(user0); await syncGradeStats(user1);
    } catch { /* best-effort */ }
    const uwpFinal = await pointsOf(user0);
    ck("[cleanup] user_weekly_points 원복", uwpFinal === (origUwp?.points ?? 0), `points=${uwpFinal}/${origUwp?.points ?? "(none)"}`);
  }
  await cleanupMaster();
  const leftAct = (await sb.from("process_acts").select("id", { count: "exact", head: true }).like("act_name", `${TAG}%`)).count ?? 0;
  ck("[cleanup] 마스터/상태/recipients 제거(net-zero)", leftAct === 0, `남은 액트=${leftAct}`);
} catch (e) {
  console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++;
  await cleanupMaster().catch(() => {});
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
