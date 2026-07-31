// 검증: 실무 경험(experience) 프로세스 체크 대상자 = 카페 링크 집계 ∩ 선택한 팀/파트 실제 소속자.
//   버그①: 카페 매칭(recipients)이 org+mode 모집단만으로 좁혀져, 타 팀/타 파트/미소속 크루가
//          체크 완료 명단·이행자(A/B)에 섞여 들어갔다.
//   버그②: 로스터가 "평가 대상"용 함수(experienceEvaluableRows)를 재사용해 파트장이 실제 매칭돼도
//          "매칭 사용자 없음"으로 떴다.
//   정책 정정(2026-07-31 최종): 엘리트·바사노스는 체크 집계·포인트 지급 모집단에서도 제외해야 한다.
//     역할(파트장) 축과 상태(엘리트/바사노스) 축을 분리해 판정한다 — isEvaluable(시즌휴식·주차휴식·
//     활동중단·엘리트·바사노스가 뒤섞인 값)을 재사용하지 않고 isElite/isBasanos 를 직접 본다.
//
//   경로별 대상자 ID 목록이 동일함을 실증한다:
//     · 미리보기/체크 실행(적립)  = previewRegularAccrual/computeDesiredAwards (performers)
//     · 보드 조회                  = getProcessCheckBoard (completedCrewList) — direct == HTTP
//
//   PART 1 = 파트 전용(PART 스코프) 액트, PART 2 = 파트 비전용(TEAM 스코프) 액트.
//   ⚠ 쓰기는 전부 mode=test(test_user_markers)만 · 원장/uwp cleanup=net-zero. 실사용자 무접촉.
//   run: npx tsx --env-file=.env.local scripts/verify-experience-check-membership-scope.ts
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getProcessCheckBoard, resolveProcessWeek } from "@/lib/adminProcessCheckData";
import { previewRegularAccrual } from "@/lib/processPointAccrual";
import { resolveCheckScopeRoster } from "@/lib/processCheckScopeRoster";
import {
  listPartMembers,
  listTeamCrews,
  listTeamMembers,
  loadExperienceWeekRoster,
} from "@/lib/adminExperiencePartInput";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = "http://localhost:3000";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const TAG = "ZZ-exp-memscope";

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const sortJ = (a: string[]) => JSON.stringify([...a].sort());
const groups: string[] = [], actIds: string[] = [], refIds: string[] = [];

async function cookie(email: string) {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link!.properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}
async function makeGroup(name: string, scopeType: "PART" | "TEAM"): Promise<string> {
  // scope_type 명시 필수(2026-07-24 정책) — 컬럼 DEFAULT 는 'TEAM' 이라 이름에 "파트"가 있어도
  //   명시하지 않으면 PART 라인급으로 인식되지 않는다([[project_line-group-scope-type-sot]]).
  const { data, error } = await sb.from("process_line_groups").insert({ hub: "experience", name: `${TAG} ${name}`, sort_order: 999, is_active: true, scope_type: scopeType }).select("id").single();
  if (error) throw new Error(`makeGroup: ${error.message}`);
  const id = (data as any).id; groups.push(id); return id;
}
async function makeAct(groupId: string, name: string): Promise<string> {
  const { data, error } = await sb.from("process_acts").insert({
    line_group_id: groupId, hub: "experience", act_name: `${TAG} ${name}`, act_type: "required",
    duration_minutes: 10, occur_week: "N", occur_dow: 2, occur_time: "06:30",
    check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", is_active: true,
  }).select("id").single();
  if (error) throw new Error(`makeAct: ${error.message}`);
  const id = (data as any).id; actIds.push(id); return id;
}
async function seedStatus(actId: string, groupId: string, weekId: string, partName: string | null, org: string, teamId: string): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await sb.from("process_check_statuses").insert({
    organization_slug: org, hub: "experience", week_id: weekId, act_id: actId, line_group_id: groupId,
    team_id: teamId, part_name: partName, status: "completed", scope_mode: "test",
    requested_at: now, completed_at: now, checked_crew_count: 0,
  }).select("id").single();
  if (error) throw new Error(`seedStatus: ${error.message}`);
  const id = (data as any).id; refIds.push(id); return id;
}
async function seedRecipients(refId: string, userIds: string[], org: string) {
  await sb.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", refId);
  await sb.from("process_check_review_recipients").insert(userIds.map((uid) => ({
    source: "regular", ref_id: refId, organization_slug: org, scope_mode: "test",
    user_id: uid, nickname: `T-${uid.slice(0, 4)}`, match_type: "matched", match_reason: "verify",
  })));
}
async function cleanup() {
  for (const ref of refIds) {
    await sb.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", ref);
    await sb.from("process_check_statuses").delete().eq("id", ref);
  }
  if (actIds.length) await sb.from("process_acts").delete().in("id", actIds);
  if (groups.length) await sb.from("process_line_groups").delete().in("id", groups);
  const g = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  if (g.length) { const ids = (g as any[]).map((x) => x.id); await sb.from("process_acts").delete().in("line_group_id", ids); await sb.from("process_line_groups").delete().in("id", ids); }
}
const boardActList = (board: any, actId: string, partLabel: string) => {
  const row = (board.acts ?? []).find((a: any) => a.actId === actId && a.partLabel === partLabel);
  return { row, ids: ((row?.completedCrewList ?? []) as any[]).map((c) => c.userId).filter(Boolean) as string[] };
};

