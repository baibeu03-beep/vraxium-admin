// 검증: 실무 경험(experience) 프로세스 체크 대상자 = 카페 링크 집계 ∩ 선택한 팀/파트 실제 소속자.
//   버그: 카페 매칭(recipients)이 org+mode 모집단만으로 좁혀져, 타 팀/타 파트/미소속 크루가
//         체크 완료 명단·이행자(A/B)에 섞여 들어갔다. 수정: 모든 소비 단계에서 실제 소속 로스터로 교집합.
//
//   경로별 대상자 ID 목록이 동일함을 실증한다:
//     · 미리보기/체크 실행(적립)  = previewRegularAccrual/computeDesiredAwards (performers)
//     · snapshot 조회(보드)        = getProcessCheckBoard (completedCrewList) — direct == HTTP
//
//   ⚠ 쓰기는 전부 mode=test(test_user_markers)만 · 원장/uwp cleanup=net-zero. 실사용자 무접촉.
//   run: npx tsx --env-file=.env.local scripts/verify-experience-check-membership-scope.ts
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getProcessCheckBoard } from "@/lib/adminProcessCheckData";
import { previewRegularAccrual } from "@/lib/processPointAccrual";
import { resolveCheckScopeRoster } from "@/lib/processCheckScopeRoster";
import { listTeamParts, listPartCrews, listTeamCrews } from "@/lib/adminExperiencePartInput";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const TAG = "ZZ-exp-memscope";
const ORG = "oranke";
const TEAM_ID = "ddc2385f-0e54-4e04-ae41-1e4c06ad330d"; // 음료(T)
const TEAM_NAME = "음료(T)";
const PART = "주스";
const YEAR = 2026, ISOWK = 29;

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
async function makeGroup(name: string): Promise<string> {
  const { data, error } = await sb.from("process_line_groups").insert({ hub: "experience", name: `${TAG} ${name}`, sort_order: 999, is_active: true }).select("id").single();
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
async function seedStatus(actId: string, groupId: string, weekId: string, partName: string | null): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await sb.from("process_check_statuses").insert({
    organization_slug: ORG, hub: "experience", week_id: weekId, act_id: actId, line_group_id: groupId,
    team_id: TEAM_ID, part_name: partName, status: "completed", scope_mode: "test",
    requested_at: now, completed_at: now, checked_crew_count: 0,
  }).select("id").single();
  if (error) throw new Error(`seedStatus: ${error.message}`);
  const id = (data as any).id; refIds.push(id); return id;
}
async function seedRecipients(refId: string, userIds: string[]) {
  await sb.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", refId);
  await sb.from("process_check_review_recipients").insert(userIds.map((uid) => ({
    source: "regular", ref_id: refId, organization_slug: ORG, scope_mode: "test",
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

  // ── 카테고리 사용자 발굴(전부 oranke·test 모집단) ──
  const partCrews = (await listPartCrews(ORG, TEAM_NAME, PART, "test")).map((c) => c.userId);
  const teamCrews = (await listTeamCrews(ORG, TEAM_NAME, "test"));
  const parts = await listTeamParts(ORG, TEAM_NAME, "test");
  const otherPart = parts.find((p) => p !== PART) ?? null;
  const sameTeamOtherPart = otherPart ? teamCrews.find((c) => c.partName === otherPart)?.userId ?? null : null;

  // 타 팀(같은 org·test) 크루 1명 — 음료(T) 아닌 다른 experience 팀.
  const otherTeams = ((await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG).eq("is_active", true)).data ?? []) as any[];
  let otherTeamUser: string | null = null;
  for (const t of otherTeams) {
    if (t.id === TEAM_ID) continue;
    const c = (await listTeamCrews(ORG, t.team_name, "test")).map((x) => x.userId).filter((u) => !partCrews.includes(u));
    if (c.length) { otherTeamUser = c[0]; break; }
  }
  // 팀/파트 미소속(같은 org·test) — 어느 experience 팀 로스터에도 없는 test 유저.
  const inAnyRoster = new Set<string>();
  for (const t of otherTeams) for (const x of await listTeamCrews(ORG, t.team_name, "test")) inAnyRoster.add(x.userId);
  const orankeTest = (((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []) as any[]).map((u) => u.user_id).filter((u) => markers.has(u));
  const partlessUser = orankeTest.find((u) => !inAnyRoster.has(u)) ?? null;

  ck("[setup] 파트(주스) 로스터 ≥1", partCrews.length >= 1, `n=${partCrews.length}`);
  ck("[setup] 동일팀 타파트 크루 발굴", !!sameTeamOtherPart, `part=${otherPart} u=${sameTeamOtherPart?.slice(0, 8)}`);
  ck("[setup] 타팀 크루 발굴", !!otherTeamUser, `u=${otherTeamUser?.slice(0, 8)}`);
  ck("[setup] 팀/파트 미소속 크루 발굴", !!partlessUser, `u=${partlessUser?.slice(0, 8)}`);
  const weekRow = (await sb.from("weeks").select("id").eq("iso_year", YEAR).eq("iso_week", ISOWK).maybeSingle()).data as any;
  ck("[setup] 현재 주차(2026/W29) 존재", !!weekRow?.id);
  if (!weekRow?.id || !partCrews.length || !otherTeamUser || !partlessUser) {
    await cleanup(); console.log(`\n결과: ${pass} pass / ${fail} fail — setup 부족`); process.exit(1);
  }
  const WEEK = weekRow.id as string;
  const inScope = partCrews[0];

  // 카페 링크 집계(recipients)에 4범주 전부 포함 — 실제 소속은 inScope(주스)만.
  const outOfScope = [sameTeamOtherPart, otherTeamUser, partlessUser].filter(Boolean) as string[];
  const seeded = [inScope, ...outOfScope];

  const grp = await makeGroup("파트 라인급"); // "파트" 포함 → 파트 액트
  const actId = await makeAct(grp, "파트액트");
  const st = await seedStatus(actId, grp, WEEK, PART);
  await seedRecipients(st, seeded);

  // ── (원천 집계 불변 확인) recipients 에는 4명 그대로 저장 ──
  const rawRecip = ((await sb.from("process_check_review_recipients").select("user_id").eq("source", "regular").eq("ref_id", st).eq("match_type", "matched")).data ?? []).map((r: any) => r.user_id);
  ck("[원천불변] recipients(matched) 는 카페 집계 4명 그대로", sortJ(rawRecip) === sortJ(seeded), `n=${rawRecip.length}`);

  // ── 공통 로스터(SoT) = 파트 실제 소속자 ──
  const roster = await resolveCheckScopeRoster({ hub: "experience", organization: ORG, mode: "test", teamId: TEAM_ID, partName: PART });
  ck("[SoT] resolveCheckScopeRoster(part) == listPartCrews", sortJ(roster) === sortJ(partCrews));
  const expectedTargets = seeded.filter((u) => roster.includes(u)); // = [inScope]
  ck("[기대] 교집합 대상자 = [inScope] 1명", sortJ(expectedTargets) === sortJ([inScope]), `n=${expectedTargets.length}`);

  // ── 미리보기/실행(적립) 이행자 = 교집합 ──
  const pv = await previewRegularAccrual(st) as any;
  ck("[미리보기] performerCount = 1(교집합)", pv.performerCount === 1, `n=${pv.performerCount}`);

  // ── 보드(snapshot 조회) direct — 파트 스코프 ──
  const dBoard = await getProcessCheckBoard("experience", ORG, TEAM_ID, "test", "part", PART, WEEK);
  const dPart = boardActList(dBoard, actId, PART);
  ck("[보드 direct·part] completedCrewList = [inScope]", sortJ(dPart.ids) === sortJ([inScope]), `ids=${dPart.ids.map((x) => x.slice(0, 4))}`);
  ck("[보드 direct·part] checkedCrewCount = 1", dPart.row?.checkedCrewCount === 1, `cc=${dPart.row?.checkedCrewCount}`);
  ck("[보드 direct·part] reviewerDebug.matchedCrewCount = 1", dPart.row?.reviewerDebug?.matchedCrewCount === 1, `m=${dPart.row?.reviewerDebug?.matchedCrewCount}`);
  ck("[보드 direct·part] 타팀/타파트/미소속 제외", !dPart.ids.some((u) => outOfScope.includes(u)));

  // ── 보드 direct — 팀 총괄 스코프(part=null 로스터=팀 전체) : 파트 액트는 team_overall 에 안 뜸(별개 검증은 team_all) ──
  //   team_all(읽기전용)에서 파트 액트가 파트별로 펼쳐지며 각 파트 로스터로 교집합되는지 확인.
  const dAll = await getProcessCheckBoard("experience", ORG, TEAM_ID, "test", "team_all", null, WEEK);
  const dAllPart = boardActList(dAll, actId, PART);
  ck("[보드 direct·team_all] 파트행 completedCrewList = [inScope]", sortJ(dAllPart.ids) === sortJ([inScope]), `ids=${dAllPart.ids.length}`);

  // ── HTTP 파리티 ──
  const jar = await cookie(EMAIL);
  const api = async (path: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie: jar } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const hRes = await api(`/api/admin/processes/check?hub=experience&org=${ORG}&team=${TEAM_ID}&scope=part&part=${encodeURIComponent(PART)}&mode=test&week=${WEEK}`);
  const hPart = boardActList(hRes.json?.data ?? {}, actId, PART);
  ck("[HTTP·part] 200", hRes.status === 200, `status=${hRes.status}`);
  ck("[HTTP·part] completedCrewList = [inScope]", sortJ(hPart.ids) === sortJ([inScope]), `ids=${hPart.ids.map((x) => x.slice(0, 4))}`);
  ck("[direct==HTTP] 대상자 ID 목록 동일", sortJ(dPart.ids) === sortJ(hPart.ids));

  // ── 요구사항 #9: 미리보기·보드(direct)·보드(HTTP) 대상자 ID 동일 ──
  ck("[#9] 미리보기==보드(direct)==보드(HTTP) 대상자 동일", sortJ(dPart.ids) === sortJ(hPart.ids) && dPart.ids.length === pv.performerCount && sortJ(dPart.ids) === sortJ(expectedTargets));

  await cleanup();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); try { await cleanup(); } catch {} process.exit(1); });
