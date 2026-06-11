/**
 * verify-team-overall-http.ts
 * 실무 경험 [팀 총괄] — 신규 테이블 + direct==HTTP + 검수→복원 + 완료→고객반영 + 취소→원복 + snapshot 무영향.
 *   admin 세션 쿠키를 service-role generateLink→verifyOtp 로 발급해 실제 라우트를 호출한다.
 *
 * 사전: dev 서버(:3000) 기동 + 2026-06-11_experience_team_overall.sql 적용.
 * 실행: npx tsx --env-file=.env.local scripts/verify-team-overall-http.ts
 *
 * ⚠ 개설 완료로 생성한 고객 라인은 스크립트 말미에서 [개설 취소]로 반드시 원복하고,
 *    team_overall 헤더(검수 메타)까지 삭제해 잔여물을 남기지 않는다. 마지막에 잔여 라인 0 단언.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  getCurrentWeekStartMs,
  getOpenableWeekStartMs,
  describeWeekByStartMs,
} from "@/lib/cluster4WeekPolicy";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import type { OverallLeaderCellDto } from "@/lib/experienceTeamOverallTypes";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const ORG = "oranke";
const TEAM_ID = "f5c4fad2-0719-4d0d-958c-1988883a674a"; // 콘텐츠 (7 crews — 최소)
const TEAM_NAME = "콘텐츠";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ADMIN_EMAIL,
  });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({
    email: ADMIN_EMAIL,
    token: otp,
    type: "magiclink",
  });
  if (vErr) throw vErr;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session!.access_token,
    refresh_token: verifyData.session!.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function waitForServer(cookie: string, weekId: string) {
  const url = `${BASE}/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${TEAM_ID}&team_name=${encodeURIComponent(TEAM_NAME)}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url, { headers: { cookie } });
      if (res.status === 200) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("dev server not ready after 120s");
}

async function snapBaseline() {
  const { count } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true });
  const { data: latest } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("computed_at")
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    count: count ?? 0,
    latest: (latest as { computed_at?: string } | null)?.computed_at ?? null,
  };
}

async function httpGet(cookie: string, weekId: string) {
  const url = `${BASE}/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${TEAM_ID}&team_name=${encodeURIComponent(TEAM_NAME)}`;
  const res = await fetch(url, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

async function httpPost(cookie: string, body: unknown) {
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function deleteOverallHeader(weekId: string) {
  // CASCADE: cells/outputs/opened_lines 동반 삭제.
  await sb
    .from("cluster4_experience_team_overall")
    .delete()
    .eq("organization_slug", ORG)
    .eq("week_id", weekId)
    .eq("team_id", TEAM_ID);
}

async function main() {
  const cookie = await adminCookieHeader();

  // 개설 대상 주차.
  const todayIso = new Date().toISOString().slice(0, 10);
  void getCurrentWeekStartMs(todayIso);
  const openMs = getOpenableWeekStartMs(todayIso);
  const openInfo = openMs != null ? describeWeekByStartMs(openMs) : null;
  if (!openInfo) throw new Error("openable week 계산 실패");
  const { data: wk } = await sb
    .from("weeks")
    .select("id,start_date,end_date")
    .eq("iso_year", openInfo.isoYear)
    .eq("iso_week", openInfo.isoWeek)
    .maybeSingle();
  const weekId = (wk as { id: string } | null)?.id;
  if (!weekId) throw new Error("openable weeks.id 없음");
  console.log(
    `\n=== 대상: org=${ORG} team=${TEAM_NAME} week=${openInfo.year} ${openInfo.seasonName} W${openInfo.weekNumber} (${weekId}) rest=${openInfo.isOfficialRest} ===\n`,
  );

  console.log("[http] dev 서버 대기...");
  await waitForServer(cookie, weekId);
  console.log("[http] 서버 준비 완료\n");

  // 깨끗한 시작 — 잔여 header 제거.
  await deleteOverallHeader(weekId);

  // ── [1] 신규 4테이블 존재 ──
  for (const t of [
    "cluster4_experience_team_overall",
    "cluster4_experience_team_overall_cells",
    "cluster4_experience_team_overall_outputs",
    "cluster4_experience_team_overall_opened_lines",
  ]) {
    const { error } = await sb.from(t).select("id", { count: "exact", head: true });
    check(`[1] 테이블 존재: ${t}`, !error, error?.message ?? "");
  }

  // 등록 라인(카테고리별 후보) 진단.
  const { data: regs } = await sb
    .from("line_registrations")
    .select("line_type,line_code")
    .eq("hub", "experience")
    .eq("is_active", true)
    .not("bridged_master_id", "is", null)
    .or(`organization_slug.is.null,organization_slug.eq.${ORG}`);
  const byType: Record<string, string[]> = {};
  for (const r of (regs ?? []) as Array<{ line_type: string; line_code: string }>) {
    (byType[r.line_type] ??= []).push(r.line_code);
  }
  console.log("  등록 라인 후보:", JSON.stringify(byType), "\n");

  // ── [2] direct function 결과 ──
  const direct = await getTeamOverallBoard(ORG, weekId, TEAM_ID, TEAM_NAME);
  const crewCount = direct.parts.reduce((a, p) => a + p.crews.length, 0);
  check("[2] direct getTeamOverallBoard 반환", direct != null, `crews=${crewCount} parts=${direct.parts.length} status=${direct.status} ext=${direct.extensionActive}`);
  check("[2] 초기 status=none (미진행)", direct.status === "none");
  // 파트 미신청 주차이므로 도출/분석/견문 = 전 크루 기본 checked/7 (요구사항 #3).
  check("[5-board] 도출/분석/견문 전 크루 기본 checked/7 (파트 미신청)",
    direct.parts.every((p) => p.crews.every((c) =>
      (["derivation", "analysis", "evaluation"] as const).every((k) => c.cells[k].checked && c.cells[k].score === 7))),
  );
  // 파트장(role=part_leader) 미배제 확인 — 보드 크루 = 비테스트·active·실파트 멤버 전원(memberStatusLabel 채택군).
  // (oranke 비테스트 part_leader 가 0명이라 isPartLeader 플래그는 라이브로 못 띄우지만, 배제되지 않음을 카운트로 단언.)
  {
    const { data: profs } = await sb.from("user_profiles").select("user_id,role").eq("organization_slug", ORG);
    const ids = ((profs ?? []) as Array<{ user_id: string }>).map((p) => p.user_id);
    const { data: markers } = await sb.from("test_user_markers").select("user_id");
    const testSet = new Set(((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id));
    const roleById = new Map(((profs ?? []) as Array<{ user_id: string; role: string | null }>).map((p) => [p.user_id, p.role]));
    const { data: mems } = await sb.from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,membership_state,is_current").in("user_id", ids);
    const { memberStatusLabel } = await import("@/lib/adminMembersTypes");
    const cur = new Map<string, any>();
    for (const m of (mems ?? []) as any[]) { const e = cur.get(m.user_id); if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m); }
    let expected = 0;
    for (const [uid, m] of cur) {
      if (testSet.has(uid)) continue;
      if (m.team_name !== TEAM_NAME) continue;
      if (m.membership_state === "rest") continue;
      const part = (m.part_name ?? "").trim();
      if (!part || part === "일반") continue;
      const label = memberStatusLabel(roleById.get(uid) ?? null, m.membership_level);
      if (label === "일반" || label === "심화(에이전트)" || label === "심화(파트장)") expected++;
    }
    check("[5-board] part_leader 미배제 (보드 크루수 = 비테스트·active·실파트 멤버수)",
      crewCount === expected, `board=${crewCount} expected=${expected}`);
  }
  check("[5-board] 확장 비활성(확장 기간 테이블 미적용 → fail-closed)", direct.extensionActive === false);

  // ── [3] HTTP GET ──
  const get1 = await httpGet(cookie, weekId);
  check("[3] HTTP GET 200 (admin 세션)", get1.status === 200 && get1.json?.success, `status=${get1.status}`);

  // ── [4] direct == HTTP 일치 ──
  check("[4] direct == HTTP (보드 deep-equal)",
    JSON.stringify(direct) === JSON.stringify(get1.json.data),
    `len d=${JSON.stringify(direct).length} h=${JSON.stringify(get1.json.data).length}`,
  );

  // 첫 크루(unchecked 테스트 대상) 식별.
  const firstCrew = direct.parts[0]?.crews[0];
  if (!firstCrew) throw new Error("크루 없음 — 검증 불가");

  // snapshot 베이스라인.
  const snapBefore = await snapBaseline();

  // ── [6] 개설 검수 → 재접속 복원 ──
  // 모든 크루 management 셀 전송(첫 크루는 uncheck=score0 으로 변형) + derivation 아웃풋.
  const allCrews = direct.parts.flatMap((p) => p.crews);
  const leaderCells: OverallLeaderCellDto[] = allCrews.map((c) => ({
    crewUserId: c.userId,
    category: "management",
    checked: c.userId === firstCrew.userId ? false : true,
    score: c.userId === firstCrew.userId ? 0 : 7,
  }));
  const REVIEW_LINK = "https://verify.example.com/derivation";
  const REVIEW_DESC = "검증용 도출 아웃풋 설명";
  const reviewRes = await httpPost(cookie, {
    action: "review",
    organization: ORG,
    week_id: weekId,
    team_id: TEAM_ID,
    team_name: TEAM_NAME,
    leaderCells,
    outputs: [{ category: "derivation", link: REVIEW_LINK, description: REVIEW_DESC }],
  });
  check("[6] HTTP POST review → 201", reviewRes.status === 201 && reviewRes.json?.success, `status=${reviewRes.status} ${reviewRes.json?.error ?? ""}`);

  // 재접속(=새 GET)에서 복원 확인.
  const get2 = await httpGet(cookie, weekId);
  const board2 = get2.json.data;
  const restoredCrew = board2.parts.flatMap((p: any) => p.crews).find((c: any) => c.userId === firstCrew.userId);
  check("[6] 재접속 status=reviewed", board2.status === "reviewed");
  check("[6] 재접속: 변형한 management 셀 복원(checked=false,score=0)",
    restoredCrew?.cells?.management?.checked === false && restoredCrew?.cells?.management?.score === 0,
    JSON.stringify(restoredCrew?.cells?.management),
  );
  const out2 = (board2.outputs as Array<{ category: string; link: string; description: string }>).find((o) => o.category === "derivation");
  check("[6] 재접속: derivation 아웃풋 복원", out2?.link === REVIEW_LINK && out2?.description === REVIEW_DESC, JSON.stringify(out2));

  // ── [9/11] 검수는 snapshot 무영향 ──
  const snapAfterReview = await snapBaseline();
  check("[9] 검수 후 snapshot count·최신 computed_at 불변(고객 미반영)",
    snapAfterReview.count === snapBefore.count && snapAfterReview.latest === snapBefore.latest,
    `count ${snapBefore.count}→${snapAfterReview.count}`,
  );

  // ── [7] 개설 완료 → 고객 반영 ──
  const openRes = await httpPost(cookie, {
    action: "open",
    organization: ORG,
    week_id: weekId,
    team_id: TEAM_ID,
    team_name: TEAM_NAME,
    leaderCells,
    outputs: [{ category: "derivation", link: REVIEW_LINK, description: REVIEW_DESC }],
  });
  const openData = openRes.json?.data ?? {};
  check("[7] HTTP POST open → 201", openRes.status === 201 && openRes.json?.success, `status=${openRes.status} ${openRes.json?.error ?? ""}`);
  console.log(`  open 결과: lines=${openData.linesCreated} targets=${openData.targetsCreated} evals=${openData.evaluationsCreated} warnings=${(openRes.json?.warnings ?? []).length}`);
  if ((openRes.json?.warnings ?? []).length) console.log("  warnings:", JSON.stringify(openRes.json.warnings));

  // 고객 반영 DB 확인.
  const { data: openedLines } = await sb
    .from("cluster4_experience_team_overall_opened_lines")
    .select("line_id,category, cluster4_experience_team_overall!inner(week_id,team_id,organization_slug)")
    .eq("cluster4_experience_team_overall.organization_slug", ORG)
    .eq("cluster4_experience_team_overall.week_id", weekId)
    .eq("cluster4_experience_team_overall.team_id", TEAM_ID);
  const lineIds = ((openedLines ?? []) as Array<{ line_id: string }>).map((r) => r.line_id);
  check("[7] opened_lines 추적 행 생성", lineIds.length > 0 && lineIds.length === openData.linesCreated, `tracked=${lineIds.length} created=${openData.linesCreated}`);

  const { data: custLines } = await sb
    .from("cluster4_lines")
    .select("id,part_type,team_id,is_active,line_code")
    .in("id", lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"]);
  check("[7] cluster4_lines 활성 생성(part_type=experience, team 일치)",
    (custLines ?? []).length === lineIds.length &&
    (custLines ?? []).every((l: any) => l.part_type === "experience" && l.is_active === true && l.team_id === TEAM_ID),
    `lines=${(custLines ?? []).length}`,
  );
  const { data: tgts } = await sb
    .from("cluster4_line_targets")
    .select("id,week_id,target_user_id")
    .in("line_id", lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"]);
  check("[7] line_targets 생성(week 일치)",
    (tgts ?? []).length === openData.targetsCreated && (tgts ?? []).every((t: any) => t.week_id === weekId),
    `targets=${(tgts ?? []).length}`,
  );
  const targetIds = ((tgts ?? []) as Array<{ id: string }>).map((t) => t.id);
  const { count: evalCount } = await sb
    .from("cluster4_experience_line_evaluations")
    .select("*", { count: "exact", head: true })
    .in("line_target_id", targetIds.length ? targetIds : ["00000000-0000-0000-0000-000000000000"]);
  check("[7] evaluations 생성", (evalCount ?? 0) === openData.evaluationsCreated, `evals=${evalCount}`);

  // uncheck 한 첫 크루는 management 라인 대상에서 제외됐는지(체크=false → 비대상).
  const mgmtLineId = ((openedLines ?? []) as Array<{ line_id: string; category: string }>).find((r) => r.category === "management")?.line_id;
  if (mgmtLineId) {
    const { data: mgmtTgts } = await sb.from("cluster4_line_targets").select("target_user_id").eq("line_id", mgmtLineId);
    const has = (mgmtTgts ?? []).some((t: any) => t.target_user_id === firstCrew.userId);
    check("[7] uncheck 크루는 관리 라인 비대상", !has, `mgmt targets=${(mgmtTgts ?? []).length}`);
  }

  const get3 = await httpGet(cookie, weekId);
  check("[7] 완료 후 status=opened", get3.json.data.status === "opened");

  // ── [9/10/11] snapshot 영향/재계산 ──
  const snapAfterOpen = await snapBaseline();
  check("[9/10] open 이 snapshot 생성/강제 재계산 안 함(count·최신 불변)",
    snapAfterOpen.count === snapBefore.count && snapAfterOpen.latest === snapBefore.latest,
    `count ${snapBefore.count}→${snapAfterOpen.count}, latest ${snapBefore.latest}→${snapAfterOpen.latest}`,
  );
  const targetUserIds = Array.from(new Set(((tgts ?? []) as Array<{ target_user_id: string }>).map((t) => t.target_user_id)));
  const { count: staleCount } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true })
    .in("user_id", targetUserIds.length ? targetUserIds : ["00000000-0000-0000-0000-000000000000"])
    .eq("is_stale", true);
  const { count: anyRows } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true })
    .in("user_id", targetUserIds.length ? targetUserIds : ["00000000-0000-0000-0000-000000000000"]);
  check("[11] 대상자 snapshot 행은 stale 표시(있으면) — lazy 재계산 위임",
    (anyRows ?? 0) === 0 || (staleCount ?? 0) > 0,
    `대상자 snapshot 행=${anyRows}, stale=${staleCount}`,
  );

  // ── [8] 개설 취소 → 고객 원복 ──
  const cancelRes = await httpPost(cookie, {
    action: "cancel",
    organization: ORG,
    week_id: weekId,
    team_id: TEAM_ID,
    team_name: TEAM_NAME,
  });
  check("[8] HTTP POST cancel → 200", cancelRes.status === 200 && cancelRes.json?.success, `status=${cancelRes.status} ${cancelRes.json?.error ?? ""}`);
  check("[8] linesRemoved == linesCreated", cancelRes.json?.data?.linesRemoved === openData.linesCreated, `removed=${cancelRes.json?.data?.linesRemoved}`);

  const { data: linesAfter } = await sb.from("cluster4_lines").select("id").in("id", lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"]);
  check("[8] cluster4_lines 원복(0 잔여)", (linesAfter ?? []).length === 0, `남은 lines=${(linesAfter ?? []).length}`);
  const { data: tgtAfter } = await sb.from("cluster4_line_targets").select("id").in("id", targetIds.length ? targetIds : ["00000000-0000-0000-0000-000000000000"]);
  check("[8] line_targets 원복(0 잔여)", (tgtAfter ?? []).length === 0, `남은 targets=${(tgtAfter ?? []).length}`);
  const { data: openedAfter } = await sb
    .from("cluster4_experience_team_overall_opened_lines")
    .select("id, cluster4_experience_team_overall!inner(week_id,team_id,organization_slug)")
    .eq("cluster4_experience_team_overall.organization_slug", ORG)
    .eq("cluster4_experience_team_overall.week_id", weekId)
    .eq("cluster4_experience_team_overall.team_id", TEAM_ID);
  check("[8] opened_lines 추적 0", (openedAfter ?? []).length === 0);
  const get4 = await httpGet(cookie, weekId);
  check("[8] 취소 후 status=reviewed (검수 데이터 보존)", get4.json.data.status === "reviewed");

  const snapAfterCancel = await snapBaseline();
  check("[9/10] cancel 도 snapshot 생성/강제 재계산 안 함(count 불변)",
    snapAfterCancel.count === snapBefore.count,
    `count ${snapBefore.count}→${snapAfterCancel.count}`,
  );

  // ── 잔여물 제거 — team_overall 헤더(검수 메타) 삭제(CASCADE) ──
  await deleteOverallHeader(weekId);
  const { data: finalLines } = await sb
    .from("cluster4_lines")
    .select("id")
    .in("id", lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"]);
  check("[cleanup] 잔여 고객 라인 0 + 검수 헤더 삭제 완료", (finalLines ?? []).length === 0);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
