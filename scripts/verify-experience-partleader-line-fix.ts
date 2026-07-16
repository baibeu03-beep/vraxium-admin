/**
 * verify-experience-partleader-line-fix.ts
 * 실무 경험 [팀 총괄] 개설 완료 — 파트장 도출/분석/견문 라인 선택이
 *   (1) part_submission_cells.selected_line_id 로 저장되고(완료 후 화면 초기화 방지)
 *   (2) cluster4_line_targets 대상자로 배정되어 강화 성공으로 판정되는지
 * 를 실제 HTTP API(route → data layer → DB)로 검증한다. 클린-슬레이트(헤더 없음) 대상만
 * 골라 실행 후 완전 원복(cancel + 헤더/파트장 셀 삭제, 잔여 0)한다.
 *
 * 사전: dev 서버(:3000) 기동 + experience 마이그레이션 적용.
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-partleader-line-fix.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import { isWeekOfficialRestById } from "@/lib/cluster4OfficialRestWeek";
import type { ExperienceTeamOverallBoard as BoardDto } from "@/lib/experienceTeamOverallTypes";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const PART_CATS = ["derivation", "analysis", "evaluation"] as const;

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

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

function teamUrl(org: string, weekId: string, teamId: string, teamName: string, mode: string) {
  return `${BASE}/api/admin/cluster4/experience/team-overall?organization=${org}&week_id=${weekId}&team_id=${teamId}&team_name=${encodeURIComponent(teamName)}&mode=${mode}`;
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
async function waitForServer(cookie: string, url: string) {
  for (let i = 0; i < 30; i++) {
    try { const res = await fetch(url, { headers: { cookie } }); if (res.status === 200) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("dev server not ready");
}

async function main() {
  const cookie = await adminCookieHeader();

  // 비휴식 최근 주차들.
  const { data: recentWeeks } = await sb.from("weeks").select("id,week_number,start_date,season_key")
    .not("week_number", "is", null).order("start_date", { ascending: false }).limit(20);
  const nonRestWeeks: Array<{ id: string; label: string }> = [];
  for (const w of (recentWeeks ?? []) as Array<{ id: string; week_number: number; start_date: string; season_key: string | null }>) {
    const { rest } = await isWeekOfficialRestById(w.id);
    if (!rest) nonRestWeeks.push({ id: w.id, label: `${w.season_key ?? "?"} W${w.week_number} (${w.start_date})` });
  }

  // 클린-슬레이트 대상 탐색: 테스트 팀 × 비휴식 주차 중, team_overall 헤더 없고 파트장+도출/분석/견문 옵션 있는 첫 조합.
  const { data: teams } = await sb.from("cluster4_teams").select("id,team_name,organization_slug").ilike("team_name", "%(T)%");
  let target: { org: string; teamId: string; teamName: string; weekId: string; weekLabel: string; board: BoardDto; leader: { userId: string; displayName: string } } | null = null;

  outer:
  for (const t of (teams ?? []) as Array<{ id: string; team_name: string; organization_slug: string }>) {
    for (const w of nonRestWeeks) {
      const { data: hdr } = await sb.from("cluster4_experience_team_overall").select("id")
        .eq("organization_slug", t.organization_slug).eq("week_id", w.id).eq("team_id", t.id).maybeSingle();
      if (hdr) continue; // 헤더 존재 → 클린-슬레이트 아님.
      const board = await getTeamOverallBoard(t.organization_slug, w.id, t.id, t.team_name, "test");
      const leader = board.parts.flatMap((p) => p.crews).find((c) => c.isPartLeader);
      const hasOptions = PART_CATS.every((c) => (board.lineOptions[c]?.length ?? 0) > 0);
      if (leader && hasOptions) {
        target = { org: t.organization_slug, teamId: t.id, teamName: t.team_name, weekId: w.id, weekLabel: w.label, board, leader };
        break outer;
      }
    }
  }
  if (!target) throw new Error("클린-슬레이트(헤더없음+파트장+옵션) 테스트 대상 없음");

  const { org, teamId, teamName, weekId, weekLabel, board, leader } = target;
  const url = teamUrl(org, weekId, teamId, teamName, "test");
  await waitForServer(cookie, url);
  console.log(`\n대상: ${org} / ${teamName} / ${weekLabel}`);
  console.log(`파트장: ${leader.displayName} (${leader.userId.slice(0, 8)})`);

  // 선택 라인(파트장): 도출/분석/견문 각 옵션 [0].
  const chosen: Record<string, string> = {};
  for (const c of PART_CATS) chosen[c] = board.lineOptions[c][0].id;
  console.log(`선택 라인: 도출=${board.lineOptions.derivation[0].lineName} / 분석=${board.lineOptions.analysis[0].lineName} / 견문=${board.lineOptions.evaluation[0].lineName}`);

  // ── 원복용 스냅샷: 기존 헤더/셀 상태 ──
  const { data: hdrsBefore } = await sb.from("cluster4_experience_part_submissions").select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  const headerIdsBefore = new Set(((hdrsBefore ?? []) as Array<{ id: string }>).map((h) => h.id));
  const { count: snapCountBefore } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });

  // ── direct == HTTP 보드 파리티(mode=test) ──
  const get1 = await httpGet(cookie, url);
  check("[GET] direct == HTTP 보드 deep-equal (mode=test)", get1.status === 200 && JSON.stringify(board) === JSON.stringify(get1.json.data));

  // ── 개설 완료(mode=test): 파트장 3라인 선택 + 관리 leaderCells(기존 동작 유지) ──
  const crews = board.parts.flatMap((p) => p.crews);
  // 관리 라인명(파트장/에이전트) — 대상자 수집 게이트는 전 카테고리 selectedLineId 필수(2026-07-15 정책).
  //   실제 라인은 라우팅(isPartLeaderLine/_에이전트)이 결정하지만 게이트 통과용으로 선택값을 넣는다.
  const mgmtOptId = board.lineOptions.management?.[0]?.id ?? null;
  const leaderCells = crews
    .filter((c) => c.isPartLeader || c.statusLabel === "에이전트")
    .map((c) => ({ crewUserId: c.userId, category: "management" as const, checked: true, score: 7, selectedLineId: mgmtOptId }));
  const lineSelections = [
    ...PART_CATS.map((c) => ({ crewUserId: leader.userId, lineType: c, selectedLineId: chosen[c] })),
  ];
  const openRes = await httpPost(cookie, { action: "open", organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode: "test", leaderCells, outputs: [], lineSelections });
  check("[POST open] 201 성공", openRes.status === 201 && openRes.json?.success, `status=${openRes.status} ${openRes.json?.error ?? ""}`);
  const openData = openRes.json?.data ?? {};
  console.log(`  open 결과: lines=${openData.linesCreated} targets=${openData.targetsCreated} evals=${openData.evaluationsCreated} warnings=${(openRes.json?.warnings ?? []).length}`);

  // ── (1) 파트장 part_submission_cell 저장 확인 ──
  const { data: hdrsAfter } = await sb.from("cluster4_experience_part_submissions").select("id,part_name").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  const headerIdsAfter = ((hdrsAfter ?? []) as Array<{ id: string; part_name: string }>).map((h) => h.id);
  const { data: leaderCellRows } = await sb.from("cluster4_experience_part_submission_cells")
    .select("line_type,selected_line_id,checked,score").in("submission_id", headerIdsAfter.length ? headerIdsAfter : ["x"]).eq("crew_user_id", leader.userId);
  const cellByType = new Map(((leaderCellRows ?? []) as Array<{ line_type: string; selected_line_id: string | null; checked: boolean; score: number }>).map((c) => [c.line_type, c]));
  for (const c of PART_CATS) {
    const cell = cellByType.get(c);
    check(`[DB 셀] 파트장 ${c} selected_line_id 저장`, !!cell && cell.selected_line_id === chosen[c] && cell.checked === true && cell.score === 7, cell ? `line=${cell.selected_line_id?.slice(0, 8)} chk=${cell.checked} s=${cell.score}` : "셀 없음");
  }

  // ── (2) 파트장 cluster4_line_targets 배정 확인(강화 성공 SoT) ──
  const { data: hdrOverall } = await sb.from("cluster4_experience_team_overall").select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId).maybeSingle();
  const overallId = (hdrOverall as { id: string } | null)?.id ?? null;
  const { data: openedLines } = await sb.from("cluster4_experience_team_overall_opened_lines").select("line_id,category").eq("overall_id", overallId ?? "x");
  const oLines = (openedLines ?? []) as Array<{ line_id: string; category: string }>;
  const lineIds = oLines.map((r) => r.line_id);
  const catByLine = new Map(oLines.map((r) => [r.line_id, r.category]));
  const { data: tgtRows } = await sb.from("cluster4_line_targets").select("id,line_id,target_user_id").in("line_id", lineIds.length ? lineIds : ["x"]);
  const partDerivedTargets: Record<string, Set<string>> = { derivation: new Set(), analysis: new Set(), evaluation: new Set() };
  const leaderTargetIds: string[] = [];
  const mgmtTargets = new Set<string>();
  for (const t of (tgtRows ?? []) as Array<{ id: string; line_id: string; target_user_id: string | null }>) {
    const cat = catByLine.get(t.line_id);
    if (!t.target_user_id) continue;
    if (cat && PART_CATS.includes(cat as typeof PART_CATS[number])) {
      partDerivedTargets[cat].add(t.target_user_id);
      if (t.target_user_id === leader.userId) leaderTargetIds.push(t.id);
    }
    if (cat === "management") mgmtTargets.add(t.target_user_id);
  }
  for (const c of PART_CATS) {
    check(`[DB 타깃] 파트장 ${c} 라인 대상자 배정(=강화 성공)`, partDerivedTargets[c].has(leader.userId), `대상자 ${partDerivedTargets[c].size}명`);
  }
  // 평가행(rating) 동반 생성.
  const { data: evalRows } = await sb.from("cluster4_experience_line_evaluations").select("rating").in("line_target_id", leaderTargetIds.length ? leaderTargetIds : ["x"]);
  check("[DB 평가] 파트장 라인 평가행 rating=7 동반 생성", (evalRows ?? []).length === PART_CATS.length && (evalRows ?? []).every((e: { rating: number }) => e.rating === 7), `evals=${(evalRows ?? []).length}`);

  // ── (3) 완료 후 재조회 라운드트립(화면 초기화 없음) ──
  const get2 = await httpGet(cookie, url);
  const board2 = get2.json?.data as BoardDto;
  const leader2 = board2?.parts.flatMap((p) => p.crews).find((c) => c.userId === leader.userId);
  for (const c of PART_CATS) {
    check(`[재조회] 파트장 ${c} 라인명 유지(초기화 없음)`, leader2?.cells[c]?.selectedLineId === chosen[c], `board.selectedLineId=${leader2?.cells[c]?.selectedLineId?.slice(0, 8) ?? "null"}`);
  }

  // ── (4) 회귀: 파트-파생 라인의 대상자는 파트장뿐(다른 크루 미영향) + 파트장 관리 라인 유지 ──
  const allPartDerived = new Set([...partDerivedTargets.derivation, ...partDerivedTargets.analysis, ...partDerivedTargets.evaluation]);
  check("[회귀] 도출/분석/견문 대상자 = 파트장 1명뿐(다른 크루 미영향)", allPartDerived.size === 1 && allPartDerived.has(leader.userId), `대상자=${allPartDerived.size}명`);
  check("[회귀] 파트장 관리 라인 배정 유지(기존 동작)", mgmtTargets.has(leader.userId));
  const { count: snapCountAfter } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  check("[회귀] snapshot 생성 없음(count 불변)", (snapCountAfter ?? 0) === (snapCountBefore ?? 0), `${snapCountBefore}→${snapCountAfter}`);

  // ── 원복: cancel + 파트장 셀 삭제 + phantom 헤더 삭제 + overall 헤더 삭제 ──
  const cancelRes = await httpPost(cookie, { action: "cancel", organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode: "test" });
  check("[cancel] 200 원복", cancelRes.status === 200 && cancelRes.json?.success, `removed=${cancelRes.json?.data?.linesRemoved}`);
  // 파트장 materialized 셀 삭제(테스트가 만든 것).
  await sb.from("cluster4_experience_part_submission_cells").delete().in("submission_id", headerIdsAfter.length ? headerIdsAfter : ["x"]).eq("crew_user_id", leader.userId);
  // phantom 헤더(테스트가 새로 만든 헤더) 삭제.
  const phantomHeaderIds = headerIdsAfter.filter((id) => !headerIdsBefore.has(id));
  if (phantomHeaderIds.length > 0) await sb.from("cluster4_experience_part_submissions").delete().in("id", phantomHeaderIds);
  // overall 헤더 삭제(클린-슬레이트 복귀).
  await sb.from("cluster4_experience_team_overall").delete().eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);

  // 잔여 0 확인.
  const { data: linesResidue } = await sb.from("cluster4_lines").select("id").in("id", lineIds.length ? lineIds : ["x"]);
  check("[원복] 개설 라인 잔여 0", (linesResidue ?? []).length === 0);
  const { data: leaderCellResidue } = await sb.from("cluster4_experience_part_submission_cells").select("id").in("submission_id", headerIdsBefore.size ? [...headerIdsBefore] : ["x"]).eq("crew_user_id", leader.userId);
  check("[원복] 파트장 셀 잔여 0(원래 헤더 기준)", (leaderCellResidue ?? []).length === 0);
  const { data: hdrResidue } = await sb.from("cluster4_experience_team_overall").select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  check("[원복] team_overall 헤더 잔여 0", (hdrResidue ?? []).length === 0);

  // ── (5) operating 파리티 dry-run(write 0): 운영 팀 보드에도 파트장 기본 도출셀(checked/7) 존재 → 동일 fix 적용 ──
  console.log("\n=== operating 파리티 dry-run(write 0) ===");
  const { data: opTeams } = await sb.from("cluster4_teams").select("id,team_name,organization_slug").not("team_name", "ilike", "%(T)%").limit(200);
  let opChecked = false;
  for (const t of (opTeams ?? []) as Array<{ id: string; team_name: string; organization_slug: string }>) {
    for (const w of nonRestWeeks.slice(0, 3)) {
      const opBoard = await getTeamOverallBoard(t.organization_slug, w.id, t.id, t.team_name, "operating");
      const opLeader = opBoard.parts.flatMap((p) => p.crews).find((c) => c.isPartLeader);
      if (!opLeader) continue;
      const d = opLeader.cells.derivation;
      check(`[operating] ${t.organization_slug}/${t.team_name}: 파트장 도출셀 기본 checked/7(동일 코드경로)`, d.checked === true && d.score === 7, `chk=${d.checked} s=${d.score}`);
      opChecked = true;
      break;
    }
    if (opChecked) break;
  }
  if (!opChecked) console.log("  (운영 팀 파트장 없음 — dry-run 생략)");

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
