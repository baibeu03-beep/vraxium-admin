/**
 * QA roster 브라우저 검증 — /admin/members 크루 목록(운영/QA) 렌더 + 상단 카운트.
 *   admin 세션 쿠키를 주입해 페이지를 열고, roster API 응답과 화면 렌더(상단 활동/휴식/중단,
 *   표 행 수)가 일치하는지 확인한다.
 *   선행: admin :3000 · 시드 적용.
 *   npx tsx --env-file=.env.local scripts/verify-qa-roster-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
let failed = 0;
function check(n: string, ok: boolean, d?: unknown) { console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`); if (!ok) failed++; }

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (admins?.[0] as any)?.email; if (!email) throw new Error("no admin email");
  const admin = createClient(supabaseUrl, serviceKey), anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: verified } = await anon.auth.verifyOtp({ email, token: (link as any).properties.email_otp, type: "magiclink" });
  const captured: any[] = [];
  const server = createServerClient(supabaseUrl, anonKey, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }: any) => ({ name, value }))) } });
  await server.auth.setSession({ access_token: (verified as any).session.access_token, refresh_token: (verified as any).session.refresh_token });
  return captured;
}

async function main() {
  const pwMod: any = await import(pathToFileURL(resolve(process.cwd(), "../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pwMod.chromium ?? pwMod.default?.chromium;
  const cookies = (await makeAdminCookies()).map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 2400 } });
  await context.addCookies(cookies);

  async function openRoster(modeQS: string, tag: string) {
    const page = await context.newPage();
    let api: any = null;
    page.on("response", async (r: any) => {
      if (r.url().includes("/api/admin/members/roster")) { try { const j = await r.json(); api = j?.data ?? j; } catch {} }
    });
    await page.goto(`${BASE}/admin/members${modeQS}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(10000);
    const text: string = await page.evaluate(() => document.body.innerText);
    const m = (re: RegExp) => { const x = text.match(re); return x ? Number(x[1].replace(/,/g, "")) : null; };
    const rendered = { active: m(/활동\s*([\d,]+)/), rest: m(/휴식\s*([\d,]+)/), stopped: m(/중단\s*([\d,]+)/) };
    // 표 행 수(대략) — tbody tr.
    const rows: number = await page.evaluate(() => document.querySelectorAll("table tbody tr").length);
    await page.screenshot({ path: `claudedocs/qa-roster-${tag}.png`, fullPage: true }).catch(() => {});
    await page.close();
    return { api, rendered, rows };
  }

  try {
    const op = await openRoster("", "operating");
    console.log("OPERATING api:", JSON.stringify({ total: op.api?.total, counts: op.api?.statusCounts }), "| rendered:", JSON.stringify(op.rendered), "| rows:", op.rows);
    check("[브라우저] 운영 상단 활동=201(실유저)", op.rendered.active === 201, op.rendered);
    check("[브라우저] 운영 API total=318", op.api?.total === 318);
    check("[브라우저] 운영 표 행 렌더(>0)", op.rows > 0, { rows: op.rows });

    const qa = await openRoster("?mode=test", "qa");
    console.log("QA api:", JSON.stringify({ total: qa.api?.total, counts: qa.api?.statusCounts }), "| rendered:", JSON.stringify(qa.rendered), "| rows:", qa.rows);
    check("[브라우저] QA 상단 활동=82·휴식=9", qa.rendered.active === 82 && qa.rendered.rest === 9, qa.rendered);
    check("[브라우저] QA API total=91(테스트 크루)", qa.api?.total === 91);
    check("[브라우저] QA 표 행 렌더(>0)", qa.rows > 0, { rows: qa.rows });
    check("[브라우저] API==렌더(QA 활동)", qa.api?.statusCounts?.active === qa.rendered.active);
  } finally {
    await browser.close();
  }
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
