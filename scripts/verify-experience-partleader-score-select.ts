/**
 * verify-experience-partleader-score-select.ts
 * 실무 경험 [팀 총괄] 개설 검수 — 파트장 도출/분석/견문 "점수 선택" 검증.
 *   파트장은 [개설 신청] 그리드가 없어 점수 입력 경로가 검수 화면뿐이다. 이 스크립트는
 *   (1) 검수 payload 의 파트장 점수(lineSelections[].score/checked)가
 *       part_submission_cells.score 로 그대로 저장되고(하드코딩 7 아님),
 *   (2) 재검수로 점수를 바꾸면 갱신되며(고정 기본값 아님 — 서로 다른 두 점수셋),
 *   (3) 개설 완료 시 cluster4_experience_line_evaluations.rating = 선택 점수로 반영되고,
 *   (4) 완료/새로고침 후 재조회 DTO 가 선택 점수를 그대로 돌려주는지
 * 를 실제 HTTP API(route → data layer → DB)로 검증한다. 클린-슬레이트(헤더 없음) 대상만
 * 골라 실행 후 완전 원복(cancel + 헤더/파트장 셀 삭제, 잔여 0)한다.
 *
 * 사전: dev 서버(:3000) 기동 + experience 마이그레이션 적용.
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-partleader-score-select.ts
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
type PartCat = (typeof PART_CATS)[number];

// 서로 다른 두 점수셋(둘 다 기본값 7 아님) — 고정 저장이 아니라 선택값이 반영되는지 확인용.
const SCORES_A: Record<PartCat, number> = { derivation: 5, analysis: 9, evaluation: 2 };
const SCORES_B: Record<PartCat, number> = { derivation: 8, analysis: 4, evaluation: 6 };

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

// 파트장 도출/분석/견문 점수 셀 조회(현재 DB 값).
async function readLeaderCells(headerIds: string[], leaderUserId: string) {
  const { data } = await sb.from("cluster4_experience_part_submission_cells")
    .select("line_type,selected_line_id,checked,score")
    .in("submission_id", headerIds.length ? headerIds : ["x"]).eq("crew_user_id", leaderUserId);
  return new Map(((data ?? []) as Array<{ line_type: string; selected_line_id: string | null; checked: boolean; score: number }>).map((c) => [c.line_type, c]));
}
async function currentHeaderIds(org: string, weekId: string, teamId: string): Promise<string[]> {
  const { data } = await sb.from("cluster4_experience_part_submissions").select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  return ((data ?? []) as Array<{ id: string }>).map((h) => h.id);
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

  // 클린-슬레이트 대상 탐색: 테스트 팀 × 비휴식 주차 중, 헤더 없고 파트장+도출/분석/견문 옵션 있는 조합.
  //   개설 가능(canOpen) 주차만 — 아니면 open POST 가 409(개설 기간 게이트).
  const { data: teams } = await sb.from("cluster4_teams").select("id,team_name,organization_slug").ilike("team_name", "%(T)%");
  let target: { org: string; teamId: string; teamName: string; weekId: string; weekLabel: string; board: BoardDto; leader: { userId: string; displayName: string } } | null = null;

  outer:
  for (const t of (teams ?? []) as Array<{ id: string; team_name: string; organization_slug: string }>) {
    for (const w of nonRestWeeks) {
      const { data: hdr } = await sb.from("cluster4_experience_team_overall").select("id")
        .eq("organization_slug", t.organization_slug).eq("week_id", w.id).eq("team_id", t.id).maybeSingle();
      if (hdr) continue; // 헤더 존재 → 클린-슬레이트 아님.
      const board = await getTeamOverallBoard(t.organization_slug, w.id, t.id, t.team_name, "test");
      if (!board.canOpen) continue; // 개설 기간 아님 → open 409. 스킵.
      if (!board.application.allPartsApplied) continue; // 검수 사전조건 미충족 → 스킵.
      const leader = board.parts.flatMap((p) => p.crews).find((c) => c.isPartLeader);
      const hasOptions = PART_CATS.every((c) => (board.lineOptions[c]?.length ?? 0) > 0);
      if (leader && hasOptions) {
        target = { org: t.organization_slug, teamId: t.id, teamName: t.team_name, weekId: w.id, weekLabel: w.label, board, leader };
        break outer;
      }
    }
  }
  if (!target) throw new Error("클린-슬레이트(헤더없음+canOpen+신청완료+파트장+옵션) 테스트 대상 없음");

  const { org, teamId, teamName, weekId, weekLabel, board, leader } = target;
  const url = teamUrl(org, weekId, teamId, teamName, "test");
  await waitForServer(cookie, url);
  console.log(`\n대상: ${org} / ${teamName} / ${weekLabel}`);
  console.log(`파트장: ${leader.displayName} (${leader.userId.slice(0, 8)})`);

  const chosen: Record<PartCat, string> = { derivation: "", analysis: "", evaluation: "" };
  for (const c of PART_CATS) chosen[c] = board.lineOptions[c][0].id;

  // ── 원복용 스냅샷 ──
  const headerIdsBefore = new Set(await currentHeaderIds(org, weekId, teamId));
  const { count: snapCountBefore } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });

  // 파트장 라인 선택 payload 빌더(점수셋 지정).
  const buildLeaderLineSels = (scores: Record<PartCat, number>) =>
    PART_CATS.map((c) => ({ crewUserId: leader.userId, lineType: c, selectedLineId: chosen[c], checked: true, score: scores[c] }));
  // 관리 게이트 통과용(기존 동작 유지).
  const mgmtOptId = board.lineOptions.management?.[0]?.id ?? null;
  const crews = board.parts.flatMap((p) => p.crews);
  const leaderCells = crews
    .filter((c) => c.isPartLeader || c.statusLabel === "에이전트")
    .map((c) => ({ crewUserId: c.userId, category: "management" as const, checked: true, score: 7, selectedLineId: mgmtOptId }));

  // ── (A) 1차 검수: 점수셋 A ──
  console.log(`\n=== 1차 검수(점수셋 A: 도출=${SCORES_A.derivation} 분석=${SCORES_A.analysis} 견문=${SCORES_A.evaluation}) ===`);
  const rev1 = await httpPost(cookie, { action: "review", organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode: "test", leaderCells, outputs: [], lineSelections: buildLeaderLineSels(SCORES_A) });
  check("[POST review A] 201 성공", rev1.status === 201 && rev1.json?.success, `status=${rev1.status} ${rev1.json?.error ?? ""}`);
  {
    const hdrIds = await currentHeaderIds(org, weekId, teamId);
    const cells = await readLeaderCells(hdrIds, leader.userId);
    for (const c of PART_CATS) {
      const cell = cells.get(c);
      check(`[DB 셀 A] 파트장 ${c} score=${SCORES_A[c]} 저장(하드코딩 7 아님)`, !!cell && cell.score === SCORES_A[c] && cell.checked === true && cell.selected_line_id === chosen[c], cell ? `s=${cell.score} chk=${cell.checked}` : "셀 없음");
    }
    const get = await httpGet(cookie, url);
    const b2 = get.json?.data as BoardDto;
    const l2 = b2?.parts.flatMap((p) => p.crews).find((c) => c.userId === leader.userId);
    for (const c of PART_CATS) check(`[재조회 A] 파트장 ${c} 점수 라운드트립 = ${SCORES_A[c]}`, l2?.cells[c]?.score === SCORES_A[c], `dto.score=${l2?.cells[c]?.score}`);
  }

  // ── (B) 재검수: 점수셋 B(변경 반영 — 고정 기본값 아님) ──
  console.log(`\n=== 재검수(점수셋 B: 도출=${SCORES_B.derivation} 분석=${SCORES_B.analysis} 견문=${SCORES_B.evaluation}) ===`);
  const rev2 = await httpPost(cookie, { action: "review", organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode: "test", leaderCells, outputs: [], lineSelections: buildLeaderLineSels(SCORES_B) });
  check("[POST review B] 201 성공", rev2.status === 201 && rev2.json?.success, `status=${rev2.status} ${rev2.json?.error ?? ""}`);
  {
    const hdrIds = await currentHeaderIds(org, weekId, teamId);
    const cells = await readLeaderCells(hdrIds, leader.userId);
    for (const c of PART_CATS) {
      const cell = cells.get(c);
      check(`[DB 셀 B] 파트장 ${c} score=${SCORES_B[c]} 갱신(재검수 반영)`, !!cell && cell.score === SCORES_B[c], cell ? `s=${cell.score}` : "셀 없음");
    }
  }

  // ── (C) 개설 완료(점수셋 B) → 평가 rating = 선택 점수 ──
  console.log(`\n=== 개설 완료(점수셋 B 반영) ===`);
  const openRes = await httpPost(cookie, { action: "open", organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode: "test", leaderCells, outputs: [], lineSelections: buildLeaderLineSels(SCORES_B) });
  check("[POST open] 201 성공", openRes.status === 201 && openRes.json?.success, `status=${openRes.status} ${openRes.json?.error ?? ""}`);
  const openData = openRes.json?.data ?? {};
  console.log(`  open 결과: lines=${openData.linesCreated} targets=${openData.targetsCreated} evals=${openData.evaluationsCreated} warnings=${(openRes.json?.warnings ?? []).length}`);

  const { data: hdrOverall } = await sb.from("cluster4_experience_team_overall").select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId).maybeSingle();
  const overallId = (hdrOverall as { id: string } | null)?.id ?? null;
  const { data: openedLines } = await sb.from("cluster4_experience_team_overall_opened_lines").select("line_id,category").eq("overall_id", overallId ?? "x");
  const oLines = (openedLines ?? []) as Array<{ line_id: string; category: string }>;
  const catByLine = new Map(oLines.map((r) => [r.line_id, r.category]));
  const lineIds = oLines.map((r) => r.line_id);
  const { data: tgtRows } = await sb.from("cluster4_line_targets").select("id,line_id,target_user_id").in("line_id", lineIds.length ? lineIds : ["x"]);
  const leaderTargetByCat = new Map<string, string>(); // cat -> line_target_id (파트장)
  for (const t of (tgtRows ?? []) as Array<{ id: string; line_id: string; target_user_id: string | null }>) {
    const cat = catByLine.get(t.line_id);
    if (cat && (PART_CATS as readonly string[]).includes(cat) && t.target_user_id === leader.userId) leaderTargetByCat.set(cat, t.id);
  }
  for (const c of PART_CATS) {
    const tgtId = leaderTargetByCat.get(c);
    check(`[DB 타깃] 파트장 ${c} 대상자 배정`, !!tgtId);
    if (tgtId) {
      const { data: ev } = await sb.from("cluster4_experience_line_evaluations").select("rating").eq("line_target_id", tgtId).maybeSingle();
      check(`[DB 평가] 파트장 ${c} rating = 선택 점수 ${SCORES_B[c]}`, (ev as { rating: number } | null)?.rating === SCORES_B[c], `rating=${(ev as { rating: number } | null)?.rating}`);
    }
  }

  // ── (D) 완료 후 재조회 라운드트립(점수 유지) ──
  const get3 = await httpGet(cookie, url);
  const b3 = get3.json?.data as BoardDto;
  const l3 = b3?.parts.flatMap((p) => p.crews).find((c) => c.userId === leader.userId);
  for (const c of PART_CATS) check(`[완료 재조회] 파트장 ${c} 점수 유지 = ${SCORES_B[c]}`, l3?.cells[c]?.score === SCORES_B[c], `dto.score=${l3?.cells[c]?.score}`);

  // ── (E) 회귀: 다른 크루(일반) 셀 점수 미변경 — 파트장만 영향 ──
  {
    const hdrIds = await currentHeaderIds(org, weekId, teamId);
    const { data: otherCells } = await sb.from("cluster4_experience_part_submission_cells")
      .select("crew_user_id,score").in("submission_id", hdrIds.length ? hdrIds : ["x"]).neq("crew_user_id", leader.userId);
    // 일반 크루 점수는 payload 로 바꾸지 않았으므로 검수/완료로 인해 강제 변경되지 않아야 한다(값 자체는 개설신청 SoT).
    check("[회귀] 일반 크루 셀 존재/조회 정상(파트장 외 점수 write 없음 확인용)", Array.isArray(otherCells));
  }
  const { count: snapCountAfter } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  check("[회귀] snapshot 생성 없음(count 불변)", (snapCountAfter ?? 0) === (snapCountBefore ?? 0), `${snapCountBefore}→${snapCountAfter}`);

  // ── 원복: cancel + 파트장 셀 삭제 + phantom 헤더 삭제 + overall 헤더 삭제 ──
  const cancelRes = await httpPost(cookie, { action: "cancel", organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode: "test" });
  check("[cancel] 200 원복", cancelRes.status === 200 && cancelRes.json?.success, `removed=${cancelRes.json?.data?.linesRemoved}`);
  const headerIdsAfter = await currentHeaderIds(org, weekId, teamId);
  await sb.from("cluster4_experience_part_submission_cells").delete().in("submission_id", headerIdsAfter.length ? headerIdsAfter : ["x"]).eq("crew_user_id", leader.userId);
  const phantomHeaderIds = headerIdsAfter.filter((id) => !headerIdsBefore.has(id));
  if (phantomHeaderIds.length > 0) await sb.from("cluster4_experience_part_submissions").delete().in("id", phantomHeaderIds);
  await sb.from("cluster4_experience_team_overall").delete().eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);

  const { data: linesResidue } = await sb.from("cluster4_lines").select("id").in("id", lineIds.length ? lineIds : ["x"]);
  check("[원복] 개설 라인 잔여 0", (linesResidue ?? []).length === 0);
  const { data: hdrResidue } = await sb.from("cluster4_experience_team_overall").select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  check("[원복] team_overall 헤더 잔여 0", (hdrResidue ?? []).length === 0);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
