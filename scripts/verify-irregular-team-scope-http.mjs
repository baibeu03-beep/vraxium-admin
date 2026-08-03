// 변동 액트 "소속 팀/파트(실무 경험)" — 실제 HTTP 검증.
//   전제: dev 서버(:3000). db/migrations/2026-08-03_process_irregular_acts_team_scope.sql
//   미적용이어도 validation(400 계열)까지는 검증 가능 — 컬럼 존재 여부를 프로브해 저장/조회 항목은
//   SKIP 으로 별도 표시한다.
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
const ORG = "encre", TAG = "ZZ-teamscope-verify";
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
  const probe = await sb.from("process_irregular_acts").select("team_id").limit(1);
  const migrated = !probe.error;
  console.log(migrated
    ? "[전제] team_id 컬럼 존재 — 마이그레이션 적용됨. 저장/조회까지 전량 검증한다."
    : `[전제] team_id 컬럼 없음(code=${probe.error?.code}) — db/migrations/2026-08-03_process_irregular_acts_team_scope.sql 미적용. validation 까지만 검증.`);

  await cleanupAll();

  // ── 대상: QA_HIDE_REAL_USERS 환경 — test_user_markers 유저만 write 가능 ──
  const encre = (await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? [];
  const teMarkers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const target = encre.find((u) => teMarkers.has(u.user_id));
  if (!target) { console.log("⚠ 테스트 대상 없음 — 중단"); process.exit(2); }

  const teams = (await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG).eq("is_active", true)).data ?? [];
  const otherOrgTeam = (await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", "oranke").eq("is_active", true).limit(1)).data?.[0];
  console.log(`대상: ${target.display_name}(${target.user_id.slice(0,8)}…) / org=${ORG} / 팀 후보=${teams.length}개`);

  // ── 1. hub=experience, 팀 미선택 → 400 ──
  const noTeam = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 팀누락`, target_user_ids: [target.user_id],
    point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "experience",
  }) });
  ck("[검증] experience + 팀 미선택 → 400", noTeam.status === 400, `status=${noTeam.status} err=${noTeam.json.error}`);

  // ── 2. hub=experience, 다른 조직 팀 → 400 ──
  if (otherOrgTeam) {
    const wrongOrgTeam = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
      organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 타조직팀`, target_user_ids: [target.user_id],
      point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "experience", team_id: otherOrgTeam.id,
    }) });
    ck("[검증] experience + 다른 조직(oranke) 팀 → 400", wrongOrgTeam.status === 400, `status=${wrongOrgTeam.status} err=${wrongOrgTeam.json.error}`);
  }

  // ── 3. hub=experience, 존재하지 않는 팀 → 400 ──
  const bogusTeam = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 없는팀`, target_user_ids: [target.user_id],
    point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "experience", team_id: "00000000-0000-0000-0000-000000000000",
  }) });
  ck("[검증] experience + 존재하지 않는 team_id → 400", bogusTeam.status === 400, `status=${bogusTeam.status}`);

  // ── 4. info 허브 + team_id 위조 전송 → 저장은 항상 NULL ──
  const infoWithTeam = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} info위조`, target_user_ids: [target.user_id],
    point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "info", team_id: teams[0]?.id ?? null,
  }) });
  ck("[검증] info + team_id 위조 전송 → 201 · 응답 teamId=null", infoWithTeam.status === 201 && infoWithTeam.json.data?.teamId === null,
    `status=${infoWithTeam.status} teamId=${infoWithTeam.json.data?.teamId}`);
  if (migrated && infoWithTeam.json.data?.id) {
    const dbRow = (await sb.from("process_irregular_acts").select("team_id,team_name,part_scope").eq("id", infoWithTeam.json.data.id).maybeSingle()).data;
    ck("[검증] info + team_id 위조 → DB team_id/team_name/part_scope 전부 NULL", dbRow?.team_id === null && dbRow?.team_name === null && dbRow?.part_scope === null, J(dbRow));
  }

  // ── 5. 대상 사용자가 실제로 소속되지 않은 팀으로 생성 시도 → 400(§14) ──
  //    순수 HTTP 스크립트라 서버사이드 resolvePositionAtBatch 를 직접 호출하지 않는다 — 대신 실제
  //    생성 결과(성공/실패)로 간접 검증한다: teams 후보를 순서대로 시도해 처음 성공하는 팀을
  //    "실제 소속 팀"으로 확인하고, 그 다음 다른 팀으로는 반드시 400 이 나야 한다(§14).
  let matchedTeam = null;
  for (const team of teams) {
    const attempt = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
      organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 소속탐색-${team.team_name}`, target_user_ids: [target.user_id],
      point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "experience", team_id: team.id,
    }) });
    if (attempt.status === 201) { matchedTeam = team; break; }
  }
  ck("[전제] 대상 사용자의 실제 소속 팀 탐색 성공", !!matchedTeam, matchedTeam ? matchedTeam.team_name : "모든 팀에서 거부됨(§14 과잉 검증 가능성 확인 필요)");
  if (matchedTeam) {
    const wrongTeam = teams.find((t) => t.id !== matchedTeam.id);
    if (wrongTeam) {
      const mismatchTry = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
        organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 불일치팀`, target_user_ids: [target.user_id],
        point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "experience", team_id: wrongTeam.id,
      }) });
      ck(`[검증] §14 — 실제 소속(${matchedTeam.team_name}) 아닌 팀(${wrongTeam.team_name}) 지정 → 400`,
        mismatchTry.status === 400, `status=${mismatchTry.status} err=${mismatchTry.json.error}`);
    }

    // ── 6. 정상 조합 확인: hub=experience + 실제 소속 팀 → 201, GET DTO 확인 ──
    const good = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
      organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 정상`, target_user_ids: [target.user_id],
      point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "experience", team_id: matchedTeam.id,
    }) });
    ck("[생성] experience + 실제 소속 팀 → 201", good.status === 201, `status=${good.status}`);
    ck("[생성] partScope=team_overall · partScopeLabel=팀 총괄", good.json.data?.partScope === "team_overall" && good.json.data?.partScopeLabel === "팀 총괄",
      J({ partScope: good.json.data?.partScope, partScopeLabel: good.json.data?.partScopeLabel }));
    if (migrated) {
      ck("[생성] teamId/teamName 저장 확인", good.json.data?.teamId === matchedTeam.id && good.json.data?.teamName === matchedTeam.team_name,
        J({ teamId: good.json.data?.teamId, teamName: good.json.data?.teamName }));
    }
    const goodId = good.json.data?.id;

    // ── 7. 수정 — experience(팀A) → competency(팀 NULL 강제) ──
    if (migrated && goodId) {
      const toComp = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
        id: goodId, organization: ORG, mode: "test", action: "set_assignment_scope", hub_grade: "competency",
      }) });
      ck("[수정] experience→competency → 200 · teamId=null", toComp.status === 200 && toComp.json.data?.teamId === null,
        `status=${toComp.status} teamId=${toComp.json.data?.teamId}`);
      const dbAfter = (await sb.from("process_irregular_acts").select("team_id,team_name,part_scope,hub_grade").eq("id", goodId).maybeSingle()).data;
      ck("[수정] DB 도 team_id/team_name/part_scope 전부 NULL(중간상태 없음)", dbAfter?.team_id === null && dbAfter?.team_name === null && dbAfter?.part_scope === null, J(dbAfter));

      // competency → experience(팀 필요, 미지정) → 400
      const backNoTeam = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
        id: goodId, organization: ORG, mode: "test", action: "set_assignment_scope", hub_grade: "experience",
      }) });
      ck("[수정] competency→experience(팀 미지정) → 400", backNoTeam.status === 400, `status=${backNoTeam.status}`);

      // competency → experience(팀 재지정) → 200
      const backWithTeam = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
        id: goodId, organization: ORG, mode: "test", action: "set_assignment_scope", hub_grade: "experience", team_id: matchedTeam.id,
      }) });
      ck("[수정] competency→experience(팀 재지정) → 200 · teamId 일치", backWithTeam.status === 200 && backWithTeam.json.data?.teamId === matchedTeam.id,
        `status=${backWithTeam.status} teamId=${backWithTeam.json.data?.teamId}`);
    }

    // ── 8. mode=test DTO 키 동일성 ──
    ck("[모드] DTO 에 teamId/teamName/partScope/partScopeLabel 키 존재", good.json.data &&
      "teamId" in good.json.data && "teamName" in good.json.data && "partScope" in good.json.data && "partScopeLabel" in good.json.data, "");
  }

  await cleanupAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (e) {
  console.error("FATAL", e);
  await cleanupAll().catch(() => {});
  process.exit(1);
}
