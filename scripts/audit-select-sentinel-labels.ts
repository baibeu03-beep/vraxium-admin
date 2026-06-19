/**
 * 브라우저 전수 감사 — 어드민 페이지의 Select 트리거(data-slot="select-value")가
 * 내부 sentinel 값(__all__ 등)을 그대로 렌더링하는지 점검(닫힌 상태).
 *   dev 서버 가동 후: npx tsx --env-file=.env.local scripts/audit-select-sentinel-labels.ts
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

const SENTINELS = ["__all__", "__none__", "all", "all_orgs", "all_parts", "all_teams"];

const PAGES = [
  "/admin/weekly-card-finalization",
  "/admin/users/admin-users",
  "/admin/users/app-users",
  "/admin/users/applicants",
  "/admin/settings/accounts",
  "/admin/settings/permissions",
  "/admin/week-recognitions",
  "/admin/season-participations",
  "/admin/crews",
  "/admin/members",
  "/admin/test-users",
  "/admin/line-opening/practical-info",
  "/admin/line-opening/practical-competency",
  "/admin/line-opening/practical-experience",
  "/admin/line-opening/practical-career",
];

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

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  let totalLeaks = 0;
  try {
    for (const path of PAGES) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.waitForTimeout(2500);
      const texts: string[] = await page.$$eval('[data-slot="select-value"]', (els) =>
        els.map((e) => (e.textContent ?? "").trim()),
      );
      const leaks = texts.filter((t) => SENTINELS.includes(t));
      const status = leaks.length ? `❌ LEAK ${JSON.stringify(leaks)}` : `✅ clean (selects=${texts.length})`;
      console.log(`${status}\t${path}`);
      totalLeaks += leaks.length;
    }
  } finally {
    await browser.close();
  }
  console.log(`\n총 누수 트리거: ${totalLeaks}개  → ${totalLeaks === 0 ? "PASS ✅" : "FAIL ❌"}`);
  if (totalLeaks > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
