/**
 * verify-experience-partleader-zero-score-http.ts
 * 실무 경험 [팀 총괄] 개설 검수 — 파트장 평점 "0점" 지원 검증.
 *   요구(2026-07-24): 파트장 평점 드롭다운에 0점을 선택할 수 있고, 0점이 실제 평점 값 0 으로
 *   저장·조회되며, "미선택('-', checked=false)" 과 "실제 0점(checked=true, score=0)" 이 구분된다.
 *
 * 검증(실제 HTTP: route → data layer → DB):
 *   [A] 파트장 도출=0점(checked) → part_submission_cells 에 (checked=true, score=0) 저장(미체크로 붕괴 안 함).
 *   [B] 보드 재조회 DTO 라운드트립: 도출 score=0·checked=true (드롭다운이 "0" 표시).
 *   [C] 미선택 대조: 파트장 견문=미체크 → (checked=false) 저장·조회 → "0점" 과 서로 다른 값.
 *   [D] 개설 게이트 독립(snapshot 무영향): 0점 셀은 개설 완료 대상자 미생성(score<=0 skip),
 *       비-0 대조 셀(분석=3점)은 대상자·평가(rating=3) 생성.
 *   [E] 일반/test 모드·여러 org 동일 로직·동일 DTO(파트장 셀 키 1종).
 *
 * 대상: 클린-슬레이트(overall 헤더 없음)+canOpen+신청완료+파트장+옵션 (T)팀. 실행 후 완전 원복.
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-partleader-zero-score-http.ts
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

type Mode = "operating" | "test";
type PartCat = "derivation" | "analysis" | "evaluation";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
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

function teamUrl(org: string, weekId: string, teamId: string, teamName: string, mode: Mode) {
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
async function currentHeaderIds(org: string, weekId: string, teamId: string): Promise<string[]> {
  const { data } = await sb.from("cluster4_experience_part_submissions").select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  return ((data ?? []) as Array<{ id: string }>).map((h) => h.id);
}
async function readLeaderCells(headerIds: string[], leaderUserId: string) {
  const { data } = await sb.from("cluster4_experience_part_submission_cells")
    .select("line_type,selected_line_id,checked,score")
    .in("submission_id", headerIds.length ? headerIds : ["x"]).eq("crew_user_id", leaderUserId);
  return new Map(((data ?? []) as Array<{ line_type: string; selected_line_id: string | null; checked: boolean; score: number }>).map((c) => [c.line_type, c]));
}

type Target = { org: string; teamId: string; teamName: string; weekId: string; weekLabel: string; board: BoardDto; leader: { userId: string; displayName: string } };

async function discover(mode: Mode, usedOrgs: Set<string>, nonRestWeeks: Array<{ id: string; label: string }>): Promise<Target | null> {
  const { data: teams } = await sb.from("cluster4_teams").select("id,team_name,organization_slug").ilike("team_name", "%(T)%");
  for (const t of (teams ?? []) as Array<{ id: string; team_name: string; organization_slug: string }>) {
    if (usedOrgs.has(t.organization_slug)) continue; // org 다양성 우선.
    for (const w of nonRestWeeks) {
      const { data: hdr } = await sb.from("cluster4_experience_team_overall").select("id")
        .eq("organization_slug", t.organization_slug).eq("week_id", w.id).eq("team_id", t.id).maybeSingle();
      if (hdr) continue;
      const board = await getTeamOverallBoard(t.organization_slug, w.id, t.id, t.team_name, mode);
      if (!board.canOpen || !board.application.allPartsApplied) continue;
      const leader = board.parts.flatMap((p) => p.crews).find((c) => c.isPartLeader);
      const hasOptions = (["derivation", "analysis", "evaluation"] as PartCat[]).every((c) => (board.lineOptions[c]?.length ?? 0) > 0);
      if (leader && hasOptions) {
        return { org: t.organization_slug, teamId: t.id, teamName: t.team_name, weekId: w.id, weekLabel: w.label, board, leader };
      }
    }
  }
  return null;
}

const leaderCellDtoShapes = new Set<string>();

async function runTarget(cookie: string, mode: Mode, tgt: Target) {
  const { org, teamId, teamName, weekId, weekLabel, board, leader } = tgt;
  const url = teamUrl(org, weekId, teamId, teamName, mode);
  console.log(`\n=== [${mode}] ${org} / ${teamName} / ${weekLabel} · 파트장 ${leader.displayName} ===`);

  const derivLine = board.lineOptions.derivation[0].id;
  const analysisLine = board.lineOptions.analysis[0].id;
  const mgmtOptId = board.lineOptions.management?.[0]?.id ?? null;
  const crews = board.parts.flatMap((p) => p.crews);
  const leaderCells = crews
    .filter((c) => c.isPartLeader || c.statusLabel === "에이전트")
    .map((c) => ({ crewUserId: c.userId, category: "management" as const, checked: true, score: 7, selectedLineId: mgmtOptId }));

  // 실제 UI(buildPayload)는 전 크루의 도출/분석/견문 선택을 보낸다 — 검수 게이트는 **모든 파트장**의
  //   (checked&&score>=1) 셀에 라인을 요구한다. 대상 파트장 외 다른 파트장은 전부 미체크로 보내 게이트를
  //   통과시키고(라인 불필요), 대상 파트장만 0점/3점/미선택 시나리오를 적용한다.
  const allLeaders = crews.filter((c) => c.isPartLeader);
  const lineSelections = allLeaders.flatMap((c) => {
    if (c.userId !== leader.userId) {
      return (["derivation", "analysis", "evaluation"] as PartCat[]).map((lt) => ({
        crewUserId: c.userId, lineType: lt, selectedLineId: null, checked: false, score: 0,
      }));
    }
    // 대상 파트장: 도출=0점(checked, 라인 O) · 분석=3점(checked, 라인 O, 비-0 대조) · 견문=미체크(미선택 대조).
    return [
      { crewUserId: leader.userId, lineType: "derivation" as PartCat, selectedLineId: derivLine, checked: true, score: 0 },
      { crewUserId: leader.userId, lineType: "analysis" as PartCat, selectedLineId: analysisLine, checked: true, score: 3 },
      { crewUserId: leader.userId, lineType: "evaluation" as PartCat, selectedLineId: null, checked: false, score: 0 },
    ];
  });

  // 아웃풋 게이트 통과 — 활성 전 카테고리에 링크+이미지 필수(extension 은 활성 시에만).
  const outputs = (["derivation", "analysis", "evaluation", "management", "extension"] as const).map((cat) => ({
    category: cat, link: `https://example.com/${cat}`, description: cat,
    imageUrl: `https://example.com/${cat}.png`, imageDescription: cat,
  }));

  const headerIdsBefore = new Set(await currentHeaderIds(org, weekId, teamId));
  const { count: snapBefore } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });

  // ── 검수 ──
  const rev = await httpPost(cookie, { action: "review", organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode, leaderCells, outputs, lineSelections });
  check("[검수] 201 성공", rev.status === 201 && rev.json?.success, `status=${rev.status} ${rev.json?.error ?? ""}`);

  const hdrIds = await currentHeaderIds(org, weekId, teamId);
  const cells = await readLeaderCells(hdrIds, leader.userId);
  const dCell = cells.get("derivation");
  const aCell = cells.get("analysis");
  const eCell = cells.get("evaluation");

  // [A] 0점이 (checked=true, score=0) 로 저장(미체크로 붕괴 안 함).
  check("[A] 도출 0점 DB 저장: checked=true, score=0", !!dCell && dCell.checked === true && dCell.score === 0, dCell ? `checked=${dCell.checked} score=${dCell.score}` : "셀 없음");
  check("[A] 도출 0점 라인명 함께 저장", dCell?.selected_line_id === derivLine, `line=${dCell?.selected_line_id}`);
  // [C] 미선택(견문 미체크)은 checked=false 로 저장 → 0점과 구분.
  check("[C] 견문 미선택 DB 저장: checked=false", !!eCell && eCell.checked === false, eCell ? `checked=${eCell.checked} score=${eCell.score}` : "셀 없음(=미저장)");
  check("[C] '0점'(checked=true)와 '미선택'(checked=false)은 서로 다른 값", dCell?.checked === true && eCell?.checked === false);
  // 대조: 분석 3점.
  check("[대조] 분석 3점 저장: checked=true, score=3", !!aCell && aCell.checked === true && aCell.score === 3, aCell ? `checked=${aCell.checked} score=${aCell.score}` : "셀 없음");

  // [B] 보드 재조회 라운드트립.
  const get = await httpGet(cookie, url);
  const b2 = get.json?.data as BoardDto;
  const l2 = b2?.parts.flatMap((p) => p.crews).find((c) => c.userId === leader.userId);
  const dDto = l2?.cells.derivation;
  const eDto = l2?.cells.evaluation;
  if (dDto) leaderCellDtoShapes.add(Object.keys(dDto).sort().join(","));
  check("[B] 재조회 도출 0점: score=0, checked=true (드롭다운 '0' 표시)", dDto?.score === 0 && dDto?.checked === true, `dto.score=${dDto?.score} checked=${dDto?.checked}`);
  check("[B] 재조회 견문 미선택: checked=false ('-' 표시)", eDto?.checked === false, `dto.checked=${eDto?.checked}`);

  // ── [D] 개설 완료 → 개설 게이트 독립(0점 셀 대상자 미생성, 분석 3점 대상자·평가 생성) ──
  const openRes = await httpPost(cookie, { action: "open", organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode, leaderCells, outputs, lineSelections });
  check("[개설] 201 성공", openRes.status === 201 && openRes.json?.success, `status=${openRes.status} ${openRes.json?.error ?? ""}`);

  const { data: hdrOverall } = await sb.from("cluster4_experience_team_overall").select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId).maybeSingle();
  const overallId = (hdrOverall as { id: string } | null)?.id ?? null;
  const { data: openedLines } = await sb.from("cluster4_experience_team_overall_opened_lines").select("line_id,category").eq("overall_id", overallId ?? "x");
  const oLines = (openedLines ?? []) as Array<{ line_id: string; category: string }>;
  const catByLine = new Map(oLines.map((r) => [r.line_id, r.category]));
  const lineIds = oLines.map((r) => r.line_id);
  const { data: tgtRows } = await sb.from("cluster4_line_targets").select("id,line_id,target_user_id").in("line_id", lineIds.length ? lineIds : ["x"]);
  const leaderTargetByCat = new Map<string, string>();
  for (const t of (tgtRows ?? []) as Array<{ id: string; line_id: string; target_user_id: string | null }>) {
    const cat = catByLine.get(t.line_id);
    if (cat && t.target_user_id === leader.userId) leaderTargetByCat.set(cat, t.id);
  }
  check("[D] 도출 0점 → 개설 대상자 미생성(개설 게이트 score<=0 skip)", !leaderTargetByCat.has("derivation"));
  const aTgt = leaderTargetByCat.get("analysis");
  check("[D] 분석 3점 → 개설 대상자 생성", !!aTgt);
  if (aTgt) {
    const { data: ev } = await sb.from("cluster4_experience_line_evaluations").select("rating").eq("line_target_id", aTgt).maybeSingle();
    check("[D] 분석 3점 → 평가 rating=3", (ev as { rating: number } | null)?.rating === 3, `rating=${(ev as { rating: number } | null)?.rating}`);
  }
  const { count: snapAfter } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  check("[D] snapshot 생성 없음(count 불변)", (snapAfter ?? 0) === (snapBefore ?? 0), `${snapBefore}→${snapAfter}`);

  // ── 원복: cancel + 파트장 셀 삭제 + phantom 헤더 삭제 + overall 헤더 삭제 ──
  const cancelRes = await httpPost(cookie, { action: "cancel", organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode });
  check("[원복] cancel 200", cancelRes.status === 200 && cancelRes.json?.success);
  const headerIdsAfter = await currentHeaderIds(org, weekId, teamId);
  await sb.from("cluster4_experience_part_submission_cells").delete().in("submission_id", headerIdsAfter.length ? headerIdsAfter : ["x"]).eq("crew_user_id", leader.userId);
  const phantomHeaderIds = headerIdsAfter.filter((id) => !headerIdsBefore.has(id));
  if (phantomHeaderIds.length > 0) await sb.from("cluster4_experience_part_submissions").delete().in("id", phantomHeaderIds);
  await sb.from("cluster4_experience_team_overall").delete().eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  const { data: linesResidue } = await sb.from("cluster4_lines").select("id").in("id", lineIds.length ? lineIds : ["x"]);
  check("[원복] 개설 라인 잔여 0", (linesResidue ?? []).length === 0);
  const { data: hdrResidue } = await sb.from("cluster4_experience_team_overall").select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  check("[원복] team_overall 헤더 잔여 0", (hdrResidue ?? []).length === 0);
}

async function main() {
  const cookie = await adminCookieHeader();
  const { data: recentWeeks } = await sb.from("weeks").select("id,week_number,start_date,season_key")
    .not("week_number", "is", null).order("start_date", { ascending: false }).limit(20);
  const nonRestWeeks: Array<{ id: string; label: string }> = [];
  for (const w of (recentWeeks ?? []) as Array<{ id: string; week_number: number; start_date: string; season_key: string | null }>) {
    const { rest } = await isWeekOfficialRestById(w.id);
    if (!rest) nonRestWeeks.push({ id: w.id, label: `${w.season_key ?? "?"} W${w.week_number} (${w.start_date})` });
  }

  let ran = 0;
  for (const mode of ["test", "operating"] as Mode[]) {
    const usedOrgs = new Set<string>();
    // 모드별로 서로 다른 org 최대 2개 커버(가능한 만큼).
    for (let i = 0; i < 2; i++) {
      const tgt = await discover(mode, usedOrgs, nonRestWeeks);
      if (!tgt) break;
      usedOrgs.add(tgt.org);
      await runTarget(cookie, mode, tgt);
      ran++;
    }
  }
  check("최소 1개 대상 실행됨", ran > 0, `실행 ${ran}건`);

  console.log("\n=== DTO 동일성(모드/org 무관) ===");
  check("파트장 셀 DTO 키 1종", leaderCellDtoShapes.size === 1, [...leaderCellDtoShapes].join(" / "));

  console.log(`\n결과: ${pass} pass / ${fail} fail (대상 ${ran}건)`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