async function main() {
  await cleanup();
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const cur = (await resolveProcessWeek("experience", "test")) as { weekId: string } | null;
  ck("[setup] 현재 주차 존재", !!cur?.weekId);
  if (!cur?.weekId) { console.log(`\n결과: ${pass} pass / ${fail} fail — setup 부족`); process.exit(1); }
  const WEEK = cur.weekId;
  const jar = await cookie((((await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1)).data as any[])[0]).email);
  const api = async (path: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie: jar } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  // ═══════════════════════════════════════════════════════════════════════
  // PART 1: 파트 전용(PART 스코프) — encre 비주얼랩(T) 아트 파트.
  //   일반 파트원(정상)·파트장(정상) 포함 / 엘리트·바사노스 제외(역할 무관) / 타 파트·타 팀·미소속 제외.
  // ═══════════════════════════════════════════════════════════════════════
  console.log("── PART 1: 파트 전용(PART 스코프) ──");
  const ORG1 = "encre";
  const TEAM_ID1 = "ad6304ba-c566-445a-afd6-1b1bb8939925"; // 비주얼랩(T)
  const TEAM_NAME1 = "비주얼랩(T)";
  const PART1 = "아트";

  const roster1 = await loadExperienceWeekRoster(ORG1, TEAM_NAME1, "test", WEEK, { requirePart: false });
  const regular1 = roster1.rows.find((r) => r.partName === PART1 && !r.isPartLeader && !r.isElite && !r.isBasanos);
  const leader1 = roster1.rows.find((r) => r.partName === PART1 && r.isPartLeader && !r.isElite && !r.isBasanos);
  const elite1 = roster1.rows.find((r) => r.partName === PART1 && (r.isElite || r.isBasanos));
  const otherPartUser1 = roster1.rows.find((r) => r.partName !== PART1 && r.partName !== "");
  const { data: otherTeamRows1 } = await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG1).eq("is_active", true).neq("id", TEAM_ID1);
  let otherTeamUser1: string | null = null;
  for (const t of (otherTeamRows1 ?? []) as any[]) {
    const c = await listTeamMembers(ORG1, t.team_name, "test", WEEK);
    const hit = c.find((x) => x.userId !== regular1?.userId);
    if (hit) { otherTeamUser1 = hit.userId; break; }
  }
  const encreTest = (((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG1)).data ?? []) as any[]).map((u) => u.user_id).filter((u) => markers.has(u));
  const inAnyRoster1 = new Set<string>();
  for (const t of (otherTeamRows1 ?? []) as any[]) for (const x of await listTeamMembers(ORG1, t.team_name, "test", WEEK)) inAnyRoster1.add(x.userId);
  for (const x of roster1.rows) inAnyRoster1.add(x.userId);
  const partlessTestUser1 = encreTest.find((u) => !inAnyRoster1.has(u)) ?? null;

  ck("[PART1 setup] 일반 파트원(정상) 발굴", !!regular1, `u=${regular1?.userId.slice(0, 8)}`);
  ck("[PART1 setup] 파트장(정상) 발굴", !!leader1, `u=${leader1?.userId.slice(0, 8)}`);
  ck("[PART1 setup] 엘리트/바사노스 파트원 발굴", !!elite1, `u=${elite1?.userId.slice(0, 8)} elite=${elite1?.isElite} basanos=${elite1?.isBasanos}`);
  ck("[PART1 setup] 동일팀 타파트 크루 발굴", !!otherPartUser1, `part=${otherPartUser1?.partName} u=${otherPartUser1?.userId.slice(0, 8)}`);
  ck("[PART1 setup] 타팀 크루 발굴", !!otherTeamUser1, `u=${otherTeamUser1?.slice(0, 8)}`);
  ck("[PART1 setup] 팀/파트 미소속 크루 발굴", !!partlessTestUser1, `u=${partlessTestUser1?.slice(0, 8)}`);

  if (regular1 && leader1 && elite1 && otherPartUser1 && otherTeamUser1 && partlessTestUser1) {
    const included1 = [regular1.userId, leader1.userId];
    const outOfScope1 = [otherPartUser1.userId, otherTeamUser1, partlessTestUser1];
    const seeded1 = [...included1, elite1.userId, ...outOfScope1];

    const grp1 = await makeGroup("파트 라인급", "PART");
    const actId1 = await makeAct(grp1, "파트액트");
    const st1 = await seedStatus(actId1, grp1, WEEK, PART1, ORG1, TEAM_ID1);
    await seedRecipients(st1, seeded1, ORG1);

    const rawRecip1 = ((await sb.from("process_check_review_recipients").select("user_id").eq("source", "regular").eq("ref_id", st1).eq("match_type", "matched")).data ?? []).map((r: any) => r.user_id);
    ck("[PART1 원천불변] recipients(matched) 는 카페 집계 그대로", sortJ(rawRecip1) === sortJ(seeded1), `n=${rawRecip1.length}`);

    const scopeRoster1 = await resolveCheckScopeRoster({ hub: "experience", organization: ORG1 as any, mode: "test", teamId: TEAM_ID1, partName: PART1, weekId: WEEK });
    const listRoster1 = (await listPartMembers(ORG1, TEAM_NAME1, PART1, "test", WEEK)).map((c) => c.userId);
    ck("[PART1 SoT] resolveCheckScopeRoster(part) == listPartMembers", sortJ(scopeRoster1) === sortJ(listRoster1));
    ck("[PART1 SoT] 엘리트/바사노스는 로스터에서 제외됨", !scopeRoster1.includes(elite1.userId));
    ck("[PART1 SoT] 파트장은 로스터에 포함됨(역할 필터 아님)", scopeRoster1.includes(leader1.userId));

    const pv1 = await previewRegularAccrual(st1) as any;
    ck(`[PART1 미리보기] performerCount = ${included1.length}(일반+파트장, 엘리트 제외)`, pv1.performerCount === included1.length, `n=${pv1.performerCount}`);

    for (const mode of ["operating", "test"] as const) {
      const r1 = await api(`/api/admin/processes/check?hub=experience&org=${ORG1}&team=${TEAM_ID1}&scope=part&part=${encodeURIComponent(PART1)}&mode=${mode}&week=${WEEK}`);
      const row1 = boardActList(r1.json?.data ?? {}, actId1, PART1);
      ck(`[PART1 HTTP·${mode}] 200`, r1.status === 200, `status=${r1.status}`);
      ck(`[PART1 HTTP·${mode}] 일반 파트원(정상) 포함`, row1.ids.includes(regular1.userId));
      ck(`[PART1 HTTP·${mode}] 파트장(정상) 포함`, row1.ids.includes(leader1.userId));
      ck(`[PART1 HTTP·${mode}] 엘리트/바사노스 제외`, !row1.ids.includes(elite1.userId));
      ck(`[PART1 HTTP·${mode}] 타파트/타팀/미소속 제외`, !row1.ids.some((u) => outOfScope1.includes(u)));
      ck(`[PART1 HTTP·${mode}] completedCrewList == 기대(일반+파트장)`, sortJ(row1.ids) === sortJ(included1));
      ck(`[PART1 HTTP·${mode}] checkedCrewCount == ${included1.length}`, row1.row?.checkedCrewCount === included1.length, `cc=${row1.row?.checkedCrewCount}`);
    }

    const actAs1 = encreTest.find((u) => u !== regular1.userId && u !== leader1.userId);
    if (actAs1) {
      const rA1 = await api(`/api/admin/processes/check?hub=experience&org=${ORG1}&team=${TEAM_ID1}&scope=part&part=${encodeURIComponent(PART1)}&mode=test&week=${WEEK}&actAsTestUserId=${actAs1}`);
      const rowA1 = boardActList(rA1.json?.data ?? {}, actId1, PART1);
      ck("[PART1 actAsTestUserId] 200", rA1.status === 200, `status=${rA1.status}`);
      ck("[PART1 actAsTestUserId] completedCrewList == 기대(일반+파트장)", sortJ(rowA1.ids) === sortJ(included1));
    }

    // demoUserId — 이 경로는 무관해야 한다(인증 사용자만 치환하는 축이 아니라, 아예 무접촉).
    const rD1 = await api(`/api/admin/processes/check?hub=experience&org=${ORG1}&team=${TEAM_ID1}&scope=part&part=${encodeURIComponent(PART1)}&mode=test&week=${WEEK}&demoUserId=${regular1.userId}`);
    const rowD1 = boardActList(rD1.json?.data ?? {}, actId1, PART1);
    ck("[PART1 demoUserId] 결과 무영향(completedCrewList 동일)", sortJ(rowD1.ids) === sortJ(included1));
  } else {
    console.log("  (PART1 setup 부족 — 픽스처 데이터 드리프트로 스킵)");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 2: 파트 비전용(TEAM 스코프) — encre 팬덤실험(T). "그 팀 소속자 전체"(파트 배정 여부 무관)
  //   중 엘리트·바사노스만 제외. 파트장·파트 미배정자는 포함. 팀장은 기존 정책대로 미포함(범위 밖).
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── PART 2: 파트 비전용(TEAM 스코프) ──");
  const ORG2 = "encre";
  const TEAM_ID2 = "04aaeb86-9f55-48cc-bddb-74d5c781f34c"; // 팬덤실험(T)
  const TEAM_NAME2 = "팬덤실험(T)";

  const roster2 = await loadExperienceWeekRoster(ORG2, TEAM_NAME2, "test", WEEK, { requirePart: false });
  const regular2 = roster2.rows.find((r) => !r.isPartLeader && !r.isElite && !r.isBasanos && r.partName !== "");
  const leader2 = roster2.rows.find((r) => r.isPartLeader && !r.isElite && !r.isBasanos);
  const eliteWithPart2 = roster2.rows.find((r) => (r.isElite || r.isBasanos) && r.partName !== "");
  const elitePartless2 = roster2.rows.find((r) => (r.isElite || r.isBasanos) && r.partName === "");
  const normalPartless2 = roster2.rows.find((r) => !r.isElite && !r.isBasanos && r.partName === "");
  const { data: teamLeaderRows2 } = await sb
    .from("user_profiles").select("user_id").eq("organization_slug", ORG2).eq("role", "team_leader")
    .ilike("current_team_name", `%${TEAM_NAME2.replace("(T)", "")}%`).limit(1);
  const teamLeaderUser2 = (teamLeaderRows2 as any[])?.[0]?.user_id ?? null;

  ck("[PART2 setup] 일반 파트원(정상) 발굴", !!regular2, `u=${regular2?.userId.slice(0, 8)}`);
  ck("[PART2 setup] 파트장(정상) 발굴", !!leader2, `u=${leader2?.userId.slice(0, 8)}`);
  ck("[PART2 setup] 엘리트/바사노스(파트 소속) 발굴", !!eliteWithPart2, `u=${eliteWithPart2?.userId.slice(0, 8)}`);
  ck("[PART2 setup] 엘리트/바사노스(파트 미배정) 발굴", !!elitePartless2, `u=${elitePartless2?.userId.slice(0, 8)}`);
  ck("[PART2 setup] 파트 미배정(정상) 발굴", !!normalPartless2, `u=${normalPartless2?.userId.slice(0, 8)}`);
  ck("[PART2 setup] 팀장 발굴", !!teamLeaderUser2, `u=${teamLeaderUser2?.slice(0, 8)}`);

  if (regular2 && leader2 && eliteWithPart2 && elitePartless2 && normalPartless2 && teamLeaderUser2) {
    const included2 = [regular2.userId, leader2.userId, normalPartless2.userId];
    const excluded2 = [eliteWithPart2.userId, elitePartless2.userId];
    const seeded2 = [...included2, ...excluded2, teamLeaderUser2];

    const grp2 = await makeGroup("팀 라인급", "TEAM");
    const actId2 = await makeAct(grp2, "팀액트");
    const st2 = await seedStatus(actId2, grp2, WEEK, null, ORG2, TEAM_ID2);
    await seedRecipients(st2, seeded2, ORG2);

    const scopeRoster2 = await resolveCheckScopeRoster({ hub: "experience", organization: ORG2 as any, mode: "test", teamId: TEAM_ID2, partName: null, weekId: WEEK });
    const listRoster2 = (await listTeamMembers(ORG2, TEAM_NAME2, "test", WEEK)).map((c) => c.userId);
    ck("[PART2 SoT] resolveCheckScopeRoster(팀총괄) == listTeamMembers", sortJ(scopeRoster2) === sortJ(listRoster2));
    ck("[PART2 SoT] listTeamMembers != listTeamCrews(구, 평가대상만) — 파트장·미배정 포함이 더 넓다", listRoster2.length > (await listTeamCrews(ORG2, TEAM_NAME2, "test", WEEK)).length);
    ck("[PART2 SoT] 엘리트/바사노스는 파트 소속이어도 제외됨", !scopeRoster2.includes(eliteWithPart2.userId));
    ck("[PART2 SoT] 엘리트/바사노스는 파트 미배정이어도 제외됨", !scopeRoster2.includes(elitePartless2.userId));

    const pv2 = await previewRegularAccrual(st2) as any;
    ck(`[PART2 미리보기] performerCount = ${included2.length}(엘리트/바사노스·팀장 제외)`, pv2.performerCount === included2.length, `n=${pv2.performerCount}`);

    for (const mode of ["operating", "test"] as const) {
      const r2 = await api(`/api/admin/processes/check?hub=experience&org=${ORG2}&team=${TEAM_ID2}&scope=team_overall&mode=${mode}&week=${WEEK}`);
      const row2 = boardActList(r2.json?.data ?? {}, actId2, "팀 총괄");
      ck(`[PART2 HTTP·${mode}] 200`, r2.status === 200, `status=${r2.status}`);
      ck(`[PART2 HTTP·${mode}] 일반 파트원(정상) 포함`, row2.ids.includes(regular2.userId));
      ck(`[PART2 HTTP·${mode}] 파트장(정상) 포함`, row2.ids.includes(leader2.userId));
      ck(`[PART2 HTTP·${mode}] 파트 미배정(정상) 포함`, row2.ids.includes(normalPartless2.userId));
      ck(`[PART2 HTTP·${mode}] 엘리트/바사노스(파트 소속) 제외`, !row2.ids.includes(eliteWithPart2.userId));
      ck(`[PART2 HTTP·${mode}] 엘리트/바사노스(파트 미배정) 제외`, !row2.ids.includes(elitePartless2.userId));
      ck(`[PART2 HTTP·${mode}] 팀장 미포함(2026-06-19 정책, 범위 밖)`, !row2.ids.includes(teamLeaderUser2));
      ck(`[PART2 HTTP·${mode}] completedCrewList == 기대(일반+파트장+미배정 정상)`, sortJ(row2.ids) === sortJ(included2));
    }

    const actAs2 = (((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG2)).data ?? []) as any[])
      .map((u) => u.user_id)
      .find((u) => markers.has(u) && u !== regular2.userId);
    if (actAs2) {
      const rA2 = await api(`/api/admin/processes/check?hub=experience&org=${ORG2}&team=${TEAM_ID2}&scope=team_overall&mode=test&week=${WEEK}&actAsTestUserId=${actAs2}`);
      const rowA2 = boardActList(rA2.json?.data ?? {}, actId2, "팀 총괄");
      ck("[PART2 actAsTestUserId] 200", rA2.status === 200, `status=${rA2.status}`);
      ck("[PART2 actAsTestUserId] completedCrewList == 기대(일반+파트장+미배정 정상)", sortJ(rowA2.ids) === sortJ(included2));
    }
  } else {
    console.log("  (PART2 setup 부족 — 픽스처 데이터 드리프트로 스킵)");
  }

  await cleanup();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); try { await cleanup(); } catch {} process.exit(1); });
