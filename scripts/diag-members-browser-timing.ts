// 임시 진단: /admin/members 브라우저 end-to-end 로딩 시간.
//   cold compile / warm load / API 시간 / 렌더 시간 / page1->page2 분리 측정.
//   npx tsx --env-file=.env.local scripts/diag-members-browser-timing.ts
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function makeAdminCookies() {
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (error) throw error;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp && !linkError, linkError?.message ?? "generateLink failed");
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session && !verifyError, verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const,
  }));
}

// 첫 데이터 행(이동 버튼 보유 tr)이 보일 때까지 폴링 → 표가 실제로 보이는 시각(ms).
async function waitTableVisible(page: import("playwright-core").Page, timeoutMs = 60_000): Promise<number> {
  const start = Date.now();
  const row = page.locator("tbody tr").filter({ has: page.locator("button") }).first();
  await row.waitFor({ state: "visible", timeout: timeoutMs });
  return Date.now() - start;
}

type ApiHit = { url: string; ms: number };

// 벽시계 기준 요청→응답 시간(Date.now()) — req.timing() 오프셋 해석 이슈 회피.
function trackRoster(page: import("playwright-core").Page) {
  const hits: ApiHit[] = [];
  const startAt = new WeakMap<object, number>();
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/api/admin/members/roster")) startAt.set(req, Date.now());
  });
  page.on("response", (res) => {
    const req = res.request();
    const s = startAt.get(req);
    if (s == null) return;
    const u = new URL(req.url());
    hits.push({ url: u.pathname + u.search, ms: Date.now() - s });
  });
  return hits;
}

function trackAll(page: import("playwright-core").Page) {
  const hits: ApiHit[] = [];
  const startAt = new WeakMap<object, number>();
  page.on("request", (req) => startAt.set(req, Date.now()));
  page.on("response", (res) => {
    const req = res.request();
    const s = startAt.get(req);
    if (s == null) return;
    hits.push({ url: new URL(req.url()).pathname, ms: Date.now() - s });
  });
  return hits;
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  const allHits = trackAll(page);
  const rosterHits = trackRoster(page);

  try {
    // ── COLD: 첫 진입(라우트 컴파일 + API + 렌더 포함) ──
    const coldStart = Date.now();
    await page.goto(`${baseUrl}/admin/members`, { waitUntil: "domcontentloaded" });
    const domLoaded = Date.now() - coldStart;
    const coldRowMs = await waitTableVisible(page);
    const coldTotal = Date.now() - coldStart;
    const coldApi = rosterHits.at(-1)?.ms ?? null;
    console.log("\n===== COLD (첫 진입: dev 컴파일 포함) =====");
    console.log(`  goto→domcontentloaded : ${domLoaded}ms`);
    console.log(`  표(첫 데이터행) 보일 때까지 총: ${coldTotal}ms`);
    console.log(`  roster API(서버 처리, 브라우저 timing): ${coldApi ?? "?"}ms`);

    // ── WARM: 같은 페이지 reload(컴파일 완료 상태) ──
    rosterHits.length = 0;
    const warmStart = Date.now();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitTableVisible(page);
    const warmTotal = Date.now() - warmStart;
    const warmApi = rosterHits.at(-1)?.ms ?? null;
    const warmRender = warmApi != null ? warmTotal - warmApi : null;
    console.log("\n===== WARM (reload: 컴파일 완료) =====");
    console.log(`  표 보일 때까지 총: ${warmTotal}ms`);
    console.log(`  roster API: ${warmApi ?? "?"}ms`);
    console.log(`  대략 렌더+오버헤드(총-API): ${warmRender ?? "?"}ms`);

    // ── WARM #2 (한 번 더, 안정값) ──
    rosterHits.length = 0;
    const warm2Start = Date.now();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitTableVisible(page);
    const warm2Total = Date.now() - warm2Start;
    console.log(`  WARM #2 표 보일 때까지: ${warm2Total}ms (API ${rosterHits.at(-1)?.ms ?? "?"}ms)`);

    // ── page 1 → page 2 ──
    rosterHits.length = 0;
    const firstRowTextBefore = await page.locator("tbody tr").filter({ has: page.locator("button") }).first().innerText().catch(() => "");
    const nextBtn = page.getByRole("button", { name: "다음" });
    const pageStart = Date.now();
    await nextBtn.click();
    // 행 내용이 바뀔 때까지 대기(같은 첫 행 텍스트가 사라질 때까지) — 최대 30s.
    await page.waitForFunction(
      (before) => {
        const rows = Array.from(document.querySelectorAll("tbody tr")).filter((r) => r.querySelector("button"));
        const first = rows[0]?.textContent ?? "";
        return first !== "" && first !== before;
      },
      firstRowTextBefore,
      { timeout: 30_000 },
    ).catch(() => undefined);
    const pageNavMs = Date.now() - pageStart;
    console.log("\n===== page 1 → page 2 =====");
    console.log(`  이동 클릭→행 갱신: ${pageNavMs}ms (roster API ${rosterHits.at(-1)?.ms ?? "?"}ms)`);

    // ── 네트워크: 가장 느린 요청 TOP 8 ──
    console.log("\n===== 네트워크 느린 요청 TOP 8 (전체 세션) =====");
    const top = [...allHits].sort((a, b) => b.ms - a.ms).slice(0, 8);
    for (const h of top) console.log(`  ${h.ms}ms  ${h.url}`);
  } finally {
    await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
