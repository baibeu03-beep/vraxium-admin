/**
 * 검증: /admin/lines 두 탭(라인 정보/라인 등록)이 양방향으로 실제 전환되는지.
 *   dev server 필요. npx tsx --env-file=.env.local scripts/verify-lines-tab-nav-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => { console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`); if (!ok) failed++; };

async function cookies_() {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

async function main() {
  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1440, height: 1600 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();

  const hasRegisterForm = () => page.locator("[data-point-fields]").first().isVisible().catch(() => false);
  const infoListVisible = async () => (await page.evaluate(() => document.body.innerText)).includes("결과 수");
  const clickTab = async (label: string) => {
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await page.waitForTimeout(1200);
  };

  // ── (A) 조직 지정: register → 라인 정보 → 라인 등록 왕복 ──
  await page.goto(`${BASE}/admin/lines/register?org=encre`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(1500);
  ck("[encre] 진입 시 등록 폼", await hasRegisterForm());

  await clickTab("라인 정보");
  ck("[encre] '라인 정보' 클릭 → URL tab=info", page.url().includes("tab=info"), { url: page.url() });
  ck("[encre] '라인 정보' → 정보 목록 표시", await infoListVisible());
  ck("[encre] '라인 정보' → 등록 폼 사라짐", !(await hasRegisterForm()));
  ck("[encre] org 보존", page.url().includes("org=encre"));

  await clickTab("라인 등록");
  ck("[encre] '라인 등록' 클릭 → URL tab=register", page.url().includes("tab=register"), { url: page.url() });
  ck("[encre] '라인 등록' → 등록 폼 복귀", await hasRegisterForm());

  // ── (B) 조직 미지정(통합): register → 라인 정보 → 안내(빈 화면 아님) → 라인 등록 ──
  await page.goto(`${BASE}/admin/lines/register`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(1200);
  ck("[통합] 진입 시 등록 폼", await hasRegisterForm());
  await clickTab("라인 정보");
  ck("[통합] '라인 정보' 클릭 → tab=info", page.url().includes("tab=info"), { url: page.url() });
  const body = await page.evaluate(() => document.body.innerText);
  ck("[통합] '라인 정보' → 빈 화면 아님(안내 노출)", /클럽을 선택하면|결과 수/.test(body));
  ck("[통합] '라인 정보' → 등록 폼 사라짐", !(await hasRegisterForm()));
  await clickTab("라인 등록");
  ck("[통합] '라인 등록' → 등록 폼 복귀", await hasRegisterForm());

  // ── (C) /admin/lines/info 진입 시 기본 정보 탭 ──
  await page.goto(`${BASE}/admin/lines/info`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(1500);
  ck("[/info] 기본 진입 = 정보 목록", await infoListVisible());
  await clickTab("라인 등록");
  ck("[/info] '라인 등록' 클릭 → 등록 폼", await hasRegisterForm());

  await ctx.browser()?.close();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
