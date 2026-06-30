/**
 * /admin/week-recognitions 모드 스코프 누수 수정 — 브라우저 검증.
 *   admin 세션 쿠키 주입 후 운영/QA 페이지를 열어, 페이지가 실제 소비하는 GET 응답의
 *   user_id 집합이 운영=실사용자만 / QA=테스트 유저만 인지 확인 + 스크린샷.
 *   선행: admin :3000 · 시드 적용.
 *   npx tsx --env-file=.env.local scripts/verify-week-recog-scope-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

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
  const testIds = await fetchTestUserMarkerIds();
  const cookies = (await makeAdminCookies()).map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 2400 } });
  await context.addCookies(cookies);

  async function open(modeQS: string, tag: string) {
    const page = await context.newPage();
    let rows: any[] | null = null;
    page.on("response", async (r: any) => {
      if (r.url().includes("/api/admin/week-recognitions") && !/\/week-recognitions\/[^/?]+/.test(r.url())) {
        try { const j = await r.json(); rows = j?.data?.rows ?? j?.data?.recognitions ?? j?.data?.items ?? null; } catch {}
      }
    });
    await page.goto(`${BASE}/admin/week-recognitions${modeQS}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(9000);
    await page.screenshot({ path: `claudedocs/qa-week-recog-${tag}.png`, fullPage: true }).catch(() => {});
    await page.close();
    const ids = [...new Set((rows ?? []).map((r) => r.userId ?? r.user_id).filter(Boolean))] as string[];
    return { total: ids.length, test: ids.filter((i) => testIds.has(i)).length, real: ids.filter((i) => !testIds.has(i)).length };
  }

  try {
    const op = await open("", "operating");
    console.log("OPERATING:", JSON.stringify(op));
    check("[브라우저] 운영 week-recognitions = 실사용자만(테스트 0)", op.test === 0 && op.real > 0, op);
    const qa = await open("?mode=test", "qa");
    console.log("QA:", JSON.stringify(qa));
    check("[브라우저] QA week-recognitions = 테스트 유저만(실유저 0)", qa.real === 0 && qa.test > 0, qa);
  } finally {
    await browser.close();
  }
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
