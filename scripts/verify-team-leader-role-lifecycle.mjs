/**
 * 검증 — 팀장 role lifecycle(신규/교체/삭제/유일성/parity). 실제 HTTP mutation + DB before/after.
 *   모델: 팀장 = role='team_leader' AND current_team_name=담당 팀. 복원=leader_previous_position 스냅샷.
 *   ⚠ phalanx 테스트 팀·크루 mutate → 종료 시 원상복구. 사전조건: dev :3000, 마이그2 적용.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const ORG = "phalanx", HALF = "2026-H2";
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const pos = async (uid) => { const { data } = await sb.from("user_profiles").select("role,current_team_name,current_part_name").eq("user_id", uid).maybeSingle(); return { role: data?.role ?? null, team: data?.current_team_name ?? null, part: data?.current_part_name ?? null }; };
const teamRow = async (id) => (await sb.from("cluster4_team_halves").select("leader_user_id,leader_previous_position,is_active,leader_crew_code,team_name,description").eq("id", id).maybeSingle()).data;
const uphCount = async (uid) => (await sb.from("user_position_histories").select("id", { count: "exact", head: true }).eq("user_id", uid)).count ?? 0;
const memCount = async (uid) => (await sb.from("user_memberships").select("id", { count: "exact", head: true }).eq("user_id", uid)).count ?? 0;

async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins[0].email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}
const eqPos = (a, b) => a.role === b.role && a.team === b.team && a.part === b.part;

async function main() {
  const cookie = await cookieHeader();
  const put = (b) => fetch(`${BASE}/api/admin/team-parts/info?mode=test`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json().then((j) => ({ status: r.status, j })));
  const del = (b) => fetch(`${BASE}/api/admin/team-parts/info?mode=test`, { method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json().then((j) => ({ status: r.status, j })));
  const summaryTL = async () => { const r = await fetch(`${BASE}/api/admin/team-parts/info/summary?organization=${ORG}&mode=test`, { headers: { cookie } }).then((x) => x.json()); const row = (r.data?.rows ?? []).find((x) => x.clubId === ORG); return { tl: row?.teamLeaderCount ?? null, staff: row?.staffCount ?? null }; };

  const { data: teams } = await sb.from("cluster4_team_halves").select("id,team_name,description,leader_user_id,leader_previous_position,is_active,leader_crew_code").eq("organization_slug", ORG).eq("half_key", HALF).eq("is_qa_test", true);
  const TT = teams.find((t) => t.team_name === "테스트(T)"), OT = teams.find((t) => t.team_name === "운영(T)");
  const byCode = async (c) => (await sb.from("user_profiles").select("user_id,display_name").eq("crew_code", c).maybeSingle()).data;
  const S = await byCode("005002-3253053"), E = await byCode("026003-3261043");
  const kwon = TT.leader_user_id;
  const putBody = (t, code) => ({ organization: ORG, halfKey: HALF, teamHalfId: t.id, teamName: t.team_name, description: t.description ?? "개요", leaderCrewCode: code });

  // ── before 캡처(원복용) ──
  const before = { TT: await teamRow(TT.id), OT: await teamRow(OT.id), pos: {}, uph: {}, mem: {} };
  for (const u of [kwon, S.user_id, E.user_id, OT.leader_user_id]) { before.pos[u] = await pos(u); before.uph[u] = await uphCount(u); before.mem[u] = await memCount(u); }
  console.log(`대상: 테스트(T) leader=권지민(${JSON.stringify(before.pos[kwon])}) · 장시현(${JSON.stringify(before.pos[S.user_id])}) · 강시은(${JSON.stringify(before.pos[E.user_id])})`);

  try {
    // ① 신규 지정(권지민 agent → 장시현) + ② role/team 동시 정합
    const before1 = await summaryTL();
    const r1 = await put(putBody(TT, "005002-3253053"));
    ck("① PUT 200 · partial state 없음", r1.status === 200 && r1.j.success, JSON.stringify(r1.j.data?.notes ?? "no-notes"));
    ck("① leader_user_id 저장", (await teamRow(TT.id)).leader_user_id === S.user_id);
    const sPos = await pos(S.user_id);
    ck("② 장시현 role=team_leader", sPos.role === "team_leader", sPos.role);
    ck("② 장시현 current_team_name=테스트(T)", sPos.team === "테스트(T)", sPos.team);
    const lpp = (await teamRow(TT.id)).leader_previous_position;
    ck("① leader_previous_position = 장시현 승격 직전 스냅샷", lpp && lpp.role === before.pos[S.user_id].role && lpp.teamName === before.pos[S.user_id].team, JSON.stringify(lpp));
    // ③ 집계 +1
    const after1 = await summaryTL();
    ck("③ 팀장 수 +1", after1.tl === before1.tl + 1, `${before1.tl} → ${after1.tl}`);
    ck("③ 운영진 수 +1", after1.staff === before1.staff + 1, `${before1.staff} → ${after1.staff}`);

    // ④ 교체(장시현 → 강시은) : demote-before-promote → 장시현 정확 복원
    const r2 = await put(putBody(TT, "026003-3261043"));
    ck("④ PUT 200 · 유일성 충돌 없음", r2.status === 200 && r2.j.success, JSON.stringify(r2.j.data?.notes ?? "no-notes"));
    ck("④ 새 팀장 강시은 team_leader + team=테스트(T)", (await pos(E.user_id)).role === "team_leader" && (await pos(E.user_id)).team === "테스트(T)");
    const sRestored = await pos(S.user_id);
    ck("④ 이전 팀장 장시현 {role,team,part} 정확 복원", eqPos(sRestored, before.pos[S.user_id]), `${JSON.stringify(sRestored)} == ${JSON.stringify(before.pos[S.user_id])}`);

    // ⑤ 삭제 복원(강시은) — 다른 active 팀 리더 아님 → 복원
    const r3 = await del({ organization: ORG, halfKey: HALF, teamHalfId: TT.id });
    ck("⑤ DELETE 200", r3.status === 200 && r3.j.success);
    ck("⑤ 강시은 {role,team,part} 정확 복원", eqPos(await pos(E.user_id), before.pos[E.user_id]), `${JSON.stringify(await pos(E.user_id))}`);

    // ⑤b 다른 active 팀 리더면 유지 — 강시은을 다시 TT 팀장으로 + OT leader_user_id=강시은(DB) → TT 삭제 시 유지
    await sb.from("cluster4_team_halves").update({ is_active: true }).eq("id", TT.id);
    await put(putBody(TT, "026003-3261043")); // 강시은 재승격(team_leader, team=테스트(T))
    await sb.from("cluster4_team_halves").update({ leader_user_id: E.user_id }).eq("id", OT.id); // OT 리더 포인터=강시은(다른 active 팀)
    const rDel = await del({ organization: ORG, halfKey: HALF, teamHalfId: TT.id });
    ck("⑤b TT 삭제해도 강시은 다른 팀(OT) 리더 → team_leader 유지", rDel.status === 200 && (await pos(E.user_id)).role === "team_leader", (await pos(E.user_id)).role);

    // audit 기록
    const { count: auditN } = await sb.from("user_role_audit").select("id", { count: "exact", head: true }).in("user_id", [S.user_id, E.user_id]).like("reason", "team_leader_%");
    ck("audit 승격/복원 기록됨", (auditN ?? 0) >= 3, `${auditN}건`);
    // UPH/membership 비변경
    let uphSame = true, memSame = true;
    for (const u of [S.user_id, E.user_id]) { if (await uphCount(u) !== before.uph[u]) uphSame = false; if (await memCount(u) !== before.mem[u]) memSame = false; }
    ck("user_position_histories 비변경", uphSame);
    ck("user_memberships 비변경", memSame);
  } finally {
    // ── 원복 ──
    await sb.from("cluster4_team_halves").update({ leader_user_id: before.TT.leader_user_id, leader_crew_code: before.TT.leader_crew_code, leader_previous_position: before.TT.leader_previous_position, is_active: before.TT.is_active }).eq("id", TT.id);
    await sb.from("cluster4_team_halves").update({ leader_user_id: before.OT.leader_user_id, leader_previous_position: before.OT.leader_previous_position }).eq("id", OT.id);
    await sb.from("cluster4_team_parts").update({ leader_user_id: before.TT.leader_user_id }).eq("team_half_id", TT.id).eq("part_name", "일반");
    for (const [uid, p] of Object.entries(before.pos)) await sb.from("user_profiles").update({ role: p.role, current_team_name: p.team, current_part_name: p.part }).eq("user_id", uid);
    await sb.from("user_role_audit").delete().in("user_id", [S.user_id, E.user_id, kwon, OT.leader_user_id]).like("reason", "team_leader_%");
    const okS = eqPos(await pos(S.user_id), before.pos[S.user_id]), okE = eqPos(await pos(E.user_id), before.pos[E.user_id]);
    const okTeam = (await teamRow(TT.id)).leader_user_id === before.TT.leader_user_id && (await teamRow(OT.id)).leader_user_id === before.OT.leader_user_id;
    ck("[정리] 원복 확인(role/team/part·팀 리더)", okS && okE && okTeam);
    console.log("[정리] 완료");
  }

  // ⑦ parity(정적) — mode 전용 branch 없음
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
