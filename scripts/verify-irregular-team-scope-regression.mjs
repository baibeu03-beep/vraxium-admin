// 변동 액트 "소속 팀(실무 경험)" — team_id 매칭 전환 회귀 테스트(HTTP 기반).
//   verify-irregular-team-scope-http.mjs 가 이미 다루는 케이스(신규 생성 검증)는 반복하지 않고,
//   PATCH 경로(허브 전환)의 팀 전환 시나리오만 추가로 검증한다.
// 전제: dev 서버(:3000), db/migrations/2026-08-03_process_irregular_acts_team_scope.sql 적용 완료.
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
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "encre", TAG = "ZZ-teamscope-regression";
const J = (o) => JSON.stringify(o);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanupAll() {
  const rows = (await sb.from("process_irregular_acts").select("id").ilike("act_name", `${TAG}%`)).data ?? [];
  for (const row of rows) {
    await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id: row.id, organization: ORG, mode: "test" }) }).catch(() => {});
  }
  if (rows.length) await sb.from("process_check_review_recipients").delete().in("ref_id", rows.map((x) => x.id));
  await sb.from("process_irregular_acts").delete().ilike("act_name", `${TAG}%`);
}

try {
  await cleanupAll();

  const encre = (await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? [];
  const teMarkers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const target = encre.find((u) => teMarkers.has(u.user_id));
  const teams = (await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG).eq("is_active", true)).data ?? [];

  // ── 대상의 실제 소속 팀 탐색(생성 성공 여부로 간접 확인) ──
  let matchedTeam = null;
  for (const team of teams) {
    const attempt = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
      organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 소속탐색-${team.team_name}`, target_user_ids: [target.user_id],
      point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "experience", team_id: team.id,
    }) });
    if (attempt.status === 201) { matchedTeam = { ...team, actId: attempt.json.data.id }; break; }
  }
  if (!matchedTeam) { console.log("실패: 소속 팀을 찾지 못함"); process.exit(2); }
  console.log(`대상: ${target.display_name} / 실제 소속 팀: ${matchedTeam.team_name}`);
  const otherTeam = teams.find((t) => t.id !== matchedTeam.id);

  // ── 시나리오 1: info → experience(팀 지정) PATCH ──
  const infoAct = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} info원본`, target_user_ids: [target.user_id],
    point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "info",
  }) });
  ck("[시나리오1] info 행 생성", infoAct.status === 201, `status=${infoAct.status}`);
  const infoActId = infoAct.json.data?.id;
  if (infoActId) {
    const toExp = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
      id: infoActId, organization: ORG, mode: "test", action: "set_assignment_scope", hub_grade: "experience", team_id: matchedTeam.id,
    }) });
    ck("[시나리오1] info→experience(실제 소속 팀) → 200 · teamId 일치", toExp.status === 200 && toExp.json.data?.teamId === matchedTeam.id,
      `status=${toExp.status} teamId=${toExp.json.data?.teamId}`);
    const dbRow1 = (await sb.from("process_irregular_acts").select("hub_grade,team_id,team_name,part_scope").eq("id", infoActId).maybeSingle()).data;
    ck("[시나리오1] DB 도 hub_grade=experience·team_id 일치·part_scope=team_overall",
      dbRow1?.hub_grade === "experience" && dbRow1?.team_id === matchedTeam.id && dbRow1?.part_scope === "team_overall", J(dbRow1));

    // ── 시나리오 2: experience(팀A) → experience(팀B, 실제 미소속) → 400 ──
    if (otherTeam) {
      const toWrongTeam = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
        id: infoActId, organization: ORG, mode: "test", action: "set_assignment_scope", hub_grade: "experience", team_id: otherTeam.id,
      }) });
      ck(`[시나리오2] experience(${matchedTeam.team_name})→experience(미소속 ${otherTeam.team_name}) → 400`,
        toWrongTeam.status === 400, `status=${toWrongTeam.status} err=${toWrongTeam.json.error}`);
      const dbRow2 = (await sb.from("process_irregular_acts").select("team_id").eq("id", infoActId).maybeSingle()).data;
      ck("[시나리오2] 실패한 PATCH 후 DB team_id 는 원래 팀 그대로(중간상태 없음)", dbRow2?.team_id === matchedTeam.id, J(dbRow2));
    }
  }

  // ── 시나리오 3: 팀 총괄 행은 "특정 파트" 카드에는 절대 나타나지 않는다(§ not-in-specific-part) ──
  const mgmt = await api(`/api/admin/team-parts/info/weeks/${infoAct.json.data.weekId}/act-check-management?club=${ORG}&mode=test`);
  const expTeams = mgmt.json?.data?.practicalExperience?.teams ?? [];
  const thisTeam = expTeams.find((t) => t.teamId === matchedTeam.id);
  const inRegularLines = (thisTeam?.lines ?? []).some((l) =>
    Object.values(l.regularActsByDay ?? {}).flat().some((a) => a.actId === matchedTeam.actId || a.actId === infoActId),
  );
  ck("[시나리오3] 변동 액트가 정규 라인급(특정 파트) 카드에는 노출되지 않음", !inRegularLines, `inRegularLines=${inRegularLines}`);

  await cleanupAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (e) {
  console.error("FATAL", e);
  await cleanupAll().catch(() => {});
  process.exit(1);
}
