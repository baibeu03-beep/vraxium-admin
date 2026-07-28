/**
 * verify-experience-partleader-score-required-http.ts
 * 실무 경험 [팀 총괄] 개설 검수 — 파트장 평점 "0~10 필수" 정책 검증(2026-07-28).
 *   요구: 평점 드롭다운의 '-'(미선택) 옵션 폐지 → 0~10 정수 11개만 선택 가능하고,
 *   null · undefined(키 누락) · "" · "-" · 범위 밖 · 소수 · 숫자 문자열은 **저장되지 않는다**.
 *
 * 검증(실제 HTTP: route → data layer → DB. 프론트 우회 = 서버 단독 방어선 확인):
 *   [A] 0~10 전 값 저장 성공 — 11개 각각 review 201 + DB score 일치(클램프/대체 없음).
 *   [B] 조회 라운드트립 — 저장된 0~10 이 보드 DTO 로 그대로 돌아온다(드롭다운 표시값).
 *   [C] 무효값 거부 — null · "" · "-" · -1 · 11 · 3.5 · "7" · true · 키 누락 전부 4xx,
 *       그리고 **DB 값 불변**(부분 저장 없음 = 가드가 write 이전에 동작).
 *   [D] 관리/확장(leaderCells) 평점도 동일 규칙(0~10 정수만) — 무효값 400.
 *   [E] 개설(open)도 동일 차단 — 평점 누락 payload 로는 개설 불가(422), 라인/대상자 미생성.
 *   [F] 정상 경로 무변경 — 유효 payload 로 개설 완료 201(라인·대상자·평가 생성) + snapshot 무영향.
 *   [G] 일반(operating)/mode=test 동일 DTO·동일 검증(오류 문구·셀 DTO 키 1종).
 *
 * 대상: 클린-슬레이트(overall 헤더 없음)+canOpen+신청완료+파트장+옵션 (T)팀. 실행 후 완전 원복.
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-partleader-score-required-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import { isWeekOfficialRestById } from "@/lib/cluster4OfficialRestWeek";
import {
  OVERALL_SCORE_OPTIONS,
  type ExperienceTeamOverallBoard as BoardDto,
} from "@/lib/experienceTeamOverallTypes";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

type Mode = "operating" | "test";
type PartCat = "derivation" | "analysis" | "evaluation";
const PART_CATS: PartCat[] = ["derivation", "analysis", "evaluation"];

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
  const { data } = await sb.from("cluster4_experience_part_submissions").select("id")
    .eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  return ((data ?? []) as Array<{ id: string }>).map((h) => h.id);
}
async function readLeaderCells(headerIds: string[], leaderUserId: string) {
  const { data } = await sb.from("cluster4_experience_part_submission_cells")
    .select("line_type,selected_line_id,checked,score")
    .in("submission_id", headerIds.length ? headerIds : ["x"]).eq("crew_user_id", leaderUserId);
  return new Map(((data ?? []) as Array<{ line_type: string; selected_line_id: string | null; checked: boolean; score: number }>).map((c) => [c.line_type, c]));
}
/** 대상 파트장 도출 셀의 현재 저장 점수(없으면 null). */
async function readTargetScore(org: string, weekId: string, teamId: string, leaderUserId: string): Promise<number | null> {
  const cells = await readLeaderCells(await currentHeaderIds(org, weekId, teamId), leaderUserId);
  return cells.get("derivation")?.score ?? null;
}

type Target = { org: string; teamId: string; teamName: string; weekId: string; weekLabel: string; board: BoardDto; leader: { userId: string; displayName: string } };

