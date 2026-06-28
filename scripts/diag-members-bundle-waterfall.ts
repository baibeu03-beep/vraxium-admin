// 진단(prod): /admin/members 콜드 로드 워터폴 + 실제 전송 JS 번들 크기.
//   - TTFB(함수 콜드/SSR) · 전송 JS 합계/청크 TOP · 하이드레이션→roster fetch 시작 · roster API · table-visible
//   BASE=https://vraxium-admin.vercel.app npx tsx --env-file=.env.local scripts/diag-members-bundle-waterfall.ts
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
  return captured.map(({ name, value }) => ({ name, value, url: baseUrl }));
}

async function waitTableVisible(page: import("playwright-core").Page, timeoutMs = 60_000): Promise<number> {
  const start = Date.now();
  await page.locator("tbody tr").filter({ has: page.locator("button") }).first().waitFor({ state: "visible", timeout: timeoutMs });
  return Date.now() - start;
}

async function run(label: string, page: import("playwright-core").Page, navStart: () => Promise<void>) {
  const js: { url: string; bytes: number }[] = [];
  let firstRosterAt: number | null = null;
  let rosterMs: number | null = null;
  let ttfb: number | null = null;
  const rosterStart = new WeakMap<object, number>();
  const t0 = Date.now();

  const onResponse = async (res: import("playwright-core").Response) => {
    const req = res.request();
    const path = new URL(req.url()).pathname;
    if (req.resourceType() === "document" && ttfb == null) {
      const t = res.request().timing();
      ttfb = t.responseStart > 0 ? Math.round(t.responseStart) : null;
    }
    if (req.resourceType() === "script" || path.endsWith(".js")) {
      const len = Number(res.headers()["content-length"] ?? 0)
        || await res.body().then((b) => b.length).catch(() => 0);
      js.push({ url: path, bytes: len });
    }
    if (path.startsWith("/api/admin/members/roster")) {
      const s = rosterStart.get(req);
      if (s != null) rosterMs = Date.now() - s;
    }
  };
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/api/admin/members/roster")) {
      rosterStart.set(req, Date.now());
      if (firstRosterAt == null) firstRosterAt = Date.now() - t0;
    }
  });
  page.on("response", onResponse);

  await navStart();
  const tableMs = await waitTableVisible(page);
  await page.waitForTimeout(500); // 늦게 끝나는 청크 응답 수집 여유
  page.off("response", onResponse);

  const totalJs = js.reduce((s, x) => s + x.bytes, 0);
  const byChunk = [...js].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  console.log(`\n===== ${label} =====`);
  console.log(`  TTFB(document, 함수/SSR): ${ttfb ?? "?"}ms`);
  console.log(`  table-visible(총): ${tableMs}ms`);
  console.log(`  roster fetch 시작(하이드레이션 후): ${firstRosterAt ?? "?"}ms  ·  roster API: ${rosterMs ?? "?"}ms`);
  console.log(`  전송 JS 합계: ${(totalJs / 1024).toFixed(1)}KB (${js.length} files)`);
  for (const c of byChunk) console.log(`    ${(c.bytes / 1024).toFixed(1)}KB  ${c.url}`);
}

async function main() {
  console.log(`BASE=${baseUrl}`);
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  try {
    // COLD: 캐시 비활성(빈 컨텍스트 첫 진입 = 콜드).
    await run("COLD (uncached 첫 진입)", page, async () => {
      await page.goto(`${baseUrl}/admin/members`, { waitUntil: "domcontentloaded" });
    });
    // WARM: reload(디스크 캐시 사용).
    await run("WARM (reload, 캐시)", page, async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
    });
  } finally {
    await browser.close();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
