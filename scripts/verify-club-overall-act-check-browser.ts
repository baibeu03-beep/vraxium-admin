/**
 * [클럽 총괄] 액트 체크 + 라인 급 컬럼 폭/말줄임/가로스크롤 브라우저 검증 (dev server 필요).
 *   1) 액트 체크 관리 탭에 "허브 급 0 : [클럽 총괄]" 섹션·라인 2종 노출
 *   2) 라인 급 배지 말줄임 없음(전체 텍스트·가로 클리핑 없음·overflow:hidden 아님)
 *   3) 데스크톱 주요 폭(1280/1440/1920)에서 페이지 가로 스크롤 없음
 *   4) 라인 개설 관리 탭에는 [클럽 총괄]/두 라인 미노출
 *   npx tsx --env-file=.env.local scripts/verify-club-overall-act-check-browser.ts
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

async function main() {
  const { rows } = await loadSeasonWeeks();
  const weekId = (rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0]).week_id;
  const org = "oranke";
  console.log(`   week=${weekId.slice(0, 8)} org=${org}`);

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  const resp = await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${org}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);
  ck("페이지 200", resp?.status() === 200);
  await page.click('[data-tab="act"]');
  await page.waitForTimeout(2500);

  // 1) 클럽 총괄 섹션 + 라인 2종.
  ck("클럽 총괄 허브 섹션", !!(await page.$('[data-hub-section="club"]')));
  const clubText = await page.$eval('[data-hub-section="club"]', (e: any) => e.textContent);
  ck("클럽 총괄 제목", /허브 급 0 : \[클럽 총괄\]/.test(clubText));
  ck("라인 '클럽 전체 가이드' 노출", clubText.includes("클럽 전체 가이드"), { clubText: clubText.slice(0, 120) });
  ck("라인 '행정 보안 검수' 노출", clubText.includes("행정 보안 검수"));
  const clubGroups = await page.$$('[data-hub-section="club"] [data-day-group]');
  ck("클럽 총괄 요일 2행 그룹", clubGroups.length === 2, { groups: clubGroups.length });

  // 2) 라인 급 배지 말줄임/클리핑 없음(모든 허브 표의 라인급 셀 검사).
  const badgeIssues = await page.$$eval('[data-info-line-row] > td:first-child > span', (spans: any[]) =>
    spans.map((el) => {
      const cs = getComputedStyle(el);
      return {
        text: (el.textContent || "").trim().slice(0, 24),
        clipped: el.scrollWidth > el.clientWidth + 1,
        ellipsis: cs.textOverflow === "ellipsis",
        hiddenOverflow: cs.overflow === "hidden" || cs.overflowX === "hidden",
      };
    }).filter((r) => r.clipped || r.ellipsis || r.hiddenOverflow),
  );
  ck("라인 급 배지 말줄임/가로 클리핑 없음", badgeIssues.length === 0, badgeIssues);

  // 특정 클럽 라인 배지가 전체 텍스트를 그대로 담는지(부분 잘림 아님).
  const clubBadgeTexts = await page.$$eval('[data-hub-section="club"] [data-info-line-row] > td:first-child > span', (s: any[]) => s.map((e) => (e.textContent || "").trim()));
  ck("클럽 라인 배지 전체 텍스트", clubBadgeTexts.includes("클럽 전체 가이드") && clubBadgeTexts.includes("행정 보안 검수"), clubBadgeTexts);

  // 3) 데스크톱 주요 폭에서 가로 스크롤 없음.
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 2000 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => ({
      docScroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    ck(`가로 스크롤 없음 @${width}`, overflow.docScroll <= overflow.inner + 1, overflow);
  }
  await page.setViewportSize({ width: 1440, height: 2400 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "claudedocs/qa-club-overall-act-check-1440.png", fullPage: true });

  // 4) 라인 개설 관리 탭 — [클럽 총괄]/두 라인 미노출.
  await page.click('[data-tab="line"]');
  await page.waitForTimeout(2000);
  const lineText = await page.$eval('[data-line-opening-panel]', (e: any) => e.textContent).catch(() => "");
  ck("라인 개설 관리에 [클럽 총괄] 없음", !/클럽 총괄/.test(lineText));
  ck("라인 개설 관리에 '클럽 전체 가이드' 없음", !lineText.includes("클럽 전체 가이드"));
  ck("라인 개설 관리에 '행정 보안 검수' 없음", !lineText.includes("행정 보안 검수"));
  await page.screenshot({ path: "claudedocs/qa-club-overall-line-opening-1440.png", fullPage: true });

  await browser.close();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
