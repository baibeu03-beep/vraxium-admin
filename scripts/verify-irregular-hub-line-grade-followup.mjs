// 변동 액트 "소속 허브 급" — 후속 검증(마이그레이션 적용 후).
//   §4 기존 19행 조회 · §5 PATCH 체인(club→info→experience→competency) · §6 team-parts 주차별 매칭.
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
const ORG = "oranke", TAG = "ZZ-hubgrade-followup";
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

async function cleanup() {
  const rows = (await sb.from("process_irregular_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  if (rows.length) {
    // manual_grant 는 생성 시 즉시 포인트 적립(process_point_awards)까지 발생한다 — 원장 원장행을
    //   직접 지우지 않고 정식 회수 API(DELETE, 서버가 내부적으로 revokeForAct 호출)로 정리해야
    //   user_weekly_points/snapshot 이 orphan 없이 되돌아간다(raw delete 만 하면 원장이 남는다).
    for (const row of rows) {
      await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id: row.id, organization: ORG, mode: "test" }) }).catch(() => {});
    }
    await sb.from("process_check_review_recipients").delete().in("ref_id", rows.map((x) => x.id));
  }
  await sb.from("process_irregular_acts").delete().like("act_name", `${TAG}%`);
  return rows.map((r) => r.id);
}

try {
  await cleanup();

  console.log("\n=== §4. 기존(backfill) 행 GET 조회 ===");
  const board0 = await api(`/api/admin/processes/check/irregular?org=${ORG}`);
  const boardWeekId = board0.json.data?.week?.weekId ?? null;
  const seasonLabel = board0.json.data?.week?.periodLabel ?? null;
  console.log(`  주차: ${boardWeekId} (${seasonLabel})`);
  // 보드의 주차 드롭다운(현재 시즌 W1~현재)에 실제로 걸리는 기존 행만 GET 으로 재조회할 수 있다
  //   (이 제약은 hub_grade 기능과 무관한 기존 보드 정책 — §12 "과거 주차 조회 전용" 설계).
  //   그래서 선택 가능 주차 목록에 포함된 oranke 기존 행(테스트 태그 제외)을 우선 사용한다.
  const selectableWeekIds = new Set((board0.json.data?.weeks ?? []).map((w) => w.weekId));
  const allOranke = (await sb.from("process_irregular_acts").select("id,week_id,hub_grade,line_grade,created_at,act_name")
    .eq("organization_slug", ORG).not("act_name", "ilike", "ZZ-%").order("created_at", { ascending: true })).data ?? [];
  ck("[전제] DB에 oranke 기존 행 존재", allOranke.length > 0, `count=${allOranke.length}`);
  const oldOranke = allOranke.find((r) => selectableWeekIds.has(r.week_id)) ?? allOranke[0];
  if (oldOranke) {
    ck(`[DB] 기존 행(${oldOranke.id.slice(0,8)}…) hub_grade='club'·line_grade='variable_act'`,
      oldOranke.hub_grade === "club" && oldOranke.line_grade === "variable_act", J(oldOranke));
    const boardOld = await api(`/api/admin/processes/check/irregular?org=${ORG}&week=${oldOranke.week_id}`);
    const dtoRow = (boardOld.json.data?.acts ?? []).find((a) => a.id === oldOranke.id);
    ck("[GET] 기존 행 DTO hubGrade=club·hubGradeLabel='클럽 총괄 급'·lineGrade=variable_act·lineGradeLabel='변동 액트'",
      dtoRow?.hubGrade === "club" && dtoRow?.hubGradeLabel === "클럽 총괄 급" && dtoRow?.lineGrade === "variable_act" && dtoRow?.lineGradeLabel === "변동 액트",
      dtoRow ? J({ hubGrade: dtoRow.hubGrade, hubGradeLabel: dtoRow.hubGradeLabel, lineGrade: dtoRow.lineGrade, lineGradeLabel: dtoRow.lineGradeLabel }) : `행을 못찾음(week=${oldOranke.week_id} 선택가능=${selectableWeekIds.has(oldOranke.week_id)})`);
  }

  // ── 대상: QA_HIDE_REAL_USERS 환경이라 test_user_markers 유저만 write 가능 ──
  const oranke = (await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? [];
  const teMarkers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const target = oranke.find((u) => teMarkers.has(u.user_id));
  if (!target) { console.log("⚠ 테스트 대상 크루 없음 — 중단"); process.exit(2); }

  console.log("\n=== §5. PATCH 체인 club→info→experience→competency ===");
  const seed = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 체인`, target_user_ids: [target.user_id],
    point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "club",
  }) });
  ck("[체인] 시드 생성 201·hubGrade=club", seed.status === 201 && seed.json.data?.hubGrade === "club", `status=${seed.status}`);
  const seedId = seed.json.data?.id;
  const chain = ["info", "experience", "competency"];
  for (const next of chain) {
    const patched = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
      id: seedId, organization: ORG, mode: "test", action: "set_hub_grade", hub_grade: next,
    }) });
    ck(`[체인] PATCH → ${next}: HTTP 200`, patched.status === 200, `status=${patched.status}`);
    ck(`[체인] PATCH → ${next}: 응답 hubGrade/hubGradeLabel 일치·lineGrade 유지`,
      patched.json.data?.hubGrade === next && patched.json.data?.lineGrade === "variable_act",
      J({ hubGrade: patched.json.data?.hubGrade, hubGradeLabel: patched.json.data?.hubGradeLabel, lineGrade: patched.json.data?.lineGrade }));
    const dbRow = (await sb.from("process_irregular_acts").select("hub_grade,line_grade").eq("id", seedId).maybeSingle()).data;
    ck(`[체인] PATCH → ${next}: DB 저장값 일치(direct==HTTP)`, dbRow?.hub_grade === next && dbRow?.line_grade === "variable_act", J(dbRow));
    const refetch = await api(`/api/admin/processes/check/irregular?org=${ORG}&mode=test`);
    const row = (refetch.json.data?.acts ?? []).find((a) => a.id === seedId);
    ck(`[체인] PATCH → ${next}: 재조회(GET) hubGrade 일치`, row?.hubGrade === next, `hubGrade=${row?.hubGrade}`);
  }
  const badPatch1 = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
    id: seedId, organization: ORG, mode: "test", action: "set_hub_grade", hub_grade: "career",
  }) });
  ck("[체인] PATCH hub_grade=career → 400(여전히 거부)", badPatch1.status === 400, `status=${badPatch1.status}`);
  const badPatch2 = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
    id: seedId, organization: ORG, mode: "test", action: "set_hub_grade", hub_grade: "bogus",
  }) });
  ck("[체인] PATCH hub_grade=bogus → 400(여전히 거부)", badPatch2.status === 400, `status=${badPatch2.status}`);
  // §5 시드 행을 §6 이전에 정리(§6 집계가 §5 잔여로 오염되지 않도록 — cleanup() 은 스크립트 종료 시에만 실행됨).
  await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id: seedId, organization: ORG, mode: "test" }) });

  console.log("\n=== §6. team-parts/info/weeks 실제 매칭(4허브 동시 생성 후 대조) ===");
  // 같은 사용자·같은 주차(mode=test 현재 주차)에 4허브 각 1건 생성.
  const HUBS = ["club", "info", "experience", "competency"];
  const ids = {};
  for (const hub of HUBS) {
    const res = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
      organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 매칭-${hub}`, target_user_ids: [target.user_id],
      point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: hub,
    }) });
    ids[hub] = res.json.data?.id;
    ck(`[매칭시드] ${hub} 생성 201`, res.status === 201, `status=${res.status}`);
  }
  const board1 = await api(`/api/admin/processes/check/irregular?org=${ORG}&mode=test`);
  const weekId = board1.json.data?.selectedWeekId;
  console.log(`  대상: ${target.display_name}(${target.user_id.slice(0,8)}…) / org=${ORG} / week=${weekId} (${board1.json.data?.week?.periodLabel})`);

  const mgmt = await api(`/api/admin/team-parts/info/weeks/${weekId}/act-check-management?club=${ORG}&mode=test`);
  ck("[매칭] act-check-management GET 200", mgmt.status === 200, `status=${mgmt.status} err=${mgmt.json.error}`);
  const d = mgmt.json.data ?? {};
  const collectIds = (byDay) => Object.values(byDay ?? {}).flat().map((v) => v.id);
  const clubIds = collectIds(d.clubOverall?.variableActsByDay);
  const infoIds = collectIds(d.practicalInfo?.variableActsByDay);
  const expIds = collectIds(d.practicalExperience?.variableActsByDay);
  const compIds = collectIds(d.practicalCompetency?.variableActsByDay);
  console.log(`  clubOverall.variableActsByDay ids: ${J(clubIds)}`);
  console.log(`  practicalInfo.variableActsByDay ids: ${J(infoIds)}`);
  console.log(`  practicalExperience.variableActsByDay ids: ${J(expIds)}`);
  console.log(`  practicalCompetency.variableActsByDay ids: ${J(compIds)}`);
  const allBuckets = { club: clubIds, info: infoIds, experience: expIds, competency: compIds };
  for (const hub of HUBS) {
    ck(`[매칭] ${hub} 액트(${ids[hub]?.slice(0,8)}…)가 ${hub} 버킷에만 포함`,
      allBuckets[hub].includes(ids[hub]) && HUBS.filter((h) => h !== hub).every((other) => !allBuckets[other].includes(ids[hub])),
      `${hub}버킷포함=${allBuckets[hub].includes(ids[hub])}, 타허브혼입=${HUBS.filter((h) => h !== hub).some((other) => allBuckets[other].includes(ids[hub]))}`);
  }
  console.log(`  집계: club=${clubIds.length} info=${infoIds.length} experience(허브전체)=${expIds.length} competency=${compIds.length}`);
  ck("[매칭] practicalExperience 팀별 variableActsByDay 는 항상 빈 배열(팀 귀속 불가 — 설계된 한계)",
    (d.practicalExperience?.teams ?? []).every((t) => Object.values(t.variableActsByDay ?? {}).flat().length === 0), "");

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (e) {
  console.error("FATAL", e);
  await cleanup().catch(() => {});
  process.exit(1);
}
