/**
 * 검증: /admin/lines/register 등록 폼에 Point.A/B 필드 통합 + 별도 대형 포인트 표 제거(무회귀).
 *   dev server 필요. npx tsx --env-file=.env.local scripts/verify-line-register-points-browser.ts
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
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1440, height: 2000 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  for (const url of [`${BASE}/admin/lines/register`, `${BASE}/admin/lines/register?tab=register`]) {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2500);
    const label = url.includes("tab=register") ? "[?tab=register]" : "[/register]";
    ck(`${label} 200`, resp?.status() === 200, { status: resp?.status() });
  }

  // 마지막 로드(?tab=register) 기준 폼 검증.
  const body = await page.evaluate(() => document.body.innerText);
  ck("기존 라인 등록 폼 유지", /라인 등록/.test(body) && !!(await page.$('input')));
  ck("기존 필드(라인명·라인 코드·등록 버튼)", /라인명/.test(body) && /라인 코드/.test(body) && /등록/.test(body));

  // 별도 대형 포인트 표 제거 확인.
  ck("별도 '강화 시 포인트 설정' 카드 없음", !/강화 시 포인트 설정/.test(body));
  ck("data-point-hub 제거", !(await page.$("[data-point-hub]")));
  ck("data-point-config-key 제거", !(await page.$("[data-point-config-key]")));
  ck("data-point-input 제거", !(await page.$("[data-point-input]")));

  // 등록 폼 내부 Point.A/B 필드 존재.
  ck("폼 내부 강화 시 포인트 섹션", !!(await page.$("[data-point-fields]")));
  ck("Point.A select", !!(await page.$("[data-point-a]")));
  ck("Point.B select", !!(await page.$("[data-point-b]")));
  const aOpts = await page.$$eval("[data-point-a] option", (els: any[]) => els.map((e) => e.value));
  ck("Point.A 0~20 + 미설정", aOpts.length === 22 && aOpts.includes("") && aOpts.includes("0") && aOpts.includes("20"), { count: aOpts.length });

  // 허브=info 선택 → 활동유형 select 노출(config_key=activity_types.id).
  await page.selectOption('select[aria-label="소속 허브"]', "info");
  await page.waitForTimeout(300);
  ck("info 선택 시 활동유형 select 노출", !!(await page.$("[data-point-activity-type]")));
  const atOpts = await page.$$eval("[data-point-activity-type] option", (els: any[]) => els.map((e) => e.value));
  ck("활동유형 = activity_types.id(wisdom 등)", atOpts.includes("wisdom") && atOpts.includes("essay") && atOpts.includes("etc_a"), { atOpts });

  // 허브=career 선택 → Point 비활성.
  await page.selectOption('select[aria-label="소속 허브"]', "career");
  await page.waitForTimeout(300);
  const aDisabledCareer = await page.$eval("[data-point-a]", (el: any) => el.disabled);
  ck("career 선택 시 Point 비활성", aDisabledCareer === true);
  ck("info 활동유형 select 는 career 에서 숨김", !(await page.$("[data-point-activity-type]")));

  // 레이아웃 오버플로 없음(3 폭).
  for (const w of [1440, 1280, 1024]) {
    await page.setViewportSize({ width: w, height: 1600 });
    await page.waitForTimeout(150);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck(`@${w} 가로 오버플로 없음`, ov <= 2, { ov });
  }

  await page.setViewportSize({ width: 1440, height: 2000 });
  await page.selectOption('select[aria-label="소속 허브"]', "info");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "claudedocs/qa-line-register-points-1440.png", fullPage: false });
  await (await page.context()).browser()?.close();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
