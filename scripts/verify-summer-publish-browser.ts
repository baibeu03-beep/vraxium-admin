/**
 * 2025-summer W5~8 publish 복구 — 운영 어드민 브라우저 표시 검증 (read-only).
 *   T윤도현 Cluster3: 성장(성공) 주차·a = 30, 상태(최종)=성장 완료(졸업)
 * Usage: $env:SMOKE_BASE_URL='https://vraxium-admin.vercel.app'; npx tsx --env-file=.env.local scripts/verify-summer-publish-browser.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function makeAdminCookies(): Promise<Array<{ name: string; value: string }>> {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const domain = new URL(adminBase).hostname;
  await ctx.addCookies(cookies.map((k) => ({ ...k, domain, path: "/" })));
  const page = await ctx.newPage();
  await page.goto(
    `${adminBase}/admin/crews/encre/bf3b4305-751a-49e3-88ad-95a20e5c4dad/cluster3`,
    { waitUntil: "domcontentloaded", timeout: 90000 },
  );

  let final: string | null = null;
  let aCell: string | null = null;
  for (let i = 0; i < 40; i++) {
    try {
      const body = await page.evaluate(() => document.body.innerText);
      const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
      const at = (label: string) => {
        const idx = lines.findIndex((l) => l === label);
        return idx >= 0 ? (lines[idx + 1] ?? null) : null;
      };
      final = at("상태(최종)");
      aCell = at("성장(성공) 주차 · a");
      if (final && aCell) break;
    } catch {
      // 내비게이션 중 — 재시도
    }
    await page.waitForTimeout(1500);
  }
  console.log(`[T윤도현 Cluster3] 상태(최종)=${final} / a=${aCell}`);
  check("상태(최종)=성장 완료(졸업)", final === "성장 완료(졸업)", `실제=${final}`);
  check("성장(성공) 주차 a=30 (복구 후)", aCell === "30", `실제=${aCell}`);
  await page.screenshot({ path: "claudedocs/browser-summer-publish-restore-yoon.png", fullPage: false });
  await page.close();
  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}
void main();
