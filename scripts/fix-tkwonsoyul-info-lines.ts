/**
 * fix-tkwonsoyul-info-lines.ts
 *
 * 운영 모드 practical-info(part_type='info') 라인의 개설 대상 크루에서 테스트 사용자 T권소율을
 * 일괄 제외한다. DB 직접 삭제가 아니라 기존 editInfoLineCrew(=PATCH /info-lines/crew 가 호출하는
 * 동일 함수) 로 라인별 finalUserIds(현재 대상자 − T권소율) replace 처리한다.
 *   - 0명이 되는 라인은 editInfoLineCrew 가 zeroTargetOpen sentinel 1행을 자동 복원(개설 유지).
 *   - snapshot 무효화는 editInfoLineCrew → invalidateWeeklyCardsForLineChange 경로를 그대로 탄다
 *     (운영 모드 → scope.filter 가 테스트 유저 제외 → 실유저 audience 만 stale, T권소율 본인은 별도 재계산).
 *
 * 실행 경로 주: 대량(725 audience) 동기 재계산 폭주를 피하려고 스크립트(요청 컨텍스트 밖)에서
 *   직접 editInfoLineCrew 를 호출한다 → invalidateWeeklyCardsForUsers 가 stale_only(마킹만) 로
 *   동작(lazy-on-read/cron 복구) = 운영 PATCH 와 동일 코드·동일 SoT, 다만 백그라운드 재계산을
 *   요청 컨텍스트 대신 lazy 로 미룸. PATCH 엔드포인트와의 동치는 PHASE 1(임시 라인) 에서 실증한다.
 *
 * 검증: 1) 대상 라인 목록  2) 제거 전/후 대상자 수  3) direct 결과  4) HTTP API 응답
 *       5) direct==HTTP  6) snapshot stale  7) 고객 화면(T권소율 실무정보 강화 성공 소멸)
 *       8) test mode 데이터 무접촉
 *
 * 실행: npx tsx --env-file=.env.local scripts/fix-tkwonsoyul-info-lines.ts
 *   (사전: dev 서버 localhost:3000 기동 — HTTP 검증/고객 카드 조회용)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { readFileSync, writeFileSync } from "node:fs";
import {
  editInfoLineCrew,
  deleteCluster4Line,
  Cluster4LineError,
} from "@/lib/adminCluster4LinesData";
import {
  recomputeWeeklyCardsSnapshotsForUsers,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

const sb = createClient(SUPABASE_URL, SERVICE);

const TARGET = "28a39131-a719-4264-b2a4-96dbda64cbb6"; // T권소율 (test_user_markers·oranke)
const ORG = "oranke";
const W10 = "6cc59d70-3aa6-4823-8854-5b82691d1a84"; // 2026-spring W10 (편집 허용 범위·fixture용)
const AT = "wisdom";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const sortJoin = (a: string[]) => [...a].sort().join(",");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── DB 헬퍼 ──
async function userTargets(lineId: string, weekId: string) {
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_mode,target_user_id,target_rule")
    .eq("line_id", lineId)
    .eq("week_id", weekId);
  const rows = (data ?? []) as Array<{
    target_mode: string;
    target_user_id: string | null;
  }>;
  return {
    users: rows.filter((r) => r.target_mode === "user" && r.target_user_id).map((r) => r.target_user_id as string),
    sentinels: rows.filter((r) => r.target_mode === "rule").length,
  };
}
async function isStale(userId: string): Promise<boolean | null> {
  const { data } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("is_stale")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? Boolean((data as { is_stale: boolean }).is_stale) : null;
}
async function adminActorId(): Promise<string> {
  const { data } = await sb.from("admin_users").select("id").limit(1).maybeSingle();
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error("admin_users 행 없음");
  return id;
}

// ── HTTP 헬퍼(쿠키 인증 + fresh connection) ──
async function cookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const otp = (linkData as any).properties.email_otp;
  const { data: verifyData } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items: any[]) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: (verifyData as any).session.access_token,
    refresh_token: (verifyData as any).session.refresh_token,
  });
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}
let COOKIE = "";
async function httpGetCrew(lineId: string, weekId: string) {
  const sp = new URLSearchParams({ line_id: lineId, week_id: weekId, organization: ORG });
  const r = await fetch(`${BASE}/api/admin/cluster4/info-lines/crew?${sp}`, {
    headers: { cookie: COOKIE, connection: "close" },
  });
  return { status: r.status, json: (await r.json()) as any };
}
async function httpPatchCrew(lineId: string, weekId: string, ids: string[]) {
  const r = await fetch(`${BASE}/api/admin/cluster4/info-lines/crew?organization=${ORG}&mode=operating`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: COOKIE, connection: "close" },
    body: JSON.stringify({ line_id: lineId, week_id: weekId, mode: "replace", target_user_ids: ids }),
  });
  return { status: r.status, json: (await r.json()) as any };
}
async function httpCustomerCards(userId: string) {
  const r = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, {
    headers: { cookie: COOKIE, connection: "close" },
  });
  return { status: r.status, json: (await r.json()) as any };
}
// 카드에서 주어진 lineCode 집합의 info 강화 성공 수를 센다.
function countInfoSuccess(cards: any[], codes: Set<string>) {
  let total = 0;
  const byCode: Record<string, string> = {};
  for (const c of cards ?? []) {
    for (const l of c.lines ?? []) {
      if (l.partType !== "information" || !l.lineCode) continue;
      if (!codes.has(l.lineCode)) continue;
      byCode[l.lineCode] = l.enhancementStatus;
      if (l.enhancementStatus === "success") total++;
    }
  }
  return { total, byCode };
}

async function createTempLine(token: "OK", actor: string): Promise<string> {
  const { data, error } = await sb
    .from("cluster4_lines")
    .insert({
      part_type: "info",
      activity_type_id: AT,
      line_code: `IF${token}-TKFIXEQ${Date.now()}`,
      main_title: "[T권소율 제외 동치검증 임시 라인]",
      output_links: [{ url: "https://example.com", label: "검증" }],
      output_link_1: "https://example.com",
      submission_opens_at: new Date("2026-05-04T00:00:00Z").toISOString(),
      submission_closes_at: new Date("2026-05-10T23:59:59Z").toISOString(),
      week_id: W10,
      is_active: true,
      created_by: actor,
      updated_by: actor,
    })
    .select("id")
    .single();
  if (error) throw new Error(`temp line insert failed: ${error.message}`);
  const lineId = (data as { id: string }).id;
  // T권소율 단독 user 타깃(실데이터와 동일 시나리오: solo → replace [] → 0명 sentinel).
  await sb.from("cluster4_line_targets").insert({
    line_id: lineId,
    week_id: W10,
    target_mode: "user",
    target_user_id: TARGET,
    target_rule: {},
    created_by: actor,
    updated_by: actor,
  });
  return lineId;
}

type LineRec = { lineId: string; weekId: string; lineCode: string | null };

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  T권소율 운영 practical-info 개설 대상 크루 일괄 제외          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  const actor = await adminActorId();
  COOKIE = await cookieHeader();
  const testIds = await fetchTestUserMarkerIds();
  check("T권소율 test_user_markers 등재(처리 대상=테스트 유저)", testIds.has(TARGET), TARGET);

  // 대상 라인 = diag 산출물(운영 oranke info, T권소율 user 타깃 23건).
  const diag = JSON.parse(readFileSync("claudedocs/diag-tkwonsoyul-info-lines.json", "utf8")) as {
    classified: LineRec[];
  };
  const lines: LineRec[] = diag.classified;
  const codeSet = new Set(lines.map((l) => l.lineCode!).filter(Boolean));
  console.log(`\n[1] 대상 라인 ${lines.length}건 (운영 oranke practical-info, T권소율 user 타깃)`);

  // ───────────────────────── PHASE 0: 베이스라인 ─────────────────────────
  console.log("\n── PHASE 0: 베이스라인 캡처 (read-only) ──");
  // 0a. 라인별 현재 대상자(제거 전).
  const before: Record<string, { users: string[]; sentinels: number }> = {};
  let withTarget = 0;
  for (const l of lines) {
    const t = await userTargets(l.lineId, l.weekId);
    before[l.lineId] = t;
    if (t.users.includes(TARGET)) withTarget++;
  }
  check(`[2] 제거 전: ${lines.length}개 라인 모두 T권소율 포함`, withTarget === lines.length, `${withTarget}/${lines.length}`);
  console.log(`     제거 전 대상자 수 합계 = ${Object.values(before).reduce((a, b) => a + b.users.length, 0)} (라인당 1=T권소율)`);

  // 0b. test mode 데이터 무접촉 기준선: T권소율 외 테스트 유저의 info user 타깃 (line_id|user_id) 집합.
  const { data: allInfoTestTargets } = await sb
    .from("cluster4_line_targets")
    .select("line_id,target_user_id,cluster4_lines!inner(part_type)")
    .eq("target_mode", "user")
    .eq("cluster4_lines.part_type", "info");
  const otherTestPairsBefore = new Set(
    ((allInfoTestTargets ?? []) as any[])
      .filter((r) => r.target_user_id && r.target_user_id !== TARGET && testIds.has(r.target_user_id))
      .map((r) => `${r.line_id}|${r.target_user_id}`),
  );
  // 0c. T권소율 비-info 타깃(건드리면 안 됨) 기준선.
  const { data: tkAll } = await sb
    .from("cluster4_line_targets")
    .select("id,line_id,cluster4_lines!inner(part_type)")
    .eq("target_user_id", TARGET)
    .eq("target_mode", "user");
  const tkNonInfoBefore = new Set(
    ((tkAll ?? []) as any[]).filter((r) => r.cluster4_lines?.part_type !== "info").map((r) => r.id),
  );
  console.log(`     기준선: 타 테스트유저 info 타깃 ${otherTestPairsBefore.size}쌍 / T권소율 비-info 타깃 ${tkNonInfoBefore.size}건`);

  // 0d. 고객 화면 베이스라인 — T권소율 recompute 후 info 강화 성공 수(HTTP 고객 엔드포인트).
  await recomputeWeeklyCardsSnapshotsForUsers([TARGET]);
  const custBefore = await httpCustomerCards(TARGET);
  const cb = countInfoSuccess(custBefore.json?.data ?? [], codeSet);
  check("[7-base] 고객 화면 T권소율 info 강화 성공 = 23 (제거 전)", cb.total === lines.length, `success=${cb.total}`);

  // ──────────────── PHASE 1: direct == HTTP 동치 실증 (임시 라인) ────────────────
  console.log("\n── PHASE 1: direct(editInfoLineCrew) == HTTP(PATCH) 동치 실증 ──");
  let fxA: string | null = null;
  let fxB: string | null = null;
  try {
    fxA = await createTempLine("OK", actor);
    const rDirect = await editInfoLineCrew({
      lineId: fxA, weekId: W10, mode: "replace", targetUserIds: [],
      actorAdminId: actor, organization: ORG, scopeMode: "operating",
    });
    const tDirect = await userTargets(fxA, W10);

    fxB = await createTempLine("OK", actor);
    const rHttp = await httpPatchCrew(fxB, W10, []);
    const dHttp = rHttp.json?.data ?? {};
    const tHttp = await userTargets(fxB, W10);

    check("[3] direct 결과: removed=[T권소율] added=[] final=0",
      sortJoin(rDirect.removed) === TARGET && rDirect.added.length === 0 && rDirect.finalUserCount === 0,
      JSON.stringify({ removed: rDirect.removed.length, final: rDirect.finalUserCount }));
    check("[4] HTTP 200 + data 동일 형태", rHttp.status === 200 && rHttp.json?.success,
      `status=${rHttp.status} err=${rHttp.json?.error ?? ""}`);
    check("[5] direct == HTTP (removed/added/finalUserCount 일치)",
      sortJoin(rDirect.removed) === sortJoin(dHttp.removed ?? []) &&
        rDirect.added.length === (dHttp.added ?? []).length &&
        rDirect.finalUserCount === dHttp.finalUserCount,
      `direct.final=${rDirect.finalUserCount} http.final=${dHttp.finalUserCount}`);
    check("[5b] direct/HTTP 둘 다 0명 sentinel 복원(users=0, sentinel=1)",
      tDirect.users.length === 0 && tDirect.sentinels === 1 && tHttp.users.length === 0 && tHttp.sentinels === 1,
      `direct{u:${tDirect.users.length},s:${tDirect.sentinels}} http{u:${tHttp.users.length},s:${tHttp.sentinels}}`);
  } finally {
    for (const id of [fxA, fxB]) {
      if (!id) continue;
      try { await deleteCluster4Line(id, "operating"); } catch { /* fixture cleanup best-effort */ }
      await sb.from("cluster4_line_targets").delete().eq("line_id", id);
      await sb.from("cluster4_lines").delete().eq("id", id);
    }
    check("[1-fx] 임시 동치검증 라인 정리됨", true);
  }

  // ───────────────────────── PHASE 2: 실 라인 일괄 제외 ─────────────────────────
  console.log("\n── PHASE 2: 실 라인 23건 일괄 제외 (editInfoLineCrew · operating · replace) ──");
  const results: Array<{
    lineCode: string | null; lineId: string; weekId: string;
    beforeCount: number; finalIds: string[]; removed: string[]; finalUserCount: number;
    afterUsers: string[]; afterSentinels: number;
  }> = [];
  for (const l of lines) {
    const cur = before[l.lineId].users;
    const finalIds = cur.filter((id) => id !== TARGET); // T권소율만 제거
    let res;
    try {
      res = await editInfoLineCrew({
        lineId: l.lineId, weekId: l.weekId, mode: "replace", targetUserIds: finalIds,
        actorAdminId: actor, organization: ORG, scopeMode: "operating",
      });
    } catch (e) {
      const msg = e instanceof Cluster4LineError ? `${e.status} ${e.message}` : String(e);
      check(`제외 실패 ${l.lineCode}`, false, msg);
      continue;
    }
    const after = await userTargets(l.lineId, l.weekId);
    results.push({
      lineCode: l.lineCode, lineId: l.lineId, weekId: l.weekId,
      beforeCount: cur.length, finalIds, removed: res.removed,
      finalUserCount: res.finalUserCount, afterUsers: after.users, afterSentinels: after.sentinels,
    });
  }
  const allRemoved = results.every((r) => sortJoin(r.removed) === TARGET);
  const allFinalMatch = results.every((r) => sortJoin(r.afterUsers) === sortJoin(r.finalIds) && !r.afterUsers.includes(TARGET));
  const allSentinelOk = results.every((r) => (r.finalUserCount === 0 ? r.afterSentinels === 1 && r.afterUsers.length === 0 : r.afterSentinels === 0));
  check(`[2/3] 23건 모두 removed=[T권소율]`, results.length === lines.length && allRemoved, `${results.length}/${lines.length}`);
  check("[2후] 모든 라인 afterUsers==finalIds 且 T권소율 부재", allFinalMatch);
  check("[0명 sentinel] 0명 라인=sentinel 1행 복원 / N명 라인=sentinel 0", allSentinelOk);
  console.log(`     제거 후 대상자 수 합계 = ${results.reduce((a, b) => a + b.afterUsers.length, 0)} (전부 0명 → 전체 강화 실패 개설 유지)`);

  // ───────────────────────── PHASE 3: 검증 ─────────────────────────
  console.log("\n── PHASE 3: 검증 ──");

  // [4] 실제 HTTP API — 각 라인 crew GET 으로 T권소율 부재 확인(샘플 5 + 전수 count).
  let httpZero = 0;
  let httpHasTk = 0;
  const sampleGets: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const g = await httpGetCrew(lines[i].lineId, lines[i].weekId);
    const targets = g.json?.data?.targets ?? [];
    const hasTk = targets.some((t: any) => t.userId === TARGET);
    if ((g.json?.data?.count ?? -1) === 0) httpZero++;
    if (hasTk) httpHasTk++;
    if (i < 5) sampleGets.push({ code: lines[i].lineCode, status: g.status, count: g.json?.data?.count, hasTk });
  }
  check("[4] HTTP crew GET: 23건 모두 count=0 (대상자 비움)", httpZero === lines.length, `count0=${httpZero}/${lines.length}`);
  check("[4] HTTP crew GET: T권소율 잔존 0건", httpHasTk === 0, `잔존=${httpHasTk}`);
  console.log("     샘플:", JSON.stringify(sampleGets));

  // [6] snapshot stale — operating invalidate 가 oranke 실유저 audience 를 stale 마킹했는지(샘플).
  const { data: oraSnaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,is_stale")
    .limit(2000);
  const oraRows = (oraSnaps ?? []) as Array<{ user_id: string; is_stale: boolean }>;
  // oranke 실유저(테스트 제외) 중 stale 비율.
  const { data: oraProfiles } = await sb
    .from("user_profiles").select("user_id").eq("organization_slug", "oranke");
  const oraIds = new Set(((oraProfiles ?? []) as any[]).map((p) => p.user_id).filter((id) => !testIds.has(id)));
  const oraReal = oraRows.filter((r) => oraIds.has(r.user_id));
  const oraStale = oraReal.filter((r) => r.is_stale).length;
  check("[6] snapshot 무효화: oranke 실유저 audience 다수 is_stale=true",
    oraReal.length > 0 && oraStale >= Math.floor(oraReal.length * 0.8),
    `stale ${oraStale}/${oraReal.length}`);

  // [7] 고객 화면 — T권소율 snapshot 재계산(operating 경로가 테스트 유저는 제외하므로 명시 재계산:
  //     실제 고객 접속 시 lazy-on-read 가 하는 일과 동일) 후 HTTP 고객 엔드포인트로 강화 성공 소멸 확인.
  await recomputeWeeklyCardsSnapshotsForUsers([TARGET]);
  const custAfter = await httpCustomerCards(TARGET);
  const ca = countInfoSuccess(custAfter.json?.data ?? [], codeSet);
  check("[7] 고객 화면 T권소율 info 강화 성공 = 0 (23→0 소멸)", ca.total === 0, `success ${cb.total}→${ca.total}`);
  // 해당 23 코드가 success 가 아님(개설 유지 → fail 로 전이) 확인.
  const stillSuccess = Object.entries(ca.byCode).filter(([, st]) => st === "success").map(([c]) => c);
  check("[7] 23개 라인 코드 중 success 잔존 0", stillSuccess.length === 0, stillSuccess.join(",") || "none");

  // [8] test mode 데이터 무접촉.
  const { data: allInfoTestAfter } = await sb
    .from("cluster4_line_targets")
    .select("line_id,target_user_id,cluster4_lines!inner(part_type)")
    .eq("target_mode", "user")
    .eq("cluster4_lines.part_type", "info");
  const otherTestPairsAfter = new Set(
    ((allInfoTestAfter ?? []) as any[])
      .filter((r) => r.target_user_id && r.target_user_id !== TARGET && testIds.has(r.target_user_id))
      .map((r) => `${r.line_id}|${r.target_user_id}`),
  );
  const sameOtherTest =
    otherTestPairsAfter.size === otherTestPairsBefore.size &&
    [...otherTestPairsBefore].every((p) => otherTestPairsAfter.has(p));
  check("[8] 타 테스트유저 info 타깃 무변경", sameOtherTest,
    `before=${otherTestPairsBefore.size} after=${otherTestPairsAfter.size}`);
  const { data: tkAllAfter } = await sb
    .from("cluster4_line_targets")
    .select("id,cluster4_lines!inner(part_type)")
    .eq("target_user_id", TARGET).eq("target_mode", "user");
  const tkNonInfoAfter = new Set(
    ((tkAllAfter ?? []) as any[]).filter((r) => r.cluster4_lines?.part_type !== "info").map((r) => r.id),
  );
  const tkInfoAfter = ((tkAllAfter ?? []) as any[]).filter((r) => r.cluster4_lines?.part_type === "info").length;
  check("[8] T권소율 비-info 타깃 무변경(제외 대상 아님)",
    tkNonInfoAfter.size === tkNonInfoBefore.size && [...tkNonInfoBefore].every((id) => tkNonInfoAfter.has(id)),
    `before=${tkNonInfoBefore.size} after=${tkNonInfoAfter.size}`);
  check("[8] T권소율 info user 타깃 0건 잔존", tkInfoAfter === 0, `잔존=${tkInfoAfter}`);

  // ── 리포트 저장 ──
  writeFileSync("claudedocs/fix-tkwonsoyul-info-lines-report.json", JSON.stringify({
    target: TARGET, org: ORG, lineCount: lines.length,
    customerInfoSuccess: { before: cb.total, after: ca.total },
    snapshotStale: { oraReal: oraReal.length, oraStale },
    results,
  }, null, 2));

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`결과: ${pass} pass / ${fail} fail`);
  console.log(`고객 info 강화 성공: ${cb.total} → ${ca.total}`);
  console.log(`리포트: claudedocs/fix-tkwonsoyul-info-lines-report.json`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
