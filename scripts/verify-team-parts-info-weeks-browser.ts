/**
 * 클럽 정보 > 주차 내역 브라우저 검증 (dev server 필요).
 *   - 페이지 200 · 크래시 없음
 *   - 클럽 탭 4개(통합/엥크레/오랑캐/팔랑크스), 통합=준비중 안내
 *   - 현재 주차 배너 · 주차 표 렌더
 *   - 공식 휴식 주차 [활동 관리] → alert(이동 금지) / 공식 활동 주차 → 상세 라우팅
 *   - ?mode=test 요청 전파
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-info-weeks-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookies_() {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

async function main() {
  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1500, height: 2000 } });
  await ctx.addCookies(await cookies_());

  const page = await ctx.newPage();
  const apiReqs: string[] = [];
  page.on("request", (r: any) => {
    const url = r.url();
    if (url.includes("/api/admin/team-parts/info/weeks")) apiReqs.push(url.replace(BASE, ""));
  });
  const dialogs: string[] = [];
  page.on("dialog", async (d: any) => { dialogs.push(d.message()); await d.dismiss(); });

  // 1) 운영 페이지 로드.
  const resp = await page.goto(`${BASE}/admin/team-parts/info/weeks`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  const body = await page.evaluate(() => document.body.innerText);
  const crash = /Jest worker|child process exceptions|Internal Server Error|Application error/i.test(body);
  ck("운영 페이지 200 · 크래시 없음", resp?.status() === 200 && !crash, { status: resp?.status(), crash });

  // 2) 클럽 탭 4개.
  const tabs = await page.$$eval("[data-club-tab]", (els: any[]) => els.map((e) => e.getAttribute("data-club-tab")));
  ck("클럽 탭 4개(통합/엥크레/오랑캐/팔랑크스)", JSON.stringify(tabs) === JSON.stringify(["integrated", "encre", "oranke", "phalanx"]), tabs);

  // 3) 기본(엥크레) 표 + 배너 렌더.
  const rowCount = await page.$$eval("[data-week-row]", (els: any[]) => els.length);
  ck("주차 표 행 렌더(>0)", rowCount > 0, { rowCount });
  const hasBanner = await page.$("[data-current-week]");
  ck("현재 주차 배너 렌더", !!hasBanner);
  const todayTxt = await page.$eval("[data-cw-today]", (e: any) => e.textContent).catch(() => null);
  ck("배너 오늘 날짜 표시", !!todayTxt && todayTxt.trim() !== "-", { today: todayTxt });

  await page.screenshot({ path: "claudedocs/qa-team-parts-weeks-encre.png", fullPage: true });

  // 4) 통합 탭 → 준비중.
  await page.click('[data-club-tab="integrated"]');
  await page.waitForTimeout(500);
  const pending = await page.$eval("[data-integrated-pending]", (e: any) => e.textContent).catch(() => null);
  ck("통합 탭 = 준비 중 안내", !!pending && pending.includes("준비 중"), { pending: pending?.trim() });

  // 5) 오랑캐 탭으로 전환 후 공식 휴식/활동 주차 동작.
  await page.click('[data-club-tab="oranke"]');
  await page.waitForTimeout(2500);

  // 공식 휴식 행의 [활동 관리] → alert(이동 금지).
  const restBtn = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-week-row]"));
    for (const row of rows) {
      if ((row.textContent ?? "").includes("공식 휴식")) {
        const btn = row.querySelector("[data-manage-activity]");
        if (btn) return btn.getAttribute("data-manage-activity");
      }
    }
    return null;
  });
  if (restBtn) {
    const urlBefore = page.url();
    await page.click(`[data-manage-activity="${restBtn}"]`);
    await page.waitForTimeout(800);
    ck("공식 휴식 [활동 관리] → alert 표시", dialogs.some((m) => m.includes("공식 휴식") && m.includes("체크되지 않습니다")), { dialogs });
    ck("공식 휴식 [활동 관리] → 페이지 이동 없음", page.url() === urlBefore, { url: page.url() });
  } else {
    console.log("⚠ 현재 페이지에 공식 휴식 주차 없음 — alert 검증 생략.");
  }

  // 공식 활동 행의 [활동 관리] → 상세 라우팅.
  const actBtn = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-week-row]"));
    for (const row of rows) {
      if ((row.textContent ?? "").includes("공식 활동")) {
        const btn = row.querySelector("[data-manage-activity]");
        if (btn) return btn.getAttribute("data-manage-activity");
      }
    }
    return null;
  });
  if (actBtn) {
    await page.click(`[data-manage-activity="${actBtn}"]`);
    await page.waitForTimeout(1500);
    const url = page.url();
    ck("공식 활동 [활동 관리] → 상세(A) 라우팅", url.includes(`/admin/team-parts/info/weeks/${actBtn}`) && url.includes("club=oranke"), { url });
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1500);
  } else {
    console.log("⚠ 현재 페이지에 공식 활동 주차 없음 — 라우팅 검증 생략.");
  }

  // 6) ?mode=test 전파.
  apiReqs.length = 0;
  const page2 = await ctx.newPage();
  const reqs2: string[] = [];
  page2.on("request", (r: any) => { const url = r.url(); if (url.includes("/api/admin/team-parts/info/weeks")) reqs2.push(url.replace(BASE, "")); });
  const resp2 = await page2.goto(`${BASE}/admin/team-parts/info/weeks?mode=test`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page2.waitForTimeout(3000);
  const body2 = await page2.evaluate(() => document.body.innerText);
  const crash2 = /Jest worker|child process exceptions|Internal Server Error|Application error/i.test(body2);
  ck("QA(mode=test) 페이지 200 · 크래시 없음", resp2?.status() === 200 && !crash2, { status: resp2?.status(), crash: crash2 });
  ck("QA 페이지 API 요청에 mode=test 전파", reqs2.length > 0 && reqs2.every((r) => r.includes("mode=test")), reqs2.slice(0, 2));
  await page2.screenshot({ path: "claudedocs/qa-team-parts-weeks-test.png", fullPage: true });

  await ctx.browser()?.close?.();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
