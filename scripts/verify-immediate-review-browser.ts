/**
 * 브라우저(인증) — 통합 검증:
 *   1) 프로세스 체크 하위 페이지에 '즉시 검수' 컬럼 노출(club/info/competency/irregular)
 *   2) /admin/automation 미노출(404)
 *   3) 라인 개설 화면에 '지금 판정' 버튼 삭제됨
 *   스크린샷: claudedocs/immediate-review-*.png
 *
 *   npx tsx --env-file=.env.local scripts/verify-immediate-review-browser.ts
 */
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
const gg = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const URL = gg("NEXT_PUBLIC_SUPABASE_URL")!, ANON = gg("NEXT_PUBLIC_SUPABASE_ANON_KEY")!, SERVICE = gg("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL, SERVICE);
const SHOT = resolve(adminRoot, "claudedocs");

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookies() {
  const anon = createClient(URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await anon.auth.verifyOtp({ email: adminEmail, token: (link as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const }));
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
  await context.addCookies(await cookies());
  const page = await context.newPage();
  try {
    // 1) 프로세스 체크 하위 페이지 '즉시 검수' 컬럼.
    console.log("\n[1] 프로세스 체크 하위 페이지 '즉시 검수' 컬럼");
    for (const hub of ["club", "info", "competency"]) {
      await page.goto(`${BASE}/admin/processes/check/${hub}?org=encre&mode=test`, { waitUntil: "domcontentloaded" });
      let ok = false;
      try { await page.getByRole("columnheader", { name: "즉시 검수" }).first().waitFor({ state: "visible", timeout: 30_000 }); ok = true; } catch { ok = false; }
      ck(`[1] ${hub}: '즉시 검수' 컬럼 노출`, ok);
      if (hub === "club") await page.screenshot({ path: resolve(SHOT, "immediate-review-club.png"), fullPage: true }).catch(() => {});
    }
    // irregular — 컬럼 or 빈 목록(로드 성공).
    await page.goto(`${BASE}/admin/processes/check/irregular?org=encre&mode=test`, { waitUntil: "domcontentloaded" });
    let irrOk = false;
    try {
      await Promise.race([
        page.getByRole("columnheader", { name: "즉시 검수" }).first().waitFor({ state: "visible", timeout: 30_000 }),
        page.getByText("변동 액트가 없습니다").first().waitFor({ state: "visible", timeout: 30_000 }),
      ]);
      irrOk = true;
    } catch { irrOk = false; }
    const irrCol = await page.getByRole("columnheader", { name: "즉시 검수" }).count();
    ck("[1] irregular: 페이지 로드(즉시 검수 컬럼 or 빈 목록)", irrOk, `컬럼=${irrCol}`);

    // 2) /admin/automation 미노출.
    console.log("\n[2] /admin/automation 미노출");
    const resp = await page.goto(`${BASE}/admin/automation`, { waitUntil: "domcontentloaded" });
    const notFound = (resp?.status() ?? 0) === 404 || (await page.getByText(/404|찾을 수 없|not found/i).count()) > 0;
    ck("[2] /admin/automation 404/미노출", notFound, `status=${resp?.status()}`);
    ck("[2] 사이드바 '자동화 관리' 항목 없음", (await page.getByText("자동화 관리").count()) === 0);

    // 3) 라인 개설 화면 '지금 판정' 삭제.
    console.log("\n[3] 라인 개설 '지금 판정' 삭제");
    for (const hub of ["practical-experience", "practical-info"]) {
      await page.goto(`${BASE}/admin/line-opening/${hub}?org=encre&mode=test`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      ck(`[3] ${hub}: '지금 판정' 버튼 없음`, (await page.getByRole("button", { name: "지금 판정" }).count()) === 0);
    }
  } catch (e: any) {
    console.error("browser error:", e?.stack ?? e?.message ?? e); fail++;
  } finally {
    await browser.close();
  }
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
