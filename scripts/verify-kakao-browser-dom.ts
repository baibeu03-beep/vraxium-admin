/**
 * 브라우저 DOM 검증 — /admin/users/app-users 운영/테스트 모드에서 7명 이름이
 * 실제 화면 표에 노출되는지 확인(테스트 ON/OFF 전환).
 *   dev 서버 가동 후: npx tsx --env-file=.env.local scripts/verify-kakao-browser-dom.ts
 * READ-ONLY.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const NAMES = ["T임시우", "T황민서", "T조예린", "T임다인", "T장소율", "T정하은", "T정시현"];

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp, "generateLink failed");
  const { data: verified } = await anon.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  assert(verified.session, "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({ access_token: verified.session.access_token, refresh_token: verified.session.refresh_token });
  return captured.map(({ name, value }) => ({ name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const }));
}

async function namesOnPage(page: import("playwright-core").Page, url: string): Promise<Set<string>> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const body = await page.locator("body").innerText();
  return new Set(NAMES.filter((n) => body.includes(n)));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  try {
    const opSeen = await namesOnPage(page, `${baseUrl}/admin/users/app-users`);          // 운영(OFF)
    const testSeen = await namesOnPage(page, `${baseUrl}/admin/users/app-users?mode=test`); // 테스트(ON)
    console.log(`\n사용자\t\t운영 화면(없어야)\t테스트 화면(보여야)\t판정`);
    let allPass = true;
    for (const n of NAMES) {
      const opOut = !opSeen.has(n);
      const testIn = testSeen.has(n);
      const pass = opOut && testIn;
      if (!pass) allPass = false;
      console.log(`${n}\t 운영=${opOut ? "없음✅" : "노출❌"}\t 테스트=${testIn ? "보임✅" : "누락❌"}\t→ ${pass ? "PASS" : "FAIL"}`);
    }
    console.log(`\n전체(브라우저 DOM): ${allPass ? "PASS ✅" : "FAIL ❌"}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
