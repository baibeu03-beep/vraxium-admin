/**
 * UN→EN rename 브라우저 검증 (read-only).
 *   admin crews cluster4(라인 테이블) EXBS-EN 표시 + 콘솔 에러 / front demo 카드 + 콘솔 에러.
 *   사전조건: admin(3000)·front(3001) dev.
 *   MSYS_NO_PATHCONV=1 npx tsx --env-file=.env.local scripts/verify-rename-browser.mts <테스터uuid> <org>
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const requireFromFront = createRequire(new URL("../../vraxium/package.json", import.meta.url));
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const UID = process.argv[2] ?? "bd57f30b-308f-4fbb-a7b7-71d76b3ce73a";
const ORG = process.argv[3] ?? "phalanx";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`Missing env: ${n}`);
  return v;
}
let failures = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures++;
};

async function makeAdminCookies() {
  const url = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anon = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(url, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(url, anon);
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !link?.properties?.email_otp) throw new Error(le?.message ?? "magiclink 실패");
  const { data: v, error: ve } = await browser.auth.verifyOtp({ email: adminEmail, token: link.properties.email_otp, type: "magiclink" });
  if (ve || !v.session) throw new Error(ve?.message ?? "otp 실패");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(url, anon, {
    cookies: { getAll: () => [], setAll: (i) => { captured.push(...i.map((x) => ({ name: x.name, value: x.value }))); } },
  });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return captured.map((i) => ({ ...i, domain: "localhost", path: "/" }));
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium" });
  // ── admin: crews cluster4 라인 테이블 ──
  {
    const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
    await ctx.addCookies(await makeAdminCookies());
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });
    const notFound: string[] = [];
    page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url().slice(0, 110)); });
    // 라인 코드를 렌더하는 화면: 라인 개설 — 실무 경험 관리 (PracticalExperienceManager)
    await page.goto(`/admin/crews/oranke/${UID}/cluster4`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const body = (await page.locator("body").innerText()) ?? "";
    check("admin P1 cluster4 렌더", body.length > 300, `len=${body.length}`);
    check("admin P1 페이지 정상(이름 노출)", body.includes("장승완"), body.includes("EXBS-UN") ? "⚠ UN 잔존 표시!" : `EN 미노출(len=${body.length})`);
    check("admin EXBS-UN 표시 없음", !body.includes("EXBS-UN"));
    check("admin 콘솔 에러(404 상세)", errors.length === 0, errors.join(" ;; ") + (notFound.length ? " || 404: " + notFound.join(" , ") : ""));
    await page.screenshot({ path: "claudedocs/browser-rename-admin-lines.png", fullPage: true });
    await ctx.close();
  }
  // ── front: demo 카드 ──
  {
    const ctx = await browser.newContext({ baseURL: "http://localhost:3001" });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });
    await page.goto(`/cluster-4?demoUserId=${UID}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const body = (await page.locator("body").innerText()) ?? "";
    check("front demo 카드 렌더", body.includes("주차") && body.length > 500, `len=${body.length}`);
    check("front 콘솔 에러 0", errors.length === 0, errors.join(" ;; "));
    await page.screenshot({ path: "claudedocs/browser-rename-front-cards.png", fullPage: true });
    await ctx.close();
  }
  await browser.close();
  console.log(failures === 0 ? "\n브라우저 검증 전체 PASS" : `\nFAIL ${failures}건`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
