/**
 * 검증: 라인 개설 대상자 등록 시 Point A·B 즉시 지급(pay-once) — payLineOpenTargetsOnce.
 *   npx tsx --env-file=.env.local scripts/verify-line-open-payout-once.ts
 *
 * 커버: 대상자 등록 즉시 지급 · A/B 매트릭스 · 멱등(재호출) · pay-once(설정변경/재등록/삭제 후 유지) ·
 *       openExperienceDrafts 실제 경로 · 원장 전후 수치 · test 모드. 운영 데이터 무접촉(테스트유저+is_qa_test).
 *   ※ HTTP 인증(requireAdmin=Supabase 세션)은 이 환경에서 불가 → 라우트가 호출하는 서버 함수/시퀀스를
 *      동일하게 구동한다(동일 공통 함수 payLineOpenTargetsOnce · 실제 openExperienceDrafts).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { payLineOpenTargetsOnce } from "@/lib/processPointAccrual";
import { openExperienceDrafts } from "@/lib/adminExperienceDraftData";

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

const WEEK_ID = "39aae7a0-216f-4262-8a67-6beef1bccf22"; // 2026-summer W2 (iso 2026/28)
const YEAR = 2026, ISOWK = 28;

async function awards(refId: string) {
  const { data } = await supabaseAdmin.from("process_point_awards")
    .select("user_id,point_check,point_advantage,scope_mode,organization_slug")
    .eq("source", "line").eq("ref_id", refId);
  return (data ?? []) as Array<{ user_id: string; point_check: number; point_advantage: number; scope_mode: string }>;
}
async function uwp(userId: string) {
  const { data } = await supabaseAdmin.from("user_weekly_points")
    .select("points,advantages").eq("user_id", userId).eq("year", YEAR).eq("week_number", ISOWK).maybeSingle();
  return data as { points: number; advantages: number } | null;
}
async function setConfig(org: string, hub: string, key: string, a: number | null, b: number | null) {
  await supabaseAdmin.from("cluster4_line_point_configs").upsert(
    { organization_slug: org, hub, config_key: key, point_a: a, point_b: b, updated_at: new Date().toISOString() },
    { onConflict: "organization_slug,hub,config_key" });
}
async function readConfig(org: string, hub: string, key: string) {
  const { data } = await supabaseAdmin.from("cluster4_line_point_configs")
    .select("point_a,point_b").eq("organization_slug", org).eq("hub", hub).eq("config_key", key).maybeSingle();
  return data as { point_a: number | null; point_b: number | null } | null;
}

const NOW = new Date().toISOString();
const LATER = new Date(Date.now() + 7 * 86400000).toISOString();

// 통제 역량 라인 생성(고유 line_code=config_key → 완전 격리).
async function mkCompLine(code: string, users: string[]): Promise<{ lineId: string; masterId: string }> {
  await cleanupComp(code);
  const { data: m } = await supabaseAdmin.from("cluster4_competency_line_masters")
    .insert({ organization_slug: "common", line_code: code, line_name: "[검증]", main_title: "[검증]", is_active: true }).select("id").single();
  const masterId = (m as { id: string }).id;
  const { data: l } = await supabaseAdmin.from("cluster4_lines")
    .insert({ part_type: "competency", competency_line_master_id: masterId, line_code: code, main_title: "[검증]", is_active: true, is_qa_test: true, submission_opens_at: NOW, submission_closes_at: LATER })
    .select("id").single();
  const lineId = (l as { id: string }).id;
  if (users.length) await supabaseAdmin.from("cluster4_line_targets")
    .insert(users.map((uid) => ({ line_id: lineId, week_id: WEEK_ID, target_mode: "user", target_user_id: uid, target_rule: {} })));
  return { lineId, masterId };
}
async function cleanupComp(code: string) {
  const { data: old } = await supabaseAdmin.from("cluster4_lines").select("id").eq("line_code", code);
  const ids = ((old ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length) {
    await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").in("ref_id", ids);
    await supabaseAdmin.from("cluster4_line_targets").delete().in("line_id", ids);
    await supabaseAdmin.from("cluster4_lines").delete().in("id", ids);
  }
  await supabaseAdmin.from("cluster4_competency_line_masters").delete().eq("line_code", code);
  await supabaseAdmin.from("cluster4_line_point_configs").delete().eq("hub", "competency").eq("config_key", code);
}

async function main() {
  const { data: tm } = await supabaseAdmin.from("test_user_markers").select("user_id").limit(2);
  const users = (tm ?? []).map((r) => (r as { user_id: string }).user_id);
  if (users.length < 2) { console.error("need >=2 test markers"); process.exit(1); }
  const [u1, u2] = users;
  const { data: adm } = await supabaseAdmin.from("admin_users").select("id").limit(1);
  const ADMIN = ((adm ?? []) as Array<{ id: string }>)[0]?.id;
  if (!ADMIN) { console.error("need an admin_users row for actor FK"); process.exit(1); }

  // 사전 정리(이전 잔여).
  await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").eq("year", YEAR).eq("week_number", ISOWK).in("user_id", [u1, u2]);
  await supabaseAdmin.from("user_weekly_points").delete().eq("year", YEAR).eq("week_number", ISOWK).in("user_id", [u1, u2]);

  // ── 1) 대상자 등록 즉시 지급 + 원장 전후 + test 모드 ──
  const CODE1 = "VTESTONCE-BS9101";
  const { lineId: L1 } = await mkCompLine(CODE1, [u1, u2]);
  await setConfig("common", "competency", CODE1, 3, 2);
  const beforeU1 = await uwp(u1);
  await payLineOpenTargetsOnce(L1);
  let aw = await awards(L1);
  const afterU1 = await uwp(u1);
  ck("① 대상자 2명 즉시 지급(check=3 adv=2)", aw.length === 2 && aw.every((a) => a.point_check === 3 && a.point_advantage === 2), { n: aw.length, sample: aw[0] });
  ck("① scope_mode=test(is_qa_test)", aw.every((a) => a.scope_mode === "test"));
  ck("① 원장 전후 u1: points +3 / advantages +2", (beforeU1?.points ?? 0) + 3 === (afterU1?.points ?? 0) && (beforeU1?.advantages ?? 0) + 2 === (afterU1?.advantages ?? 0), { before: beforeU1, after: afterU1 });

  // ── 2) 멱등: 동일 요청 재호출 → 중복 지급 없음 ──
  await payLineOpenTargetsOnce(L1);
  await payLineOpenTargetsOnce(L1);
  aw = await awards(L1);
  const afterU1b = await uwp(u1);
  ck("② 재호출 3회 총합 여전히 2행(중복 없음)", aw.length === 2);
  ck("② 원장 불변", (afterU1?.points ?? 0) === (afterU1b?.points ?? 0), afterU1b);

  // ── 3) pay-once: 설정값을 올려도 이미 지급분은 불변 ──
  await setConfig("common", "competency", CODE1, 9, 9);
  await payLineOpenTargetsOnce(L1);
  aw = await awards(L1);
  ck("③ 설정 9/9 변경 후 재지급 시도 → 기존 3/2 유지(pay-once)", aw.length === 2 && aw.every((a) => a.point_check === 3 && a.point_advantage === 2), aw[0]);

  // ── 4) pay-once: 대상자 제외 후 재등록 → 회수 없음·재지급 없음 ──
  await supabaseAdmin.from("cluster4_line_targets").delete().eq("line_id", L1).eq("target_user_id", u2);
  await payLineOpenTargetsOnce(L1); // 제외 상태 — 회수 없어야
  aw = await awards(L1);
  ck("④a 대상자 u2 제외해도 원장 유지(회수 없음, 여전히 2행)", aw.length === 2 && aw.some((a) => a.user_id === u2));
  await supabaseAdmin.from("cluster4_line_targets").insert({ line_id: L1, week_id: WEEK_ID, target_mode: "user", target_user_id: u2, target_rule: {} });
  await payLineOpenTargetsOnce(L1); // 재등록 — 재지급 없어야
  aw = await awards(L1);
  ck("④b u2 재등록해도 재지급 없음(여전히 2행·3/2)", aw.length === 2 && aw.filter((a) => a.user_id === u2).length === 1 && aw.every((a) => a.point_check === 3));

  // ── 5) 삭제해도 지급 포인트 유지(회수 없음) ──
  await supabaseAdmin.from("cluster4_line_targets").delete().eq("line_id", L1);
  await supabaseAdmin.from("cluster4_lines").delete().eq("id", L1);
  aw = await awards(L1);
  ck("⑤ 라인 삭제 후에도 원장 2행 유지(회수 없음)", aw.length === 2);

  // ── 6) A/B 매트릭스(라인별 격리) ──
  const CODE_A = "VTESTONCE-BS9102", CODE_B = "VTESTONCE-BS9103", CODE_0 = "VTESTONCE-BS9104", CODE_N = "VTESTONCE-BS9105";
  const { lineId: LA } = await mkCompLine(CODE_A, [u1]); await setConfig("common", "competency", CODE_A, 5, null);
  await payLineOpenTargetsOnce(LA); let a = await awards(LA);
  ck("⑥ A만(5,null) → check=5 adv=0", a.length === 1 && a[0].point_check === 5 && a[0].point_advantage === 0, a[0]);
  const { lineId: LB } = await mkCompLine(CODE_B, [u1]); await setConfig("common", "competency", CODE_B, null, 4);
  await payLineOpenTargetsOnce(LB); a = await awards(LB);
  ck("⑥ B만(null,4) → check=0 adv=4", a.length === 1 && a[0].point_check === 0 && a[0].point_advantage === 4, a[0]);
  const { lineId: L0 } = await mkCompLine(CODE_0, [u1]); await setConfig("common", "competency", CODE_0, 0, 0);
  await payLineOpenTargetsOnce(L0); a = await awards(L0);
  ck("⑥ 둘 다 0 → 불필요한 원장 없음(0행)", a.length === 0, { n: a.length });
  const { lineId: LN } = await mkCompLine(CODE_N, [u1]); await setConfig("common", "competency", CODE_N, null, null);
  await payLineOpenTargetsOnce(LN); a = await awards(LN);
  ck("⑥ 둘 다 null → 지급 없음(0행)", a.length === 0, { n: a.length });

  // ── 7) 경험 실제 경로 openExperienceDrafts (config_key=category, 저장복원) ──
  const EXP_CODE = "VTESTONCE-BS9106"; const CAT = "management", SLOT = 5;
  const savedCfg = await readConfig("common", "experience", CAT);
  await supabaseAdmin.from("cluster4_experience_line_drafts").delete().eq("line_code", EXP_CODE);
  await cleanupExp(EXP_CODE);
  const { data: em } = await supabaseAdmin.from("cluster4_experience_line_masters")
    .insert({ line_code: EXP_CODE, line_name: "[검증]", experience_category: CAT, experience_slot_order: SLOT, organization_slug: "common", is_active: true }).select("id").single();
  const expMasterId = (em as { id: string }).id;
  const { data: drafts, error: draftErr } = await supabaseAdmin.from("cluster4_experience_line_drafts").insert(
    [u1, u2].map((uid) => ({ week_id: WEEK_ID, organization_slug: "common", team_id: null, part_name: null, target_user_id: uid,
      experience_line_master_id: expMasterId, line_code: EXP_CODE, main_title: "[검증]", output_link_1: null, output_link_2: null,
      output_links: [], output_images: [], rating: null, input_status: "submitted", review_status: "approved", open_status: "pending",
      entered_by: ADMIN, entered_at: NOW }))).select("id");
  if (draftErr) { console.error("draft insert failed:", draftErr.message); process.exit(1); }
  const draftIds = ((drafts ?? []) as Array<{ id: string }>).map((r) => r.id);
  await setConfig("common", "experience", CAT, 4, 1);
  const beforeExp = await uwp(u1);
  const res = await openExperienceDrafts(draftIds, ADMIN);
  ck("⑦ openExperienceDrafts 개설(라인1·타깃2)", res.linesCreated >= 1 && res.targetsCreated === 2, { l: res.linesCreated, t: res.targetsCreated });
  const { data: el } = await supabaseAdmin.from("cluster4_lines").select("id").eq("line_code", EXP_CODE).eq("is_active", true);
  const EL = ((el ?? []) as Array<{ id: string }>)[0].id;
  const eaw = await awards(EL);
  const afterExp = await uwp(u1);
  ck("⑦ ★경험 개설 즉시 지급(2명 check=4 adv=1)", eaw.length === 2 && eaw.every((x) => x.point_check === 4 && x.point_advantage === 1), { n: eaw.length, sample: eaw[0] });
  ck("⑦ 원장 전후 u1: points +4 / advantages +1", (beforeExp?.points ?? 0) + 4 === (afterExp?.points ?? 0) && (beforeExp?.advantages ?? 0) + 1 === (afterExp?.advantages ?? 0), { before: beforeExp, after: afterExp });
  await payLineOpenTargetsOnce(EL);
  ck("⑦ 재호출 멱등(2행)", (await awards(EL)).length === 2);

  // ── 정리 ──
  for (const c of [CODE1, CODE_A, CODE_B, CODE_0, CODE_N]) await cleanupComp(c);
  { const { data: elx } = await supabaseAdmin.from("cluster4_lines").select("id").eq("line_code", EXP_CODE);
    const ids = ((elx ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length) {
      await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").in("ref_id", ids);
      const { data: tg } = await supabaseAdmin.from("cluster4_line_targets").select("id").in("line_id", ids);
      const tids = ((tg ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (tids.length) await supabaseAdmin.from("cluster4_experience_line_evaluations").delete().in("line_target_id", tids);
      await supabaseAdmin.from("cluster4_line_targets").delete().in("line_id", ids);
      await supabaseAdmin.from("cluster4_lines").delete().in("id", ids);
    } }
  await supabaseAdmin.from("cluster4_experience_line_drafts").delete().in("id", draftIds);
  await supabaseAdmin.from("cluster4_experience_line_masters").delete().eq("id", expMasterId);
  if (savedCfg) await setConfig("common", "experience", CAT, savedCfg.point_a, savedCfg.point_b);
  else await supabaseAdmin.from("cluster4_line_point_configs").delete().eq("organization_slug", "common").eq("hub", "experience").eq("config_key", CAT);
  await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").eq("year", YEAR).eq("week_number", ISOWK).in("user_id", [u1, u2]);
  for (const u of [u1, u2]) {
    const { data: rem } = await supabaseAdmin.from("process_point_awards").select("id").eq("user_id", u).eq("year", YEAR).eq("week_number", ISOWK).limit(1);
    if (!rem || rem.length === 0) await supabaseAdmin.from("user_weekly_points").delete().eq("user_id", u).eq("year", YEAR).eq("week_number", ISOWK);
  }
  ck("정리 완료", true);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
async function cleanupExp(code: string) {
  const { data: old } = await supabaseAdmin.from("cluster4_lines").select("id").eq("line_code", code);
  const ids = ((old ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length) {
    await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").in("ref_id", ids);
    await supabaseAdmin.from("cluster4_line_targets").delete().in("line_id", ids);
    await supabaseAdmin.from("cluster4_lines").delete().in("id", ids);
  }
  await supabaseAdmin.from("cluster4_experience_line_masters").delete().eq("line_code", code);
}
main().catch((e) => { console.error(e); process.exit(1); });
