/**
 * /admin/periods/register 제출 시 POST body 가 label 이 아닌 기존 value 를 보내는지 검증.
 *   npx tsx --env-file=.env.local scripts/verify-periods-register-request-value.mjs
 * 안전: POST /api/admin/season-weeks 를 route.abort() 로 가로채 서버·DB 에 도달시키지 않음.
 * season_type=winter(라벨 겨울), year=숫자, week_number=숫자 를 body 에서 확인.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
async function authCookies() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const anon = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured = [];
  const server = createServerClient(supabaseUrl, anonKey, { cookies: { getAll: () => [], setAll: (i) => captured.push(...i) } });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  let body = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    // 실제 서버/DB 도달 차단: POST body 만 캡처 후 abort.
    await page.route("**/api/admin/season-weeks", (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        body = req.postDataJSON();
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(`${baseUrl}/admin/periods/register`, { waitUntil: "networkidle" });

    const trig = (labelText) =>
      page.locator(`span:text-is("${labelText}")`).locator("xpath=..").locator('[role="combobox"]').first();
    async function pickByText(labelText, optionText) {
      const t = trig(labelText);
      await t.scrollIntoViewIfNeeded();
      await t.click();
      const lb = page.locator('[role="listbox"]').last();
      await lb.waitFor({ state: "visible", timeout: 5000 });
      const opts = lb.locator('[role="option"]');
      const n = await opts.count();
      for (let i = 0; i < n; i++) {
        if ((await opts.nth(i).innerText()).trim() === optionText) {
          await opts.nth(i).click();
          await page.waitForTimeout(100);
          return;
        }
      }
      throw new Error(`option not found: ${labelText} → ${optionText}`);
    }

    // 유효·비중복 조합: 2022 겨울 3주차 공식 활동 (+기간 선택.1/.2)
    await pickByText("기간 선택.1", "2022년");
    // 기간 선택.2: 첫 실제 후보 선택
    {
      const t = trig("기간 선택.2");
      await t.click();
      const lb = page.locator('[role="listbox"]').last();
      await lb.waitFor({ state: "visible", timeout: 5000 });
      const opts = lb.locator('[role="option"]');
      const n = await opts.count();
      for (let i = 0; i < n; i++) {
        if ((await opts.nth(i).innerText()).trim() !== "-") { await opts.nth(i).click(); break; }
      }
      await page.waitForTimeout(100);
    }
    await pickByText("연도 선택", "2022년");
    await pickByText("시즌 선택", "겨울");
    await pickByText("주차 선택", "3주차");
    await pickByText("활동 선택", "공식 활동");

    // 등록 클릭 → POST 가로채짐(abort). alert(중복 등) 시 body=null 로 남음.
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.locator('button:has-text("등록")').first().click();
    await page.waitForTimeout(1200);

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log("captured POST body:", JSON.stringify(body, null, 2));
  if (!body) {
    console.log("\nNOTE: POST 미발생(클라이언트 검증에서 중복/유효성으로 차단). 다른 조합 필요.");
    process.exit(2);
  }
  const checks = {
    "year is number, not label": typeof body.year === "number" && body.year === 2022,
    "season_type === 'winter' (value, not '겨울')": body.season_type === "winter",
    "week_number is number 3": body.week_number === 3,
    "no '겨울' string anywhere": !JSON.stringify(body).includes("겨울"),
    "no '년' suffix leaked": !JSON.stringify(body).includes("년"),
  };
  console.log("\nvalue-contract checks:");
  let ok = true;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
    if (!v) ok = false;
  }
  console.log(`\n${ok ? "PASS" : "FAIL"}: HTTP request carries original value`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
