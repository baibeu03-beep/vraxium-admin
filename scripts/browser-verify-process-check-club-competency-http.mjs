// 브라우저(인증) HTTP 검증 — 프로세스 체크 info/competency/club 동일 UI/UX + 허브 필터 + 쓰기 경로.
//   admin 세션 쿠키로 실제 API 호출:
//     [1] GET 보드 3허브 × operating/test → direct 스냅샷과 일치(direct == HTTP), 허브별 액트 필터.
//     [2] info 만 테스트 주차 예외(13) — competency/club 은 test==operating.
//     [3] org 분리(oranke/encre/phalanx) — organization 일치.
//     [4] 쓰기 경로(club 액트): request → process_check_statuses(pending)+process_check_logs(check_requested),
//         cancel → needed + check_cancelled. self-clean(생성 status/log 전수 삭제).
//   ⚠ 고객앱/snapshot 무접촉 — 본 검증은 process_check_* 테이블만 확인.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

const direct = JSON.parse(readFileSync(resolve(adminRoot, "claudedocs/verify-process-check-hub-direct.json"), "utf8"));

async function makeAdminCookies() {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto(`${BASE}/admin/processes/check/club?org=oranke`, { waitUntil: "domcontentloaded" });

const httpGet = (u) => page.evaluate(async (x) => { const r = await fetch(x); const j = await r.json().catch(() => ({})); return { status: r.status, data: j?.data ?? null, success: j?.success ?? false, error: j?.error ?? null }; }, u);
const httpPost = (u, b) => page.evaluate(async ({ x, body }) => { const r = await fetch(x, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); return { status: r.status, success: j?.success ?? false, data: j?.data ?? null, error: j?.error ?? null }; }, { x: u, body: b });

const HUBS = ["info", "competency", "club"];

try {
  // act → hub map(허브 필터 교차검증).
  const { data: actRows } = await admin.from("process_acts").select("id,hub");
  const hubOf = new Map((actRows ?? []).map((a) => [a.id, a.hub]));

  // [1] GET 보드 3허브 × operating/test — direct == HTTP + 허브 필터.
  console.log("\n[1] GET 보드 direct==HTTP + 허브 필터 (org=oranke)");
  const BOARD_KEYS = JSON.stringify(["acts", "hub", "hubLabel", "lineGroups", "logs", "organization", "summary", "teams", "week"]);
  for (const hub of HUBS) {
    for (const mode of ["operating", "test"]) {
      const qs = `hub=${hub}&org=oranke${mode === "test" ? "&mode=test" : ""}`;
      const r = await httpGet(`/api/admin/processes/check?${qs}`);
      const keys = r.data ? JSON.stringify(Object.keys(r.data).sort()) : "[]";
      const httpIds = (r.data?.acts ?? []).map((a) => a.actId).sort();
      const d = direct[hub][mode];
      const sameIds = d.actIds.length === httpIds.length && d.actIds.every((id, i) => id === httpIds[i]);
      const sameWeek = (r.data?.week?.weekNumber ?? null) === d.weekNumber;
      const wrongHub = httpIds.filter((id) => hubOf.get(id) !== hub).length;
      check(`${hub}/${mode}: keys 동일·direct==HTTP(ids ${httpIds.length}·W${r.data?.week?.weekNumber})·허브필터`,
        r.status === 200 && keys === BOARD_KEYS && sameIds && sameWeek && wrongHub === 0);
    }
  }

  // [2] 테스트 주차 예외 info 한정.
  console.log("\n[2] 테스트 주차 예외 — info 만");
  for (const hub of HUBS) {
    const op = await httpGet(`/api/admin/processes/check?hub=${hub}&org=oranke`);
    const ts = await httpGet(`/api/admin/processes/check?hub=${hub}&org=oranke&mode=test`);
    const ow = op.data?.week?.weekNumber, tw = ts.data?.week?.weekNumber;
    if (hub === "info") check(`info: test(${tw}) ≠ operating(${ow}) · test=13`, tw !== ow && tw === 13);
    else check(`${hub}: test(${tw}) == operating(${ow}) (예외 비적용)`, tw === ow);
  }

  // [3] org 분리.
  console.log("\n[3] org 분리(club)");
  for (const org of ["oranke", "encre", "phalanx"]) {
    const r = await httpGet(`/api/admin/processes/check?hub=club&org=${org}`);
    check(`club/${org}: organization=${r.data?.organization}`, r.status === 200 && r.data?.organization === org);
  }

  // [4] 쓰기 경로(club 액트) — request/cancel + DB 반영 + self-clean.
  console.log("\n[4] 쓰기 경로 club request/cancel (process_check_statuses/logs)");
  const board = await httpGet(`/api/admin/processes/check?hub=club&org=oranke`);
  const targetAct = (board.data?.acts ?? []).find((a) => a.isCheckTarget && a.status === "needed");
  if (!targetAct) {
    check("club 체크대상(needed) 액트 존재", false, "없음 — 쓰기 테스트 skip");
  } else {
    // 사전 로그 id 집합(self-clean 기준).
    const { data: preLogs } = await admin.from("process_check_logs").select("id").eq("organization_slug", "oranke").eq("hub", "club");
    const preLogIds = new Set((preLogs ?? []).map((l) => l.id));
    const { data: preStatus } = await admin.from("process_check_statuses").select("id").eq("organization_slug", "oranke").eq("hub", "club").eq("act_id", targetAct.actId).maybeSingle();
    const preStatusExisted = !!preStatus;

    const sched = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const reqRes = await httpPost(`/api/admin/processes/check`, {
      hub: "club", organization: "oranke", act_id: targetAct.actId, action: "request",
      review_link: "https://cafe.naver.com/verify-club-act", scheduled_check_at: sched,
    });
    check("request → 201 pending", reqRes.status === 201 && reqRes.data?.status === "pending", `status=${reqRes.status} ${reqRes.error ?? ""}`);

    const { data: stRow } = await admin.from("process_check_statuses").select("status,review_link,scheduled_check_at").eq("organization_slug", "oranke").eq("hub", "club").eq("act_id", targetAct.actId).maybeSingle();
    check("process_check_statuses 저장(pending)", stRow?.status === "pending" && stRow?.review_link === "https://cafe.naver.com/verify-club-act");
    const { count: reqLogCount } = await admin.from("process_check_logs").select("id", { count: "exact", head: true }).eq("organization_slug", "oranke").eq("hub", "club").eq("act_id", targetAct.actId).eq("action", "check_requested");
    check("process_check_logs check_requested 기록", (reqLogCount ?? 0) >= 1);

    const cancelRes = await httpPost(`/api/admin/processes/check`, { hub: "club", organization: "oranke", act_id: targetAct.actId, action: "cancel" });
    check("cancel → 201 needed", cancelRes.status === 201 && cancelRes.data?.status === "needed", `status=${cancelRes.status} ${cancelRes.error ?? ""}`);
    const { data: stRow2 } = await admin.from("process_check_statuses").select("status").eq("organization_slug", "oranke").eq("hub", "club").eq("act_id", targetAct.actId).maybeSingle();
    check("process_check_statuses 원복(needed)", stRow2?.status === "needed");

    // self-clean — 생성 로그 전수 삭제 + status 행(이번에 새로 생긴 경우) 삭제.
    const { data: postLogs } = await admin.from("process_check_logs").select("id").eq("organization_slug", "oranke").eq("hub", "club");
    const newLogIds = (postLogs ?? []).map((l) => l.id).filter((id) => !preLogIds.has(id));
    if (newLogIds.length) await admin.from("process_check_logs").delete().in("id", newLogIds);
    if (!preStatusExisted) await admin.from("process_check_statuses").delete().eq("organization_slug", "oranke").eq("hub", "club").eq("act_id", targetAct.actId);
    const { count: leftLog } = await admin.from("process_check_logs").select("id", { count: "exact", head: true }).in("id", newLogIds.length ? newLogIds : ["00000000-0000-0000-0000-000000000000"]);
    check("self-clean 완료(생성 로그/상태 제거)", (leftLog ?? 0) === 0, `removed logs=${newLogIds.length}`);
  }
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
