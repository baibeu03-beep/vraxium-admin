/**
 * 프로필 원형 미리보기 크롭 튜닝용 — 6개 캐릭터 각각 선택 후 원형 영역만 확대 캡처.
 *   npx tsx --env-file=.env.local scripts/tune-line-register-profile-crop.ts
 * 출력: claudedocs/profile-crop-<index>-<key>.png (deviceScaleFactor=3)
 *       claudedocs/profile-crop-mobile.png (375px 모바일 뷰포트 전체)
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { LINE_REGISTRATION_PROFILE_KEYS } from "../lib/adminLineRegistrationsTypes";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");

  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  const cookies = captured.map((c) => ({
    name: c.name,
    value: c.value,
    domain: "localhost",
    path: "/",
  }));

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    // 데스크톱 — 원형 영역만 고배율 캡처
    const ctx = await browser.newContext({
      viewport: { width: 1380, height: 1000 },
      deviceScaleFactor: 3,
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    await page.getByLabel("소속 허브").selectOption("career");

    for (let i = 0; i < LINE_REGISTRATION_PROFILE_KEYS.length; i++) {
      const key = LINE_REGISTRATION_PROFILE_KEYS[i];
      await page.getByLabel("프로필 사진").selectOption(key);
      const circle = page.getByTestId("profile-preview-circle");
      await circle.waitFor({ state: "visible" });
      await circle.locator("img").evaluate(async (el) => {
        try {
          await (el as HTMLImageElement).decode();
        } catch {
          /* ignore */
        }
      });
      const box = (await circle.boundingBox())!;
      const safe = key.replace(/\s+/g, "_");
      await page.screenshot({
        path: `claudedocs/profile-crop-${i + 1}-${safe}.png`,
        clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 },
      });
      console.log(`saved profile-crop-${i + 1}-${safe}.png`);
    }
    await ctx.close();

    // 모바일 뷰포트 — 카드 스택 + 원형 미리보기 확인
    const mctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
    });
    await mctx.addCookies(cookies);
    const mpage = await mctx.newPage();
    await mpage.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    await mpage.getByLabel("소속 허브").selectOption("career");
    await mpage.getByLabel("프로필 사진").selectOption("토르");
    const mc = mpage.getByTestId("profile-preview-circle");
    await mc.waitFor({ state: "visible" });
    await mc.scrollIntoViewIfNeeded();
    await mpage.waitForTimeout(500);
    await mpage.screenshot({ path: "claudedocs/profile-crop-mobile.png" });
    console.log("saved profile-crop-mobile.png");
    await mctx.close();
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
