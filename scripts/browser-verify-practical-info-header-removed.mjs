// 브라우저 검증 — 실무 정보 라인 운영 페이지 최상단 헤더 블록(H1 제목 + 설명) 제거.
//   /admin/line-opening/practical-info?org=oranke
//   (1) H1 "실무 정보 라인 운영" 제거.
//   (2) 설명 "활동 유형 탭별로 라인을 개설하고…" 제거.
//   (3) 탭 영역(라인 관리/라인 개설) + 현재 상황 카드는 유지(최상단으로 상승).
//   읽기/표시 전용 — DB/저장/API 무접촉.
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

const ORG = "oranke";

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

const H1_TEXT = "실무 정보 라인 운영";
const DESC_TEXT = "활동 유형 탭별로 라인을 개설하고";

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1800 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

async function verifyTab(tab, screenshotName) {
  console.log(`\n[탭=${tab}]`);
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=${ORG}&tab=${tab}`, { waitUntil: "domcontentloaded" });
  // 탭/입력 영역 렌더 대기(활동 유형 탭 또는 라인 목록).
  await page.waitForFunction("document.body.innerText.includes('라인 개설') && document.body.innerText.includes('라인 관리')", undefined, { timeout: 60000 });

  const body = await page.evaluate("document.body.innerText");

  // [1] H1 제목 제거.
  const h1Texts = await page.evaluate(`Array.from(document.querySelectorAll('h1')).map((h) => h.innerText.trim())`);
  check("[1] H1 제목 제거", !h1Texts.some((t) => t.includes(H1_TEXT)), `h1s=${JSON.stringify(h1Texts)}`);
  check("[1] 설명 문구 제거", !body.includes(DESC_TEXT));

  // [2] 현재 상황 카드 미노출 — 카드 제목 "현재 상황" 텍스트 없어야 함.
  check("[2] '현재 상황' 카드 제거", !body.includes("현재 상황"));

  // [3] 주차별 개설 결과 카드 미노출.
  check("[3] '주차별 개설 결과' 카드 제거", !body.includes("주차별 개설 결과"));

  // [4] 탭 영역 유지(라인 관리 / 라인 개설).
  check("[4] 탭 '라인 관리' 유지", body.includes("라인 관리"));
  check("[4] 탭 '라인 개설' 유지", body.includes("라인 개설"));

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", screenshotName), fullPage: true });
}

try {
  await verifyTab("manage", "browser-practical-info-sections-removed-manage.png");
  await verifyTab("open", "browser-practical-info-sections-removed-open.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-practical-info-header-removed-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
