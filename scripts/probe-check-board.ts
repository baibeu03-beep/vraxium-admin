import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const g = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = "http://localhost:3000";
const SUPABASE_URL = g("NEXT_PUBLIC_SUPABASE_URL")!;
const ANON = g("NEXT_PUBLIC_SUPABASE_ANON_KEY")!;
const SERVICE = g("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
  const anon = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await anon.auth.verifyOtp({ email: adminEmail, token: (link as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const srv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const }));
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext();
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  for (const hub of ["club", "info", "experience", "competency"]) {
    await page.goto(`${BASE}/admin/processes/check/${hub}?org=encre&mode=test`, { waitUntil: "domcontentloaded" });
    const board = await page.evaluate(async (qs) => (await fetch(`/api/admin/processes/check?${qs}`)).json(), `hub=${hub}&org=encre&mode=test`);
    const acts = board?.data?.acts ?? [];
    const week = board?.data?.week ?? board?.data?.selectedWeekId ?? null;
    const summary = acts.map((a: any) => ({ actName: a.actName, isCheckTarget: a.isCheckTarget, status: a.status, hasLG: Boolean(a.lineGroupId), checkStatusId: a.checkStatusId }));
    console.log(`\n=== hub=${hub} week=`, JSON.stringify(week), `acts=${acts.length}`);
    console.log(JSON.stringify(summary, null, 1));
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
