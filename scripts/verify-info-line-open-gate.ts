/**
 * 실무 정보 라인 — "미오픈" 게이트 검증 (dev server 필요).
 *
 *   1) 공용 판정 함수 isInfoLineOpenForWeek 단위 검증(open_confirmed·practicalInfo 엄격).
 *   2) 주차별 개설 결과 — 게이트 활성 주차(open_confirmed=true) : 미오픈(not_open) 반영 + direct==HTTP.
 *   3) 주차별 개설 결과 — 오픈 설정 없는 과거 주차 : 이력 보존(notOpenCount=0, openedLineCount 유지).
 *   4) 실제 라인 개설 POST : 미오픈 라인은 409 차단(운영/테스트 동일). ?dev=true 로도 우회 불가.
 *   5) info-lines GET isOpenThisWeek(개설 폼 게이트 데이터) — 오픈/미오픈 라인 값 확인.
 *
 *   npx tsx --env-file=.env.local scripts/verify-info-line-open-gate.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";
import { isInfoLineOpenForWeek } from "@/lib/weekOpenGate";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (it: any[]) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) },
  });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function httpResults(cookie: string, org: string, weekId: string, mode: string) {
  const res = await fetch(`${BASE}/api/admin/cluster4/info-line-results?week_id=${weekId}&organization=${org}&mode=${mode}`, {
    headers: { cookie }, cache: "no-store",
  });
  return (await res.json().catch(() => ({}))) as any;
}

const CFG_ORG = "encre";
const CFG_WEEK = "2d21a7cc-37ce-4223-acac-419bc5fa094b"; // open_confirmed=true, essay:false 나머지 true

async function main() {
  // ── 1) 단위 ──────────────────────────────────────────────────────────────────
  const cfg = { practicalInfo: { wisdom: true, essay: false } } as any;
  ck("gate: open_confirmed=false → 미오픈", isInfoLineOpenForWeek({ openConfirmed: false, config: cfg, activityTypeId: "wisdom" }) === false);
  ck("gate: practicalInfo 체크됨 → 오픈", isInfoLineOpenForWeek({ openConfirmed: true, config: cfg, activityTypeId: "wisdom" }) === true);
  ck("gate: practicalInfo=false → 미오픈", isInfoLineOpenForWeek({ openConfirmed: true, config: cfg, activityTypeId: "essay" }) === false);
  ck("gate: 설정 없음(엄격) → 미오픈", isInfoLineOpenForWeek({ openConfirmed: true, config: null, activityTypeId: "wisdom" }) === false);

  const cookie = await cookieHeader();

  // ── 2) 게이트 활성 주차(encre 2d21a7cc) — 미오픈 반영 + direct==HTTP ─────────────
  const direct = await getInfoLineResultsForWeek({ weekId: CFG_WEEK, organization: CFG_ORG as any, mode: "operating" });
  const essay = direct.lines.find((l) => l.activityTypeId === "essay");
  const wisdom = direct.lines.find((l) => l.activityTypeId === "wisdom");
  ck("게이트 활성: essay = 미오픈(not_open)", essay?.status === "not_open" && essay?.isOpenThisWeek === false, { status: essay?.status });
  ck("게이트 활성: wisdom = 오픈 대상(not_open 아님)", wisdom?.status !== "not_open" && wisdom?.isOpenThisWeek === true, { status: wisdom?.status });
  ck("게이트 활성: notOpenCount>=1", (direct.notOpenCount ?? 0) >= 1, { notOpenCount: direct.notOpenCount });
  ck("게이트 활성: openLineCount = 전체 - 미오픈", direct.openLineCount === direct.totalLineCount - direct.notOpenCount, direct);

  const httpOp = await httpResults(cookie, CFG_ORG, CFG_WEEK, "operating");
  const httpTe = await httpResults(cookie, CFG_ORG, CFG_WEEK, "test");
  const dEssayHttp = (httpOp?.data?.lines ?? []).find((l: any) => l.activityTypeId === "essay");
  ck("게이트 활성: HTTP essay = not_open", dEssayHttp?.status === "not_open" && dEssayHttp?.isOpenThisWeek === false);
  ck("게이트 활성: direct==HTTP notOpenCount", httpOp?.data?.notOpenCount === direct.notOpenCount, { http: httpOp?.data?.notOpenCount, direct: direct.notOpenCount });
  ck("게이트 활성: 운영/테스트 notOpenCount 동일", httpOp?.data?.notOpenCount === httpTe?.data?.notOpenCount);
  const keysOp = Object.keys(httpOp?.data ?? {}).sort();
  ck("결과 DTO 키: 신필드 포함", ["totalLineCount", "openLineCount", "openedLineCount", "needsOpeningCount", "notOpenCount"].every((k) => keysOp.includes(k)), { keys: keysOp });

  // ── 3) 오픈 설정 없는 과거 주차 — 이력 보존 ──────────────────────────────────
  //   개설된 info 라인이 있으나 config 없는 (org, week) 를 탐색.
  const { data: lineRows } = await supabaseAdmin
    .from("cluster4_lines").select("week_id,line_code").eq("part_type", "info").eq("is_active", true).not("week_id", "is", null).limit(300);
  const orgOf = (code: string | null) => code?.includes("OK") ? "oranke" : code?.includes("EC") ? "encre" : code?.includes("PX") ? "phalanx" : "common";
  let histOrg: string | null = null, histWeek: string | null = null;
  for (const r of (lineRows ?? []) as any[]) {
    const org = orgOf(r.line_code);
    if (org === "common") continue;
    const { data: c } = await supabaseAdmin.from("cluster4_week_opening_configs").select("open_confirmed").eq("week_id", r.week_id).eq("organization_slug", org).maybeSingle();
    if (!c) {
      const res = await getInfoLineResultsForWeek({ weekId: r.week_id, organization: org as any, mode: "operating" });
      if (res.openedLineCount > 0) { histOrg = org; histWeek = r.week_id; break; }
    }
  }
  if (histOrg && histWeek) {
    const hist = await getInfoLineResultsForWeek({ weekId: histWeek, organization: histOrg as any, mode: "operating" });
    ck(`이력 보존: config 없는 과거 주차(${histOrg}) openedLineCount 유지(>0)`, hist.openedLineCount > 0, { opened: hist.openedLineCount });
    ck("이력 보존: notOpenCount=0(미오픈 뒤집힘 없음)", hist.notOpenCount === 0, { notOpen: hist.notOpenCount });
    ck("이력 보존: 전 라인 isOpenThisWeek=true", hist.lines.every((l) => l.isOpenThisWeek === true));
    const httpHist = await httpResults(cookie, histOrg, histWeek, "operating");
    ck("이력 보존: direct==HTTP openedLineCount", httpHist?.data?.openedLineCount === hist.openedLineCount, { http: httpHist?.data?.openedLineCount, direct: hist.openedLineCount });
  } else {
    ck("이력 보존: 테스트 대상 주차 탐색", false, "config 없는 개설 주차를 찾지 못함");
  }

  // ── 4) 라인 개설 POST 차단 파리티 — 미오픈 라인은 409(?dev=true 로도 우회 불가) ──────
  //   oranke = config 없음 → 전 라인 미오픈. 게이트가 write 전 차단 → DB 무변경(안전).
  const BLOCK_ORG = "oranke";
  const { data: atRows } = await supabaseAdmin.from("activity_types").select("id").eq("cluster_id", "practical_info").eq("is_active", true).limit(1);
  const activityTypeId = (atRows?.[0] as any)?.id as string;
  const { data: anyWeek } = await supabaseAdmin.from("weeks").select("id").not("start_date", "is", null).order("start_date", { ascending: false }).limit(1);
  const blockWeek = (anyWeek?.[0] as any)?.id as string;

  // 안전: 미오픈 확인(개설되지 않도록).
  const gate = await fetch(`${BASE}/api/admin/cluster4/info-lines?week_id=${blockWeek}&activity_type_id=${activityTypeId}&organization=${BLOCK_ORG}`, { headers: { cookie }, cache: "no-store" });
  const gateJson: any = await gate.json().catch(() => ({}));
  ck("POST 전 안전확인: 대상 라인 미오픈(isOpenThisWeek=false)", gateJson?.data?.isOpenThisWeek === false, { v: gateJson?.data?.isOpenThisWeek });

  const doPost = async (mode: string) => {
    const res = await fetch(`${BASE}/api/admin/cluster4/info-lines?organization=${BLOCK_ORG}&mode=${mode}&dev=true`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({
        activity_type_id: activityTypeId, main_title: "게이트 검증(개설 안 됨)",
        output_link_1: "https://example.com/gate-check", output_links: [], output_images: [],
        target_user_ids: [], week_id: blockWeek, submission_opens_at: "x", submission_closes_at: "x",
      }),
    });
    const j: any = await res.json().catch(() => ({}));
    return { status: res.status, error: j?.error ?? "" };
  };
  const pOp = await doPost("operating");
  const pTe = await doPost("test");
  ck("POST operating: 미오픈 라인 → 409 차단", pOp.status === 409, pOp);
  ck("POST operating: 사유 '오픈되지 않은 라인'", pOp.error.includes("오픈되지 않은 라인"));
  ck("POST test: 미오픈 라인 → 409 차단", pTe.status === 409, pTe);
  ck("POST 운영/테스트 status 동일", pOp.status === pTe.status);
  ck("POST 운영/테스트 message 동일", pOp.error === pTe.error, { op: pOp.error, te: pTe.error });

  // ── 5) info-lines GET isOpenThisWeek(개설 폼 게이트 데이터) ──────────────────────
  const getOpen = async (org: string, week: string, at: string) => {
    const r = await fetch(`${BASE}/api/admin/cluster4/info-lines?week_id=${week}&activity_type_id=${at}&organization=${org}`, { headers: { cookie }, cache: "no-store" });
    return ((await r.json().catch(() => ({}))) as any)?.data?.isOpenThisWeek;
  };
  ck("GET isOpenThisWeek: encre wisdom(체크) = true", (await getOpen(CFG_ORG, CFG_WEEK, "wisdom")) === true);
  ck("GET isOpenThisWeek: encre essay(미체크) = false", (await getOpen(CFG_ORG, CFG_WEEK, "essay")) === false);

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
