/**
 * Phase 1 검증: 활동 관리(상세) — 관리 주차가 현재 주차보다 위(DOM 순서) + 인정 개수 문구.
 *   dev server(localhost:3000) 필요.
 *   npx tsx --env-file=.env.local scripts/verify-weekdetail-phase1-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";

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
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

const ORGS = ["oranke", "phalanx"];
const WIDTHS = [1440, 1280, 1024];

async function main() {
  const { rows } = await loadSeasonWeeks();
  const week = rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0];
  const weekId = week.week_id;

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1900 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  for (const org of ORGS) {
    for (const mode of ["operating", "test"] as const) {
      const q = mode === "test" ? `?club=${org}&mode=test` : `?club=${org}`;
      const url = `${BASE}/admin/team-parts/info/weeks/${weekId}${q}`;
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(3500);
      const body = await page.evaluate(() => document.body.innerText);
      const crash = /Jest worker|child process exceptions|Internal Server Error|Application error/i.test(body);
      const label = `[${org}/${mode}]`;
      ck(`${label} 200·무크래시`, resp?.status() === 200 && !crash, { status: resp?.status() });

      const both = await page.$("[data-managed-week]") && await page.$("[data-current-week]");
      ck(`${label} 관리/현재 주차 영역 존재`, !!both);

      // DOM 순서: managed 가 current 보다 앞(문서 순서).
      const order = await page.evaluate(() => {
        const m = document.querySelector("[data-managed-week]");
        const c = document.querySelector("[data-current-week]");
        if (!m || !c) return null;
        // Node.DOCUMENT_POSITION_FOLLOWING(4) => c follows m => m 이 먼저.
        return (m.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? "managed-first" : "current-first";
      });
      ck(`${label} 관리 주차가 현재 주차보다 DOM 상 먼저`, order === "managed-first", { order });

      // 인정 개수 문구 + 강조 숫자.
      const rc = await page.evaluate(() => {
        const strong = document.querySelector("[data-week-recognition-count]") as HTMLElement | null;
        // [2026-07-21] 문장(<p>) → 독립 요약 카드(<div>) 로 변경됨.
        const p = strong?.closest("div") as HTMLElement | null;
        return {
          num: strong?.textContent?.trim() ?? null,
          text: p?.innerText?.replace(/\s+/g, " ").trim() ?? null,
          fw: strong ? getComputedStyle(strong).fontWeight : null,
        };
      });
      ck(`${label} 인정 개수 숫자=30 강조`, rc.num === "30" && Number(rc.fw) >= 700, rc);
      ck(`${label} "활동 인정 개수" 문구·"갯수" 아님`, !!rc.text && rc.text.includes("활동 인정 개수") && rc.text.includes("개") && !rc.text.includes("갯수"), { text: rc.text });

      // 기존 버튼 유지.
      ck(`${label} 오픈확인/초기화/주차검수 버튼`, !!(await page.$("[data-open-confirm-button]")) && !!(await page.$("[data-hub-reset-button]")) && !!(await page.$("[data-review-button]")));

      // 인정 개수 행이 헤더(활동 허브·라인 섹션) 안, 허브 그리드 위에 위치.
      const placed = await page.evaluate(() => {
        const strong = document.querySelector("[data-week-recognition-count]");
        const grid = document.querySelector('[data-hub="info-act"]');
        if (!strong || !grid) return null;
        return (strong.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? "before-grid" : "after-grid";
      });
      ck(`${label} 인정 개수 행이 허브 그리드 위`, placed === "before-grid", { placed });

      // 가로 오버플로 없음(각 폭).
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 1600 });
        await page.waitForTimeout(200);
        const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        ck(`${label} @${w} 가로 오버플로 없음`, ov <= 2, { overflowPx: ov });
      }
      await page.setViewportSize({ width: 1440, height: 1900 });

      if (org === "oranke" && mode === "operating") {
        await page.screenshot({ path: "claudedocs/qa-weekdetail-phase1-order-1440.png", fullPage: false });
      }
    }
  }

  await browser.close();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
