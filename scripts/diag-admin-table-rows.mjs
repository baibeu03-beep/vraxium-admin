// admin season-weeks 테이블 행 텍스트 덤프 (행 추출 포맷 확인용)
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
const adminEmail = "vanuatu.golden@gmail.com";

async function makeAdminCookies() {
  const supabaseUrl = get("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, get("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "vraxium-admin.vercel.app",
    path: "/", httpOnly: false, secure: true, sameSite: "Lax",
  }));
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1800 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto("https://vraxium-admin.vercel.app/admin/season-weeks", { waitUntil: "domcontentloaded" });
await page.waitForFunction("document.body.innerText.includes('공식 휴식')", undefined, { timeout: 60000 });
await page.waitForTimeout(1500);
const rows = await page.evaluate(`(() => {
  const out = [];
  for (const tr of document.querySelectorAll('tr')) {
    const t = tr.innerText.replace(/\\n/g, ' | ').trim();
    if (t.includes('주차')) out.push(t);
  }
  return out;
})()`);
console.log(`tr rows containing 주차: ${rows.length}`);
for (const r of rows) console.log("  " + r);
await browser.close();