async function discover(mode: Mode, usedOrgs: Set<string>, nonRestWeeks: Array<{ id: string; label: string }>): Promise<Target | null> {
  const { data: teams } = await sb.from("cluster4_teams").select("id,team_name,organization_slug").ilike("team_name", "%(T)%");
  for (const t of (teams ?? []) as Array<{ id: string; team_name: string; organization_slug: string }>) {
    if (usedOrgs.has(t.organization_slug)) continue; // org 다양성 우선.
    for (const w of nonRestWeeks) {
      const { data: hdr } = await sb.from("cluster4_experience_team_overall").select("id")
        .eq("organization_slug", t.organization_slug).eq("week_id", w.id).eq("team_id", t.id).maybeSingle();
      if (hdr) continue; // 클린-슬레이트 아님.
      const board = await getTeamOverallBoard(t.organization_slug, w.id, t.id, t.team_name, mode);
      if (!board.canOpen || !board.application.allPartsApplied) continue;
      const leader = board.parts.flatMap((p) => p.crews).find((c) => c.isPartLeader);
      const hasOptions = PART_CATS.every((c) => (board.lineOptions[c]?.length ?? 0) > 0);
      if (leader && hasOptions) {
        return { org: t.organization_slug, teamId: t.id, teamName: t.team_name, weekId: w.id, weekLabel: w.label, board, leader };
      }
    }
  }
  return null;
}

// 무효 평점 케이스 — 정책상 전부 거부돼야 하는 값. `MISSING` 은 키 자체를 빼는 케이스.
const MISSING = Symbol("missing");
const INVALID_SCORES: Array<{ label: string; value: unknown | typeof MISSING }> = [
  { label: "null", value: null },
  { label: '빈 문자열("")', value: "" },
  { label: '"-"(구 미선택 옵션)', value: "-" },
  { label: "-1(범위 밖)", value: -1 },
  { label: "11(범위 밖)", value: 11 },
  { label: "3.5(소수)", value: 3.5 },
  { label: '"7"(숫자 문자열)', value: "7" },
  { label: "true(불리언)", value: true },
  { label: "키 누락(undefined)", value: MISSING },
];

const errorMessages = new Set<string>();
const leaderCellDtoShapes = new Set<string>();

