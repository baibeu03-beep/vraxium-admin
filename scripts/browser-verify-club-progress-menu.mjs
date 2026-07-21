/**
 * 브라우저 UI 검증 — 개별(org) 페이지 "클럽 진행 > 팀 내역 / 시즌 내역" 메뉴 복구·추가.
 *   · 개별 모드 사이드바(클럽 진행) 자식: 팀 내역(현재 org 1개) · 시즌 내역 · 주차 내역.
 *   · 팀 내역 클릭 → /admin/team-parts/info/{org}?org={org} 상세(실제 클럽명·[개별] 유지·메뉴 활성).
 *   · 시즌 내역 클릭 → /admin/team-parts/info/seasons(200·시즌 내역만 활성·팀 내역 비활성).
 *   사전조건: dev :3000. Usage: node scripts/browser-verify-club-progress-menu.mjs  (READ-ONLY)
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
let chromium;
try { ({ chromium } = rq("playwright-core")); } catch { ({ chromium } = rq("playwright")); }
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");

const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

const SUBMENU_ID = "submenu-/admin/team-parts/info";
const KO = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };

async function cookies() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin 세션: ${email}`);
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

// 사이드바 클럽 진행 submenu 안의 링크(라벨 → {href, active}) 맵.
async function submenuLinks(page) {
  return page.$$eval(`ul[id="${SUBMENU_ID}"] a`, (as) =>
    as.map((a) => ({
      label: a.textContent.trim(),
      href: a.getAttribute("href"),
      active: a.getAttribute("aria-current") === "page",
    })),
  );
}
const modeBadge = (page) =>
  page.$$eval("span", (ss) => {
    const b = ss.find((s) => s.textContent.trim() === "개별" || s.textContent.trim() === "통합");
    return b ? b.textContent.trim() : null;
  });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.addCookies(await cookies());
  const page = await context.newPage();
  try {
    for (const org of ["encre", "oranke", "phalanx"]) {
      console.log(`\n[${org}] 개별 페이지 진입(/admin/crews/${org})`);
      await page.goto(`${BASE}/admin/crews/${org}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`ul[id="${SUBMENU_ID}"]`, { timeout: 25000 }).catch(() => {});

      const badge = await modeBadge(page);
      ck(`[${org}] 사이드바 [개별] 배지`, badge === "개별", `badge=${badge}`);

      const links = await submenuLinks(page);
      const labels = links.map((l) => l.label);
      ck(`[${org}] 클럽 진행 > 팀 내역 노출`, labels.filter((l) => l === "팀 내역").length === 1, `labels=[${labels.join(", ")}]`);
      ck(`[${org}] 클럽 진행 > 시즌 내역 노출`, labels.includes("시즌 내역"));
      ck(`[${org}] 클럽 진행 > 주차 내역 노출`, labels.includes("주차 내역"));

      const team = links.find((l) => l.label === "팀 내역");
      ck(`[${org}] 팀 내역 href = /admin/team-parts/info/${org}?org=${org}`,
        team?.href === `/admin/team-parts/info/${org}?org=${org}`, `href=${team?.href}`);

      // ── 팀 내역 클릭 → 상세 ──
      await Promise.all([
        page.waitForURL(`**/admin/team-parts/info/${org}?org=${org}`, { timeout: 25000 }).catch(() => {}),
        page.click(`ul[id="${SUBMENU_ID}"] a:has-text("팀 내역")`),
      ]);
      await page.waitForSelector("[data-club-detail-name]", { timeout: 25000 }).catch(() => {});
      const detailName = await page.$eval("[data-club-detail-name]", (e) => e.textContent.trim()).catch(() => null);
      ck(`[${org}] 상세 URL`, page.url().endsWith(`/admin/team-parts/info/${org}?org=${org}`), page.url().replace(BASE, ""));
      ck(`[${org}] 상세 클럽명 = ${KO[org]}`, detailName === KO[org], `detailName=${detailName}`);
      ck(`[${org}] 상세 진입 후 [개별] 유지`, (await modeBadge(page)) === "개별");
      const dLinks = await submenuLinks(page);
      const activeOnDetail = dLinks.filter((l) => l.active).map((l) => l.label);
      ck(`[${org}] 상세에서 팀 내역만 활성`, activeOnDetail.length === 1 && activeOnDetail[0] === "팀 내역", `active=[${activeOnDetail.join(",")}]`);

      // ── 시즌 내역 클릭 → placeholder ──
      await Promise.all([
        page.waitForURL(`**/admin/team-parts/info/seasons?org=${org}`, { timeout: 25000 }).catch(() => {}),
        page.click(`ul[id="${SUBMENU_ID}"] a:has-text("시즌 내역")`),
      ]);
      const seasonsStatus = await page.evaluate(async (u) => (await fetch(u, { cache: "no-store" })).status,
        `${BASE}/admin/team-parts/info/seasons?org=${org}`).catch(() => 0);
      ck(`[${org}] 시즌 내역 HTTP 200`, seasonsStatus === 200, `status=${seasonsStatus}`);
      const sLinks = await submenuLinks(page);
      const activeOnSeasons = sLinks.filter((l) => l.active).map((l) => l.label);
      ck(`[${org}] 시즌 내역만 활성(팀 내역 비활성)`,
        activeOnSeasons.length === 1 && activeOnSeasons[0] === "시즌 내역", `active=[${activeOnSeasons.join(",")}]`);
    }

    // ── 통합 모드 회귀: 클럽 정보 > 팀/시즌/주차 내역 유지 ──
    console.log(`\n[통합] /admin/team-parts/info (통합 모드)`);
    await page.goto(`${BASE}/admin/team-parts/info`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const badgeI = await modeBadge(page);
    ck(`[통합] [통합] 배지`, badgeI === "통합", `badge=${badgeI}`);
    // 통합 클럽 정보 submenu(basePath /admin/team-parts) 안에 팀/시즌/주차 내역
    const intLinks = await page.$$eval(`ul[id="submenu-/admin/team-parts"] a`, (as) => as.map((a) => a.textContent.trim())).catch(() => []);
    ck(`[통합] 클럽 정보 > 팀/시즌/주차 내역 유지`,
      ["팀 내역", "시즌 내역", "주차 내역"].every((l) => intLinks.includes(l)), `labels=[${intLinks.join(", ")}]`);
  } finally {
    await browser.close();
  }
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
