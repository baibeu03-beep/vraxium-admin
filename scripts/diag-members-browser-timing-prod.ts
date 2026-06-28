// 진단(prod): /admin/members 브라우저 end-to-end 로딩 시간 — 배포 URL 기준.
//   표(첫 데이터행) 보일 때까지 cold/warm + roster API 시간 분리.
//   BASE=https://vraxium-admin.vercel.app npx tsx --env-file=.env.local scripts/diag-members-browser-timing-prod.ts
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.BASE ?? "https://vraxium-admin.vercel.app";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: verified } = await anon.auth.verifyOtp({ email, token: link!.properties!.email_otp, type: "magiclink" });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified!.session!.access_token,
    refresh_token: verified!.session!.refresh_token,
  });
  // prod: url 바인딩 쿠키(secure 자동) — 도메인/secure 수동 지정 회피.
  return captured.map(({ name, value }) => ({ name, value, url: baseUrl }));
}

async function waitTableVisible(page: import("playwright-core").Page, timeoutMs = 60_000): Promise<number> {
  const start = Date.now();
  const row = page.locator("tbody tr").filter({ has: page.locator("button") }).first();
  await row.waitFor({ state: "visible", timeout: timeoutMs });
  return Date.now() - start;
}

function trackRoster(page: import("playwright-core").Page) {
  const hits: { ms: number }[] = [];
  const startAt = new WeakMap<object, number>();
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/api/admin/members/roster")) startAt.set(req, Date.now());
  });
  page.on("response", (res) => {
    const s = startAt.get(res.request());
    if (s != null) hits.push({ ms: Date.now() - s });
  });
  return hits;
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  const rosterHits = trackRoster(page);

  try {
    console.log(`BASE=${baseUrl}`);
    // COLD: 첫 진입
    const coldStart = Date.now();
    await page.goto(`${baseUrl}/admin/members`, { waitUntil: "domcontentloaded" });
    const coldTotal = await waitTableVisible(page).then((m) => m + (Date.now() - coldStart - m));
    const coldApi = rosterHits.at(-1)?.ms ?? null;
    console.log(`COLD  표 보일 때까지=${coldTotal}ms  roster API=${coldApi ?? "?"}ms`);

    // WARM x2
    for (let i = 1; i <= 2; i++) {
      rosterHits.length = 0;
      const s = Date.now();
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitTableVisible(page);
      const total = Date.now() - s;
      const api = rosterHits.at(-1)?.ms ?? null;
      console.log(`WARM${i} 표 보일 때까지=${total}ms  roster API=${api ?? "?"}ms  렌더+오버헤드(총-API)=${api != null ? total - api : "?"}ms`);
    }
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
