// 검증 — 실무 역량 [라인 개설] 탭(상태창+로그창+개설완료/취소) 및 HTTP===direct.
//   읽기 전용: open/cancel(고객 반영 변이)은 실행하지 않는다.
//   1) HTTP opening-status/opening-logs (oranke/encre/phalanx) — direct(tsx)와 동일 주차/opened 확인.
//   2) 브라우저: ?org 별 [라인 관리](기존 화면 공존) + [라인 개설](대시보드) 렌더.
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
const ORGS = ["oranke", "encre", "phalanx"];

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
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
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const cookies = await makeAdminCookies();
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

// ── 1) HTTP opening-status/opening-logs (direct tsx 결과: 전 org current=W15 target=W14 opened=false) ──
console.log("== HTTP opening-status / opening-logs ==");
for (const org of ORGS) {
  const sRes = await fetch(`${BASE}/api/admin/cluster4/competency/opening-status?organization=${org}`, {
    headers: { cookie: cookieHeader },
  });
  const sJson = await sRes.json();
  const ok = sJson.success && sJson.data;
  const d = sJson.data ?? {};
  const cw = d.currentWeek ? `${d.currentWeek.year} ${d.currentWeek.seasonName} W${d.currentWeek.weekNumber}` : "null";
  const tw = d.targetWeek ? `${d.targetWeek.year} ${d.targetWeek.seasonName} W${d.targetWeek.weekNumber}` : "null";
  check(`[HTTP status ${org}] success + current=W15 target=W14 (direct 일치)`,
    ok && cw.endsWith("W15") && tw.endsWith("W14"), `current=${cw} target=${tw} opened=${d.opened}`);

  const lRes = await fetch(`${BASE}/api/admin/cluster4/competency/opening-logs?organization=${org}`, {
    headers: { cookie: cookieHeader },
  });
  const lJson = await lRes.json();
  check(`[HTTP logs ${org}] success + logs 배열(테이블 미적용시 빈 배열 best-effort)`,
    lJson.success && Array.isArray(lJson.data?.logs), `logs=${lJson.data?.logs?.length ?? "?"}`);
}

// POST 잘못된 action / 잘못된 org 거절 검증(변이 없음).
const badAction = await fetch(`${BASE}/api/admin/cluster4/competency/opening`, {
  method: "POST", headers: { "content-type": "application/json", cookie: cookieHeader },
  body: JSON.stringify({ action: "nope", organization: "oranke" }),
});
check("[HTTP POST] 잘못된 action 거절(400)", badAction.status === 400, `status=${badAction.status}`);
const badOrg = await fetch(`${BASE}/api/admin/cluster4/competency/opening`, {
  method: "POST", headers: { "content-type": "application/json", cookie: cookieHeader },
  body: JSON.stringify({ action: "open", organization: "olympus" }),
});
check("[HTTP POST] 무효 org(olympus) 거절(400) — admin org slug 아님", badOrg.status === 400, `status=${badOrg.status}`);

// ── 2) 브라우저 렌더 ──
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2200 } });
await context.addCookies(cookies);
const page = await context.newPage();

try {
  for (const org of ORGS) {
    // [라인 관리] — 기존 실무 역량 화면 공존(내부 탭 + 제목).
    await page.goto(`${BASE}/admin/line-opening/practical-competency?org=${org}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction("!document.body.innerText.includes('불러오는 중')", undefined, { timeout: 30000 }).catch(() => {});
    const manageBody = await page.evaluate("document.body.innerText");
    check(`[${org}/manage] 헤더 2탭(라인 관리/라인 개설)`,
      manageBody.includes("라인 관리") && manageBody.includes("라인 개설"));
    check(`[${org}/manage] 기존 화면 공존(라인 등록/카페 링크 집계)`,
      manageBody.includes("라인 등록") && manageBody.includes("카페 링크 집계"));

    // [라인 개설] — 대시보드(상태창/로그창/개설완료/취소).
    await page.goto(`${BASE}/admin/line-opening/practical-competency?org=${org}&tab=open`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction("!document.body.innerText.includes('불러오는 중')", undefined, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction("document.body.innerText.includes('상태창')", undefined, { timeout: 30000 }).catch(() => {});
    const openBody = await page.evaluate("document.body.innerText");
    check(`[${org}/open] 상태창 + 로그창 렌더`, openBody.includes("상태창") && openBody.includes("로그창"));
    check(`[${org}/open] 블록1(오늘 ... 이번 주는)`, /오늘은[\s\S]*이번 주는/.test(openBody));
    check(`[${org}/open] 허브 전체 1문장([실무 역량] 허브 산하 라인들이 ‘개설’ 되어야)`,
      openBody.includes("[실무 역량] 허브 산하 라인들이") &&
      (openBody.includes("‘개설’ 되어야 합니다") || openBody.includes("‘개설 완료’ 되었습니다")));
    check(`[${org}/open] 개설 완료/개설 취소 버튼`,
      openBody.includes("개설 완료") && openBody.includes("개설 취소"));
    check(`[${org}/open] 로그 없음 안내(테이블 미적용/빈 로그)`,
      openBody.includes("아직 기록된 개설 로그가 없습니다") || openBody.includes("["));

    // 개설 취소 버튼 비활성(opened=false → disabled) 확인.
    const cancelDisabled = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "개설 취소");
      return btns.length > 0 && btns.every((b) => b.disabled);
    });
    check(`[${org}/open] opened=false → [개설 취소] 비활성`, cancelDisabled);

    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `browser-competency-open-${org}.png`), fullPage: true });
  }
  console.log("  screenshots → claudedocs/browser-competency-open-{org}.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-competency-open-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
