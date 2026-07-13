/**
 * 검증: 라인 개설 포인트 지급(source='line') — 실제 원장(process_point_awards)+user_weekly_points.
 *   npx tsx --env-file=.env.local scripts/verify-line-open-payout.ts
 *
 * 통제 테스트는 test_user_markers + is_qa_test 라인 + 고유 config_key(career=line_code)로 수행 →
 * 운영 데이터/실사용자 포인트 무접촉. 종료 시 생성물(awards·targets·lines·configs·uwp) 전량 정리.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  reconcileLineOpenAward,
  revokeLineOpenAward,
  reconcileLinePayoutsForConfig,
} from "@/lib/processPointAccrual";

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

const WEEK_ID = "39aae7a0-216f-4262-8a67-6beef1bccf22"; // 2026-summer W2 (iso 2026/28)
const YEAR = 2026, ISOWK = 28;

async function awardsFor(refId: string) {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id,point_check,point_advantage,point_penalty,scope_mode,organization_slug,source")
    .eq("source", "line").eq("ref_id", refId);
  return (data ?? []) as Array<{ user_id: string; point_check: number; point_advantage: number; point_penalty: number; scope_mode: string; organization_slug: string | null }>;
}
async function uwp(userId: string) {
  const { data } = await supabaseAdmin.from("user_weekly_points")
    .select("points,advantages,penalty").eq("user_id", userId).eq("year", YEAR).eq("week_number", ISOWK).maybeSingle();
  return data as { points: number; advantages: number; penalty: number } | null;
}
async function setConfig(org: string, hub: string, key: string, a: number | null, b: number | null) {
  await supabaseAdmin.from("cluster4_line_point_configs").upsert(
    { organization_slug: org, hub, config_key: key, point_a: a, point_b: b, updated_at: new Date().toISOString() },
    { onConflict: "organization_slug,hub,config_key" },
  );
}

async function main() {
  const { data: tm } = await supabaseAdmin.from("test_user_markers").select("user_id").limit(3);
  const users = (tm ?? []).map((r) => (r as { user_id: string }).user_id);
  if (users.length < 3) { console.error("need >=3 test markers"); process.exit(1); }
  const [u1, u2, u3] = users;

  // ── 사전 정리(이전 중단 실행 잔여 제거) — 테스트 유저의 이 주차 line-source 원장 + VTEST 라인 전량 ──
  await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").eq("year", YEAR).eq("week_number", ISOWK).in("user_id", users);
  await supabaseAdmin.from("user_weekly_points").delete().eq("year", YEAR).eq("week_number", ISOWK).in("user_id", users);
  {
    const { data: leftover } = await supabaseAdmin.from("cluster4_lines").select("id").like("line_code", "VTEST%");
    const lids = ((leftover ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (lids.length) {
      await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").in("ref_id", lids);
      await supabaseAdmin.from("cluster4_line_targets").delete().in("line_id", lids);
      await supabaseAdmin.from("cluster4_lines").delete().in("id", lids);
    }
  }

  // ── CAREER 통제 라인 (line_code=config_key, org=phalanx via 'PX' 토큰) ──
  const LINE_CODE = "VTESTCAR-PX9001";
  const CONFIG_ORG = "phalanx";
  // 정리(이전 잔여)
  await supabaseAdmin.from("cluster4_lines").delete().eq("line_code", LINE_CODE);
  await supabaseAdmin.from("cluster4_line_point_configs").delete().eq("hub", "career").eq("config_key", LINE_CODE);

  const NOW = new Date().toISOString();
  const LATER = new Date(Date.now() + 7 * 86400000).toISOString();
  const { data: lineRow, error: lineErr } = await supabaseAdmin.from("cluster4_lines").insert({
    part_type: "career", line_code: LINE_CODE, main_title: "[검증] 라인개설지급", is_active: true, is_qa_test: true,
    submission_opens_at: NOW, submission_closes_at: LATER,
  }).select("id").single();
  if (lineErr || !lineRow) { console.error("career line insert failed", lineErr?.message); process.exit(1); }
  const L = (lineRow as { id: string }).id;
  const mkTargets = async (uids: string[]) => {
    await supabaseAdmin.from("cluster4_line_targets").delete().eq("line_id", L);
    if (uids.length) await supabaseAdmin.from("cluster4_line_targets").insert(
      uids.map((uid) => ({ line_id: L, week_id: WEEK_ID, target_mode: "user", target_user_id: uid, target_rule: {} })),
    );
  };
  await mkTargets([u1, u2, u3]);

  // (1) A·B 모두 설정 → 모두 지급
  await setConfig(CONFIG_ORG, "career", LINE_CODE, 3, 2);
  await reconcileLineOpenAward(L);
  let aw = await awardsFor(L);
  ck("① A=3,B=2 → 대상자 3명 지급 (check=3, adv=2)", aw.length === 3 && aw.every((a) => a.point_check === 3 && a.point_advantage === 2), { n: aw.length, sample: aw[0] });
  ck("① scope_mode=test (is_qa_test 라인)", aw.every((a) => a.scope_mode === "test"));
  const w1 = await uwp(u1);
  ck("① user_weekly_points 반영 (points>=3, advantages>=2)", !!w1 && w1.points >= 3 && w1.advantages >= 2, w1);

  // (2) 멱등 — 재실행해도 중복 없음
  await reconcileLineOpenAward(L);
  aw = await awardsFor(L);
  ck("② 재실행 멱등 (여전히 3행)", aw.length === 3);

  // (3) A만 설정 → A만 지급 (adv=0)
  await setConfig(CONFIG_ORG, "career", LINE_CODE, 5, null);
  await reconcileLineOpenAward(L);
  aw = await awardsFor(L);
  ck("③ A만(5) → check=5, adv=0", aw.length === 3 && aw.every((a) => a.point_check === 5 && a.point_advantage === 0), aw[0]);

  // (4) B만 설정 → B만 지급 (check=0)
  await setConfig(CONFIG_ORG, "career", LINE_CODE, null, 4);
  await reconcileLineOpenAward(L);
  aw = await awardsFor(L);
  ck("④ B만(4) → check=0, adv=4", aw.length === 3 && aw.every((a) => a.point_check === 0 && a.point_advantage === 4), aw[0]);

  // (5) 둘 다 null → 지급 없음(회수)
  await setConfig(CONFIG_ORG, "career", LINE_CODE, null, null);
  await reconcileLineOpenAward(L);
  aw = await awardsFor(L);
  ck("⑤ A·B 모두 null → award 0 (회수)", aw.length === 0, { n: aw.length });

  // (6) 다시 both → 복구
  await setConfig(CONFIG_ORG, "career", LINE_CODE, 3, 2);
  await reconcileLineOpenAward(L);
  aw = await awardsFor(L);
  ck("⑥ both 복구 → 3행", aw.length === 3);

  // (7) 대상자 제거 → 증분 회수
  await mkTargets([u1, u2]);
  await reconcileLineOpenAward(L);
  aw = await awardsFor(L);
  ck("⑦ 대상자 제거(u3) → 2행, u3 회수", aw.length === 2 && !aw.some((a) => a.user_id === u3), aw.map((a) => a.user_id));
  const w3 = await uwp(u3);
  ck("⑦ u3 user_weekly_points 회수 (points 0/행없음)", !w3 || w3.points === 0, w3);

  // (8) 대상자 추가 → 증분 지급
  await mkTargets([u1, u2, u3]);
  await reconcileLineOpenAward(L);
  aw = await awardsFor(L);
  ck("⑧ 대상자 추가(u3) → 3행 복구", aw.length === 3);

  // (9) 설정 변경 reconcile — reconcileLinePayoutsForConfig 이 개설 라인 자동 재정합
  await setConfig(CONFIG_ORG, "career", LINE_CODE, 7, 1);
  const rec = await reconcileLinePayoutsForConfig("career", LINE_CODE);
  aw = await awardsFor(L);
  ck("⑨ 설정 변경(7/1) → reconcileForConfig 가 라인 자동 재정합", rec.lineIds.includes(L) && aw.every((a) => a.point_check === 7 && a.point_advantage === 1), { lineIds: rec.lineIds.length, sample: aw[0] });

  // (10) 라인 취소/삭제 회수 (revokeLineOpenAward)
  await revokeLineOpenAward(L);
  aw = await awardsFor(L);
  ck("⑩ revoke → award 0 회수", aw.length === 0);

  // ── INFO config_key(activity_type_id) 해석 검증 — 기존 라이브 config 사용(무클로버) ──
  const { data: wis } = await supabaseAdmin.from("cluster4_line_point_configs")
    .select("point_a,point_b").eq("organization_slug", "common").eq("hub", "info").eq("config_key", "wisdom").maybeSingle();
  const wc = wis as { point_a: number | null; point_b: number | null } | null;
  const INFO_CODE = "VTESTINF-BS9001"; // BS → common
  await supabaseAdmin.from("cluster4_lines").delete().eq("line_code", INFO_CODE);
  const { data: infoLine } = await supabaseAdmin.from("cluster4_lines").insert({
    part_type: "info", line_code: INFO_CODE, activity_type_id: "wisdom", main_title: "[검증] info", is_active: true, is_qa_test: true,
    submission_opens_at: NOW, submission_closes_at: LATER,
  }).select("id").single();
  const IL = (infoLine as { id: string }).id;
  await supabaseAdmin.from("cluster4_line_targets").insert([{ line_id: IL, week_id: WEEK_ID, target_mode: "user", target_user_id: u1, target_rule: {} }]);
  await reconcileLineOpenAward(IL);
  const iaw = await awardsFor(IL);
  const expA = wc?.point_a ?? null, expB = wc?.point_b ?? null;
  const anyEnabled = expA !== null || expB !== null;
  ck("info: activity_type_id='wisdom' config 해석 지급", anyEnabled ? (iaw.length === 1 && iaw[0].point_check === (expA ?? 0) && iaw[0].point_advantage === (expB ?? 0)) : iaw.length === 0, { config: wc, award: iaw[0] });
  await revokeLineOpenAward(IL);

  // ── experience/competency config_key 해석 검증(read-only, 실 라인 join) ──
  const EXP_MAP: Record<string, string> = { derivation: "derive", analysis: "analysis", evaluation: "research", extension: "expansion", management: "management" };
  const { data: expLine } = await supabaseAdmin.from("cluster4_lines")
    .select("id,experience_line_master_id").eq("part_type", "experience").not("experience_line_master_id", "is", null).limit(1);
  if (expLine && expLine[0]) {
    const mid = (expLine[0] as { experience_line_master_id: string }).experience_line_master_id;
    const { data: m } = await supabaseAdmin.from("cluster4_experience_line_masters").select("experience_category").eq("id", mid).maybeSingle();
    const cat = (m as { experience_category: string } | null)?.experience_category;
    const key = cat ? EXP_MAP[cat] : null;
    ck("experience: master.experience_category → config_key 매핑 유효", !!key && ["derive", "analysis", "research", "expansion", "management"].includes(key), { cat, key });
  } else { ck("experience: (개설 라인 없음 — 매핑 스킵)", true); }

  const { data: compLine } = await supabaseAdmin.from("cluster4_lines")
    .select("id,competency_line_master_id").eq("part_type", "competency").not("competency_line_master_id", "is", null).limit(1);
  if (compLine && compLine[0]) {
    const mid = (compLine[0] as { competency_line_master_id: string }).competency_line_master_id;
    const { data: m } = await supabaseAdmin.from("cluster4_competency_line_masters").select("line_code").eq("id", mid).maybeSingle();
    const key = (m as { line_code: string } | null)?.line_code ?? null;
    ck("competency: master.line_code → config_key 유효", !!key, { key });
  } else { ck("competency: (개설 라인 없음 — 매핑 스킵)", true); }

  // ── 정리 ──
  await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").in("ref_id", [L, IL]);
  await supabaseAdmin.from("cluster4_line_targets").delete().in("line_id", [L, IL]);
  await supabaseAdmin.from("cluster4_lines").delete().in("id", [L, IL]);
  await supabaseAdmin.from("cluster4_line_point_configs").delete().eq("hub", "career").eq("config_key", LINE_CODE);
  // 테스트 유저 uwp 정리(이 검증이 만든 주차 행 — 다른 소스 원장 없으면 0/삭제).
  for (const u of [u1, u2, u3]) {
    const { data: rem } = await supabaseAdmin.from("process_point_awards").select("id").eq("user_id", u).eq("year", YEAR).eq("week_number", ISOWK).limit(1);
    if (!rem || rem.length === 0) await supabaseAdmin.from("user_weekly_points").delete().eq("user_id", u).eq("year", YEAR).eq("week_number", ISOWK);
  }
  ck("정리 완료", true);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