async function runTarget(cookie: string, mode: Mode, tgt: Target) {
  const { org, teamId, teamName, weekId, weekLabel, board, leader } = tgt;
  const url = teamUrl(org, weekId, teamId, teamName, mode);
  console.log(`\n=== [${mode}] ${org} / ${teamName} / ${weekLabel} · 파트장 ${leader.displayName} ===`);

  const lineByCat: Record<PartCat, string> = {
    derivation: board.lineOptions.derivation[0].id,
    analysis: board.lineOptions.analysis[0].id,
    evaluation: board.lineOptions.evaluation[0].id,
  };
  const mgmtOptId = board.lineOptions.management?.[0]?.id ?? null;
  const crews = board.parts.flatMap((p) => p.crews);
  const allLeaders = crews.filter((c) => c.isPartLeader);

  // 관리 셀(파트장/에이전트 전용) — 기본 유효 payload.
  const leaderCells = (score: unknown = 7) =>
    crews
      .filter((c) => c.isPartLeader || c.statusLabel === "에이전트")
      .map((c) => ({ crewUserId: c.userId, category: "management" as const, checked: true, score, selectedLineId: mgmtOptId }));

  // 라인 선택 payload — 대상 파트장 도출만 점수를 갈아끼우고 나머지는 항상 유효값으로 고정한다.
  //   대상 외 파트장은 미체크(0점)로 보내 라인 필수 게이트를 통과시킨다(기존 검증 스크립트와 동일 방식).
  const buildLineSels = (derivScore: unknown | typeof MISSING) =>
    allLeaders.flatMap((c) => {
      if (c.userId !== leader.userId) {
        return PART_CATS.map((lt) => ({ crewUserId: c.userId, lineType: lt, selectedLineId: null, checked: false, score: 0 }));
      }
      return PART_CATS.map((lt) => {
        const base: Record<string, unknown> = {
          crewUserId: leader.userId, lineType: lt, selectedLineId: lineByCat[lt], checked: true,
        };
        if (lt !== "derivation") { base.score = 7; return base; }
        if (derivScore !== MISSING) base.score = derivScore; // MISSING = score 키 자체를 넣지 않는다.
        return base;
      });
    });

  const outputs = (["derivation", "analysis", "evaluation", "management", "extension"] as const).map((cat) => ({
    category: cat, link: `https://example.com/${cat}`, description: cat,
    imageUrl: `https://example.com/${cat}.png`, imageDescription: cat,
  }));

  const bodyBase = { organization: org, week_id: weekId, team_id: teamId, team_name: teamName, mode, outputs };
  const headerIdsBefore = new Set(await currentHeaderIds(org, weekId, teamId));
  const { count: snapBefore } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });

  // ── [A] 0~10 전 값 저장 성공 + DB 일치 ──
  console.log("  ── [A] 0~10 저장 성공 ──");
  let okAll = true, dbAll = true;
  for (const v of OVERALL_SCORE_OPTIONS) {
    const res = await httpPost(cookie, { ...bodyBase, action: "review", leaderCells: leaderCells(), lineSelections: buildLineSels(v) });
    const stored = await readTargetScore(org, weekId, teamId, leader.userId);
    if (!(res.status === 201 && res.json?.success)) { okAll = false; console.log(`     ✗ ${v}점 저장 실패 status=${res.status} ${res.json?.error ?? ""}`); }
    if (stored !== v) { dbAll = false; console.log(`     ✗ ${v}점 DB 불일치 stored=${stored}`); }
  }
  check("[A] 0~10 전 11개 값 review 201 성공", okAll);
  check("[A] 0~10 전 11개 값 DB score 그대로 저장(클램프/대체 없음)", dbAll);

  // ── [B] 조회 라운드트립 — 마지막 저장값(10)이 DTO 로 그대로 ──
  const get = await httpGet(cookie, url);
  const b2 = get.json?.data as BoardDto;
  const dto = b2?.parts.flatMap((p) => p.crews).find((c) => c.userId === leader.userId)?.cells.derivation;
  if (dto) leaderCellDtoShapes.add(Object.keys(dto).sort().join(","));
  check("[B] 재조회 DTO score=10, checked=true (드롭다운 '10' 표시)", dto?.score === 10 && dto?.checked === true, `dto.score=${dto?.score} checked=${dto?.checked}`);

  // ── [C] 무효값 거부 + DB 불변 ──
  console.log("  ── [C] 무효값 거부(파트장 평점) ──");
  for (const c of INVALID_SCORES) {
    const before = await readTargetScore(org, weekId, teamId, leader.userId);
    const res = await httpPost(cookie, { ...bodyBase, action: "review", leaderCells: leaderCells(), lineSelections: buildLineSels(c.value) });
    const after = await readTargetScore(org, weekId, teamId, leader.userId);
    const rejected = (res.status === 400 || res.status === 422) && res.json?.success !== true;
    check(`[C] ${c.label} → 저장 거부(4xx)`, rejected, `status=${res.status} ${res.json?.error ?? ""}`);
    check(`[C] ${c.label} → DB 값 불변(부분 저장 없음)`, before === after, `${before} → ${after}`);
    if (typeof res.json?.error === "string") errorMessages.add(res.json.error);
  }

  // ── [D] 관리(leaderCells) 평점도 동일 규칙 ──
  console.log("  ── [D] 무효값 거부(관리/확장 평점) ──");
  for (const c of INVALID_SCORES.filter((x) => x.value !== MISSING)) {
    const res = await httpPost(cookie, { ...bodyBase, action: "review", leaderCells: leaderCells(c.value), lineSelections: buildLineSels(7) });
    const rejected = (res.status === 400 || res.status === 422) && res.json?.success !== true;
    check(`[D] 관리 평점 ${c.label} → 저장 거부(4xx)`, rejected, `status=${res.status} ${res.json?.error ?? ""}`);
    if (typeof res.json?.error === "string") errorMessages.add(res.json.error);
  }

  // ── [E] 개설(open)도 동일 차단 ──
  const openBad = await httpPost(cookie, { ...bodyBase, action: "open", leaderCells: leaderCells(), lineSelections: buildLineSels(MISSING) });
  check("[E] 평점 누락 payload → 개설 완료 거부(4xx)", (openBad.status === 400 || openBad.status === 422) && openBad.json?.success !== true, `status=${openBad.status} ${openBad.json?.error ?? ""}`);
  const { data: hdrAfterBadOpen } = await sb.from("cluster4_experience_team_overall").select("status")
    .eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId).maybeSingle();
  check("[E] 거부된 개설로 상태가 opened 로 바뀌지 않음", (hdrAfterBadOpen as { status: string } | null)?.status !== "opened", `status=${(hdrAfterBadOpen as { status: string } | null)?.status}`);

  // ── [F] 정상 경로 무변경 — 유효 payload 개설 완료 ──
  const openOk = await httpPost(cookie, { ...bodyBase, action: "open", leaderCells: leaderCells(), lineSelections: buildLineSels(8) });
  check("[F] 유효 평점(8점) → 개설 완료 201", openOk.status === 201 && openOk.json?.success, `status=${openOk.status} ${openOk.json?.error ?? ""}`);
  const { data: hdrOverall } = await sb.from("cluster4_experience_team_overall").select("id")
    .eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId).maybeSingle();
  const overallId = (hdrOverall as { id: string } | null)?.id ?? null;
  const { data: openedLines } = await sb.from("cluster4_experience_team_overall_opened_lines").select("line_id,category").eq("overall_id", overallId ?? "x");
  const oLines = (openedLines ?? []) as Array<{ line_id: string; category: string }>;
  const catByLine = new Map(oLines.map((r) => [r.line_id, r.category]));
  const lineIds = oLines.map((r) => r.line_id);
  const { data: tgtRows } = await sb.from("cluster4_line_targets").select("id,line_id,target_user_id").in("line_id", lineIds.length ? lineIds : ["x"]);
  const derivTargetId = ((tgtRows ?? []) as Array<{ id: string; line_id: string; target_user_id: string | null }>)
    .find((t) => t.target_user_id === leader.userId && catByLine.get(t.line_id) === "derivation")?.id ?? null;
  check("[F] 도출 8점 → 개설 대상자 생성", !!derivTargetId);
  if (derivTargetId) {
    const { data: ev } = await sb.from("cluster4_experience_line_evaluations").select("rating").eq("line_target_id", derivTargetId).maybeSingle();
    check("[F] 도출 8점 → 평가 rating=8 (평점 그대로 반영)", (ev as { rating: number } | null)?.rating === 8, `rating=${(ev as { rating: number } | null)?.rating}`);
  }
  const { count: snapAfter } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  check("[F] snapshot 생성 없음(count 불변)", (snapAfter ?? 0) === (snapBefore ?? 0), `${snapBefore}→${snapAfter}`);

  // ── 원복 ──
  const cancelRes = await httpPost(cookie, { ...bodyBase, action: "cancel", leaderCells: [], lineSelections: [] });
  check("[원복] cancel 200", cancelRes.status === 200 && cancelRes.json?.success, `status=${cancelRes.status} ${cancelRes.json?.error ?? ""}`);
  const headerIdsAfter = await currentHeaderIds(org, weekId, teamId);
  await sb.from("cluster4_experience_part_submission_cells")
    .delete().in("submission_id", headerIdsAfter.length ? headerIdsAfter : ["x"]).eq("crew_user_id", leader.userId);
  const phantomHeaderIds = headerIdsAfter.filter((id) => !headerIdsBefore.has(id));
  if (phantomHeaderIds.length > 0) await sb.from("cluster4_experience_part_submissions").delete().in("id", phantomHeaderIds);
  await sb.from("cluster4_experience_team_overall").delete().eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  const { data: linesResidue } = await sb.from("cluster4_lines").select("id").in("id", lineIds.length ? lineIds : ["x"]);
  check("[원복] 개설 라인 잔여 0", (linesResidue ?? []).length === 0);
  const { data: hdrResidue } = await sb.from("cluster4_experience_team_overall").select("id")
    .eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
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
    const tgt = await discover(mode, usedOrgs, nonRestWeeks);
    if (!tgt) { console.log(`\n[${mode}] 대상 없음 — 스킵`); continue; }
    usedOrgs.add(tgt.org);
    await runTarget(cookie, mode, tgt);
    ran++;
  }
  check("최소 1개 대상 실행됨", ran > 0, `실행 ${ran}건`);

  // ── [G] 모드 무관 동일 DTO/문구 ──
  console.log("\n=== [G] 일반/test 모드 동일성 ===");
  check("파트장 셀 DTO 키 1종", leaderCellDtoShapes.size <= 1, [...leaderCellDtoShapes].join(" / "));
  check("평점 거부 문구 1~2종(공용 SoT)", errorMessages.size > 0 && errorMessages.size <= 2, [...errorMessages].join(" / "));

  console.log(`\n결과: ${pass} pass / ${fail} fail (대상 ${ran}건)`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
