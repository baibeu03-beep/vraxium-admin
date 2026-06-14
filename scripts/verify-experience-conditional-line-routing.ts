/**
 * verify-experience-conditional-line-routing.ts
 * 실무경험 견문/관리 조건부 라인 라우팅(2026-06-13) 검증.
 *
 *  A. [direct·순수] resolveCategoryLineGroups 전 분기 단위 검증(DB write 0):
 *       견문 cw<=1→마케터 Launch / cw>=2→상호 피드백 / 단일후보 폴백,
 *       관리 파트장→_파트장 / 에이전트→_에이전트 / 일반 제외, 도출=단일.
 *  B. [direct==HTTP·라이브] oranke 테스트 팀(mode=test)에 실제 개설 → 생성된
 *       cluster4_lines line_code 가 각 크루의 실제 누적주차/역할대로 라우팅됐는지 확인,
 *       성장 테이블(user_growth_stats/user_week_statuses/user_weekly_points) write 0,
 *       snapshot stale-only, 그 뒤 [개설 취소]+헤더 삭제로 완전 원복(잔여 0).
 *  C. [operating dry-run] 운영 팀 보드로 동일 함수 라우팅 검사(write 0) — 양 모드 동일 정책.
 *
 * 사전: dev 서버(:3000) 기동 + experience_team_overall 마이그레이션 적용.
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-conditional-line-routing.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  getTeamOverallBoard,
  resolveCategoryLineGroups,
  type RegLine,
  type RoutingTarget,
} from "@/lib/adminExperienceTeamOverall";
import { isWeekOfficialRestById } from "@/lib/cluster4OfficialRestWeek";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const ORG = "oranke";
// 예상 라인 코드(진단으로 확인됨).
const CODE_LAUNCH = "EXOK-EN0001"; // [커리어] 마케터 Launch
const CODE_MUTUAL = "EXOK-EN0004"; // [생산성] 상호 피드백
const CODE_LEADER = "EXBS-EL0001"; // _파트장
const CODE_AGENT = "EXBS-EL0002"; // _에이전트

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

function mkReg(code: string, name: string): RegLine {
  return { bridgedMasterId: `bm-${code}`, lineCode: code, lineName: name, mainTitle: name, outputImages: null, outputLinks: null };
}
function mkTarget(userId: string, opts: Partial<RoutingTarget>): RoutingTarget {
  return { userId, score: 7, isPartLeader: false, statusLabel: "일반", cumulativeWeeks: 0, ...opts };
}

// ─────────────────────────────────────────────────────────────────────
// A. 순수 단위 검증 (DB write 0)
// ─────────────────────────────────────────────────────────────────────
function unitTests() {
  console.log("\n=== A. resolveCategoryLineGroups 순수 단위 검증 ===");
  const evalCands = [mkReg(CODE_LAUNCH, "[커리어] 마케터 Launch"), mkReg(CODE_MUTUAL, "[생산성] 상호 피드백")];
  const evalSingle = [mkReg("EXEC-EN0003", "[다면 피드백] 실무 생산성 강화")]; // encre 단일후보
  const mgmtCands = [mkReg(CODE_LEADER, "[매니징] 세부 팀/조직 관리_파트장"), mkReg(CODE_AGENT, "[매니징] 세부 팀/조직 관리_에이전트")];
  const derivCands = [mkReg("EXOK-EN0002", "[콘텐츠] 마케팅 실무_기획/제작")];

  // 견문: cw 0/1 → 마케터 Launch, cw 2/3 → 상호 피드백.
  {
    const targets = [
      mkTarget("u0", { cumulativeWeeks: 0 }),
      mkTarget("u1", { cumulativeWeeks: 1 }),
      mkTarget("u2", { cumulativeWeeks: 2 }),
      mkTarget("u3", { cumulativeWeeks: 5 }),
    ];
    const groups = resolveCategoryLineGroups("evaluation", evalCands, targets, null, []);
    const launch = groups.find((g) => g.reg.lineCode === CODE_LAUNCH);
    const mutual = groups.find((g) => g.reg.lineCode === CODE_MUTUAL);
    check("견문: cw<=1(0,1) → 마케터 Launch", !!launch && launch.targets.map((t) => t.userId).sort().join(",") === "u0,u1", launch ? launch.targets.map((t) => t.userId).join(",") : "없음");
    check("견문: cw>=2(2,5) → 상호 피드백", !!mutual && mutual.targets.map((t) => t.userId).sort().join(",") === "u2,u3", mutual ? mutual.targets.map((t) => t.userId).join(",") : "없음");
    check("견문: 그룹 2개(분리 개설)", groups.length === 2);
  }
  // 견문: 한쪽만 대상이면 그 라인 1개만.
  {
    const groups = resolveCategoryLineGroups("evaluation", evalCands, [mkTarget("a", { cumulativeWeeks: 0 })], null, []);
    check("견문: 신규(cw0)만 있으면 마케터 Launch 1그룹", groups.length === 1 && groups[0].reg.lineCode === CODE_LAUNCH);
  }
  // 견문 단일후보(encre/phalanx): 분기 없이 단일 라인.
  {
    const warns: string[] = [];
    const groups = resolveCategoryLineGroups("evaluation", evalSingle, [mkTarget("a", { cumulativeWeeks: 0 }), mkTarget("b", { cumulativeWeeks: 9 })], null, warns);
    check("견문 단일후보: 전 크루 단일 라인 폴백", groups.length === 1 && groups[0].targets.length === 2 && groups[0].reg.lineCode === "EXEC-EN0003");
  }
  // 관리: 파트장→_파트장, 에이전트→_에이전트, 일반→제외.
  {
    const warns: string[] = [];
    const targets = [
      mkTarget("pl", { isPartLeader: true, statusLabel: "파트장" }),
      mkTarget("ag", { isPartLeader: false, statusLabel: "에이전트" }),
      mkTarget("nm", { isPartLeader: false, statusLabel: "일반" }),
    ];
    const groups = resolveCategoryLineGroups("management", mgmtCands, targets, null, warns);
    const leader = groups.find((g) => g.reg.lineCode === CODE_LEADER);
    const agent = groups.find((g) => g.reg.lineCode === CODE_AGENT);
    check("관리: 파트장 → _파트장", !!leader && leader.targets.length === 1 && leader.targets[0].userId === "pl");
    check("관리: 에이전트 → _에이전트", !!agent && agent.targets.length === 1 && agent.targets[0].userId === "ag");
    const allTargetIds = groups.flatMap((g) => g.targets.map((t) => t.userId));
    check("관리: 일반 제외(어느 라인에도 없음)", !allTargetIds.includes("nm"), `routed=${allTargetIds.join(",")}`);
    check("관리: 일반 제외 경고 발생", warns.some((w) => w.includes("nm") && w.includes("전용")));
  }
  // 도출: 단일 라인.
  {
    const groups = resolveCategoryLineGroups("derivation", derivCands, [mkTarget("a", {}), mkTarget("b", {})], null, []);
    check("도출: 단일 라인(라우팅 없음)", groups.length === 1 && groups[0].targets.length === 2);
  }
  // 순수성(모드 무관): 동일 입력 → 동일 출력.
  {
    const t = [mkTarget("x", { cumulativeWeeks: 0 }), mkTarget("y", { cumulativeWeeks: 3 })];
    const g1 = resolveCategoryLineGroups("evaluation", evalCands, t, null, []);
    const g2 = resolveCategoryLineGroups("evaluation", evalCands, t, null, []);
    check("순수성: 동일입력 동일출력(operating/test 동일 정책)", JSON.stringify(g1) === JSON.stringify(g2));
  }
}

// ─────────────────────────────────────────────────────────────────────
// admin 세션 쿠키
// ─────────────────────────────────────────────────────────────────────
async function adminCookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  if (vErr) throw vErr;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session!.access_token, refresh_token: verifyData.session!.refresh_token });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

function teamUrl(weekId: string, teamId: string, teamName: string, mode: string) {
  return `${BASE}/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${teamId}&team_name=${encodeURIComponent(teamName)}&mode=${mode}`;
}
async function waitForServer(cookie: string, url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url, { headers: { cookie } });
      if (res.status === 200) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("dev server not ready after 120s");
}
async function httpGet(cookie: string, url: string) {
  const res = await fetch(url, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}
async function httpPost(cookie: string, body: unknown) {
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function snapBaseline() {
  const { count } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  const { data: latest } = await sb.from("cluster4_weekly_card_snapshots").select("computed_at").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return { count: count ?? 0, latest: (latest as { computed_at?: string } | null)?.computed_at ?? null };
}
async function tableCount(table: string, userIds: string[]): Promise<number> {
  if (userIds.length === 0) return 0;
  const { count } = await sb.from(table).select("*", { count: "exact", head: true }).in("user_id", userIds);
  return count ?? 0;
}
async function cumulativeWeeksMap(userIds: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (userIds.length === 0) return m;
  const { data } = await sb.from("user_growth_stats").select("user_id,cumulative_weeks").in("user_id", userIds);
  for (const r of (data ?? []) as Array<{ user_id: string; cumulative_weeks: number | null }>) m.set(r.user_id, r.cumulative_weeks ?? 0);
  return m;
}
async function deleteOverallHeader(weekId: string, teamId: string) {
  await sb.from("cluster4_experience_team_overall").delete().eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", teamId);
}

// (org, 후보 팀명집합) → 크루 있는 첫 팀 {id,name}.
async function pickTeam(names: string[]): Promise<{ id: string; name: string } | null> {
  const { data } = await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG).in("team_name", names);
  for (const t of (data ?? []) as Array<{ id: string; team_name: string }>) return { id: t.id, name: t.team_name };
  return null;
}

async function main() {
  unitTests();

  const cookie = await adminCookieHeader();
  // 비휴식 주차 선택(assertWeekOpenable 통과) — 최근 주차 중 공식 휴식 아닌 첫 주차.
  const { data: recentWeeks } = await sb
    .from("weeks")
    .select("id,week_number,start_date,season_key")
    .not("week_number", "is", null)
    .order("start_date", { ascending: false })
    .limit(40);
  let weekId: string | null = null;
  let weekLabel = "";
  for (const w of (recentWeeks ?? []) as Array<{ id: string; week_number: number; start_date: string; season_key: string | null }>) {
    const { rest } = await isWeekOfficialRestById(w.id);
    if (!rest) { weekId = w.id; weekLabel = `${w.season_key ?? "?"} W${w.week_number} (${w.start_date})`; break; }
  }
  if (!weekId) throw new Error("비휴식 주차를 찾지 못함");

  // ── B. 라이브 테스트 팀(mode=test) ──
  console.log("\n=== B. 라이브 라우팅(mode=test, oranke 테스트 팀) ===");
  const testTeam = await pickTeam(["과일(T)", "음료(T)", "콘텐츠실험(T)"]);
  if (!testTeam) throw new Error("oranke 테스트 팀 조회 실패");
  const url = teamUrl(weekId, testTeam.id, testTeam.name, "test");
  console.log(`  대상: team=${testTeam.name}(${testTeam.id}) week=${weekLabel}`);
  await waitForServer(cookie, url);
  await deleteOverallHeader(weekId, testTeam.id);

  // direct == HTTP 보드 일치.
  const direct = await getTeamOverallBoard(ORG, weekId, testTeam.id, testTeam.name, "test");
  const get1 = await httpGet(cookie, url);
  check("[B] direct == HTTP (보드 deep-equal, mode=test)", get1.status === 200 && JSON.stringify(direct) === JSON.stringify(get1.json.data));

  const crews = direct.parts.flatMap((p) => p.crews);
  const crewIds = crews.map((c) => c.userId);
  check("[B] 테스트 팀 크루 존재", crews.length > 0, `crews=${crews.length}`);
  const cwMap = await cumulativeWeeksMap(crewIds);

  // 예상 라우팅(보드 DTO의 isPartLeader/statusLabel + cumulative_weeks).
  const expEval = new Map<string, string>(); // userId → 예상 견문 line_code
  const expMgmt = new Map<string, string | null>(); // userId → 예상 관리 line_code(null=제외)
  for (const c of crews) {
    const cw = cwMap.get(c.userId) ?? 0;
    expEval.set(c.userId, cw <= 1 ? CODE_LAUNCH : CODE_MUTUAL);
    expMgmt.set(c.userId, c.isPartLeader ? CODE_LEADER : c.statusLabel === "에이전트" ? CODE_AGENT : null);
  }
  const dist = {
    cwLE1: crews.filter((c) => (cwMap.get(c.userId) ?? 0) <= 1).length,
    cwGE2: crews.filter((c) => (cwMap.get(c.userId) ?? 0) >= 2).length,
    leader: crews.filter((c) => c.isPartLeader).length,
    agent: crews.filter((c) => c.statusLabel === "에이전트").length,
    normal: crews.filter((c) => !c.isPartLeader && c.statusLabel !== "에이전트").length,
  };
  console.log(`  분포: cw<=1=${dist.cwLE1} cw>=2=${dist.cwGE2} | 파트장=${dist.leader} 에이전트=${dist.agent} 일반=${dist.normal}`);

  // 성장 테이블 baseline(write 0 확인용).
  const before = {
    ugs: await tableCount("user_growth_stats", crewIds),
    uws: await tableCount("user_week_statuses", crewIds),
    uwp: await tableCount("user_weekly_points", crewIds),
    snap: await snapBaseline(),
    lines: (await sb.from("cluster4_lines").select("id", { count: "exact", head: true }).eq("team_id", testTeam.id).eq("part_type", "experience")).count ?? 0,
  };

  // 개설 완료(mode=test) — 관리 기본 checked/7 전 크루 전송(견문/도출/분석은 파트 미신청=라이브 기본).
  const leaderCells = crews.map((c) => ({ crewUserId: c.userId, category: "management" as const, checked: true, score: 7 }));
  const openRes = await httpPost(cookie, { action: "open", organization: ORG, week_id: weekId, team_id: testTeam.id, team_name: testTeam.name, mode: "test", leaderCells, outputs: [] });
  check("[B] HTTP POST open(mode=test) → 201", openRes.status === 201 && openRes.json?.success, `status=${openRes.status} ${openRes.json?.error ?? ""}`);
  const openData = openRes.json?.data ?? {};
  console.log(`  open: lines=${openData.linesCreated} targets=${openData.targetsCreated} evals=${openData.evaluationsCreated} warnings=${(openRes.json?.warnings ?? []).length}`);

  // 생성된 (category, line_code) → target userIds 맵.
  const { data: openedLines } = await sb
    .from("cluster4_experience_team_overall_opened_lines")
    .select("line_id,category, cluster4_experience_team_overall!inner(week_id,team_id,organization_slug)")
    .eq("cluster4_experience_team_overall.organization_slug", ORG)
    .eq("cluster4_experience_team_overall.week_id", weekId)
    .eq("cluster4_experience_team_overall.team_id", testTeam.id);
  const oLines = (openedLines ?? []) as Array<{ line_id: string; category: string }>;
  const lineIds = oLines.map((r) => r.line_id);
  const { data: lineRows } = await sb.from("cluster4_lines").select("id,line_code").in("id", lineIds.length ? lineIds : ["x"]);
  const codeById = new Map(((lineRows ?? []) as Array<{ id: string; line_code: string }>).map((l) => [l.id, l.line_code]));
  const { data: tgtRows } = await sb.from("cluster4_line_targets").select("line_id,target_user_id").in("line_id", lineIds.length ? lineIds : ["x"]);
  const catByLine = new Map(oLines.map((r) => [r.line_id, r.category]));
  // userId → {evaluation: code, management: code}
  const actualEval = new Map<string, string>();
  const actualMgmt = new Map<string, string>();
  for (const t of (tgtRows ?? []) as Array<{ line_id: string; target_user_id: string }>) {
    const cat = catByLine.get(t.line_id);
    const code = codeById.get(t.line_id) ?? "?";
    if (cat === "evaluation") actualEval.set(t.target_user_id, code);
    if (cat === "management") actualMgmt.set(t.target_user_id, code);
  }

  // 견문 라우팅 일치.
  let evalOk = 0, evalBad = 0;
  for (const c of crews) {
    if (actualEval.get(c.userId) === expEval.get(c.userId)) evalOk++;
    else { evalBad++; if (evalBad <= 3) console.log(`    견문 불일치 ${c.userId}: 예상 ${expEval.get(c.userId)} 실제 ${actualEval.get(c.userId)} (cw=${cwMap.get(c.userId) ?? 0})`); }
  }
  check("[B] 견문: 전 크루 cw 기준 라우팅 일치", evalBad === 0, `ok=${evalOk} bad=${evalBad}`);

  // 관리 라우팅 일치(일반=비대상).
  let mgmtOk = 0, mgmtBad = 0;
  for (const c of crews) {
    const exp = expMgmt.get(c.userId); // null=제외
    const act = actualMgmt.get(c.userId) ?? null;
    if (exp === act) mgmtOk++;
    else { mgmtBad++; if (mgmtBad <= 3) console.log(`    관리 불일치 ${c.userId}: 예상 ${exp} 실제 ${act} (isPL=${c.isPartLeader} label=${c.statusLabel})`); }
  }
  check("[B] 관리: 파트장→_파트장 / 에이전트→_에이전트 / 일반 제외 일치", mgmtBad === 0, `ok=${mgmtOk} bad=${mgmtBad}`);
  check("[B] 관리: 일반 크루는 관리 라인 비대상", crews.filter((c) => !c.isPartLeader && c.statusLabel !== "에이전트").every((c) => !actualMgmt.has(c.userId)));

  // 성장 테이블 write 0.
  const after = {
    ugs: await tableCount("user_growth_stats", crewIds),
    uws: await tableCount("user_week_statuses", crewIds),
    uwp: await tableCount("user_weekly_points", crewIds),
    snap: await snapBaseline(),
  };
  check("[B] user_growth_stats write 0(행수 불변)", after.ugs === before.ugs, `${before.ugs}→${after.ugs}`);
  check("[B] user_week_statuses write 0(행수 불변)", after.uws === before.uws, `${before.uws}→${after.uws}`);
  check("[B] user_weekly_points write 0(행수 불변)", after.uwp === before.uwp, `${before.uwp}→${after.uwp}`);
  check("[B] snapshot 생성/강제재계산 없음(count·최신 불변)", after.snap.count === before.snap.count && after.snap.latest === before.snap.latest, `count ${before.snap.count}→${after.snap.count}`);

  // ── 개설 취소 + 헤더 삭제(완전 원복) ──
  const cancelRes = await httpPost(cookie, { action: "cancel", organization: ORG, week_id: weekId, team_id: testTeam.id, team_name: testTeam.name, mode: "test" });
  check("[B] HTTP POST cancel → 200", cancelRes.status === 200 && cancelRes.json?.success, `removed=${cancelRes.json?.data?.linesRemoved}`);
  const { data: linesAfter } = await sb.from("cluster4_lines").select("id").in("id", lineIds.length ? lineIds : ["x"]);
  check("[B] cluster4_lines 원복(0 잔여)", (linesAfter ?? []).length === 0);
  await deleteOverallHeader(weekId, testTeam.id);
  const afterLines = (await sb.from("cluster4_lines").select("id", { count: "exact", head: true }).eq("team_id", testTeam.id).eq("part_type", "experience")).count ?? 0;
  check("[B] 팀 experience 라인 수 원복(baseline 일치)", afterLines === before.lines, `${before.lines}→${afterLines}`);

  // ── C. operating dry-run(운영 팀 보드 → 동일 함수 라우팅, write 0) ──
  console.log("\n=== C. operating dry-run(운영 팀, write 0) ===");
  // 운영 팀: 비테스트 팀 중 크루 있는 팀.
  const { data: opTeams } = await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG);
  let opChecked = false;
  for (const t of (opTeams ?? []) as Array<{ id: string; team_name: string }>) {
    if (t.team_name.includes("(T)")) continue;
    const opBoard = await getTeamOverallBoard(ORG, weekId, t.id, t.team_name, "operating");
    const opCrews = opBoard.parts.flatMap((p) => p.crews);
    if (opCrews.length === 0) continue;
    const opCw = await cumulativeWeeksMap(opCrews.map((c) => c.userId));
    // 견문/관리 후보 재현(loadRegLinesByCategory 와 동일 필터).
    const { data: regs } = await sb.from("line_registrations")
      .select("line_code,line_name,line_type,bridged_master_id,main_title,main_title_mode,output_images,output_links")
      .eq("hub", "experience").eq("is_active", true).not("bridged_master_id", "is", null)
      .or(`organization_slug.is.null,organization_slug.eq.${ORG}`);
    const evalC: RegLine[] = [], mgmtC: RegLine[] = [];
    for (const r of (regs ?? []) as Array<Record<string, any>>) {
      const reg = mkReg(r.line_code, r.line_name);
      reg.bridgedMasterId = r.bridged_master_id;
      if (r.line_type === "평가") evalC.push(reg);
      if (r.line_type === "관리") mgmtC.push(reg);
    }
    const evalTargets: RoutingTarget[] = opCrews.map((c) => ({ userId: c.userId, score: 7, isPartLeader: c.isPartLeader, statusLabel: c.statusLabel, cumulativeWeeks: opCw.get(c.userId) ?? 0 }));
    const evalGroups = resolveCategoryLineGroups("evaluation", evalC, evalTargets, null, []);
    const mgmtGroups = resolveCategoryLineGroups("management", mgmtC, evalTargets, null, []);
    // 검증: 견문 그룹 코드는 cw 규칙대로.
    const evalOkAll = evalGroups.every((g) => g.targets.every((t) => (g.reg.lineCode === CODE_LAUNCH ? t.cumulativeWeeks <= 1 : g.reg.lineCode === CODE_MUTUAL ? t.cumulativeWeeks >= 2 : true)));
    const mgmtOkAll = mgmtGroups.every((g) => g.targets.every((t) => (g.reg.lineCode === CODE_LEADER ? t.isPartLeader : g.reg.lineCode === CODE_AGENT ? t.statusLabel === "에이전트" : true)));
    const normalsExcluded = opCrews.filter((c) => !c.isPartLeader && c.statusLabel !== "에이전트").every((c) => !mgmtGroups.some((g) => g.targets.some((t) => t.userId === c.userId)));
    check(`[C] operating ${t.team_name}: 견문 cw 규칙 준수`, evalOkAll, `groups=${evalGroups.length}`);
    check(`[C] operating ${t.team_name}: 관리 역할 규칙 준수 + 일반 제외`, mgmtOkAll && normalsExcluded);
    opChecked = true;
    break;
  }
  if (!opChecked) console.log("  (운영 팀에 활동 크루 없음 — dry-run 생략, 단위검증으로 대체)");

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
