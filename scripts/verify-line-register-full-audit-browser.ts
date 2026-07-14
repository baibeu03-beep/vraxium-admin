/**
 * 전수 감사: /admin/lines/register 등록 폼의 모든 기존 필드 + Point.A/B 통합 + 탭 왕복 유지 + 별도 표 부재.
 *   dev server 필요. npx tsx --env-file=.env.local scripts/verify-line-register-full-audit-browser.ts
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

async function auditForm(page: any, label: string) {
  const body = await page.evaluate(() => document.body.innerText);
  // 기존 필드.
  for (const t of ["라인명", "소속 허브", "라인 종류", "라인 코드", "유닛 링크", "메인 타이틀", "실무 경력"]) {
    ck(`${label} 필드 '${t}'`, body.includes(t));
  }
  ck(`${label} '등록' 버튼`, await page.getByRole("button", { name: "등록", exact: true }).first().isVisible().catch(() => false));
  ck(`${label} '초기화' 버튼`, await page.getByRole("button", { name: "초기화", exact: true }).first().isVisible().catch(() => false));
  // Point.A/B 통합.
  ck(`${label} [data-point-fields]`, !!(await page.$("[data-point-fields]")));
  ck(`${label} [data-point-a]`, !!(await page.$("[data-point-a]")));
  ck(`${label} [data-point-b]`, !!(await page.$("[data-point-b]")));
  ck(`${label} 강화 시 포인트 문구`, body.includes("강화 시 포인트"));
  const aOpts = await page.$$eval("[data-point-a] option", (els: any[]) => els.length);
  ck(`${label} Point.A 0~20+미설정(22)`, aOpts === 22, { aOpts });
  // 별도 대형 표 부재.
  ck(`${label} 별도 '강화 시 포인트 설정' 카드 없음`, !body.includes("강화 시 포인트 설정"));
  ck(`${label} [data-point-hub] 없음`, !(await page.$("[data-point-hub]")));
  ck(`${label} [data-point-config-key] 없음`, !(await page.$("[data-point-config-key]")));
}

async function main() {
  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1440, height: 1800 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();

  const urls = ["/admin/lines/register", "/admin/lines/register?tab=register", "/admin/lines/register?org=encre", "/admin/lines/register?org=encre&mode=test"];
  for (const path of urls) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(1200);
    await auditForm(page, `[${path}]`);
    const shot = "claudedocs/qa-lines-register-audit-" + (path.includes("test") ? "encre-test" : path.includes("encre") ? "encre" : path.includes("tab") ? "tab" : "bare") + ".png";
    await page.screenshot({ path: shot, fullPage: false });
  }

  // 탭 왕복 후 Point.A/B 유지 검증(org=encre).
  await page.goto(`${BASE}/admin/lines/register?org=encre`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(1000);
  ck("[왕복] 초기 Point.A 존재", !!(await page.$("[data-point-a]")));
  await page.getByRole("link", { name: "라인 정보", exact: true }).first().click();
  await page.waitForTimeout(1200);
  ck("[왕복] 정보 탭에서 Point.A 없음(등록 폼 아님)", !(await page.$("[data-point-a]")));
  await page.getByRole("link", { name: "라인 등록", exact: true }).first().click();
  await page.waitForTimeout(1200);
  ck("[왕복] 복귀 후 Point.A 재존재", !!(await page.$("[data-point-a]")));
  ck("[왕복] 복귀 후 Point.B 재존재", !!(await page.$("[data-point-b]")));
  const aOpts2 = await page.$$eval("[data-point-a] option", (els: any[]) => els.length);
  ck("[왕복] 복귀 후 Point.A 옵션 22 유지", aOpts2 === 22, { aOpts2 });

  await ctx.browser()?.close();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
