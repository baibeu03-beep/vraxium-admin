/**
 * 상단 "이번 주 활동 허브와 라인" 6칸 분리(라인급 체크/라인 개설) 브라우저 검증 (dev server 필요).
 *   (1) 정보 라인급(체크) (2) 정보 라인(개설) (3) 경험 라인급(체크) (4) 경험 라인(오픈)
 *   (5) 역량 정상진행 (6) 클럽 라인급(체크) — 각 카드 렌더·체크박스·말줄임 없음·가로 스크롤 없음.
 *   npx tsx --env-file=.env.local scripts/verify-act-line-split-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!, a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => { console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`); if (!ok) failed++; };
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
  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2400 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });
  const resp = await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${org}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);
  ck("페이지 200", resp?.status() === 200);

  // 6칸 카드 존재.
  for (const [hub, label] of [
    ["info-act", "(1) 정보 라인급(체크)"], ["info-line", "(2) 정보 라인(개설)"],
    ["exp-act", "(3) 경험 라인급(체크)"], ["exp-line", "(4) 경험 라인(오픈)"],
    ["competency", "(5) 역량 정상진행"], ["club-act", "(6) 클럽 라인급(체크)"],
  ] as const) {
    ck(`카드 ${label} 렌더`, !!(await page.$(`[data-hub="${hub}"]`)));
  }
  // 제목에 "라인 급(체크)" / "라인(개설)" 구분 표기(안내 문구는 제거됨).
  const infoActText = await page.$eval('[data-hub="info-act"]', (e: any) => e.textContent);
  ck("(1) '라인 급(체크)' 제목", /라인 급\(체크\)/.test(infoActText) && !/→\s*액트 체크/.test(infoActText));
  const infoLineText = await page.$eval('[data-hub="info-line"]', (e: any) => e.textContent);
  ck("(2) '라인(개설)' 제목", /라인\(개설\)/.test(infoLineText) && !/→\s*라인 개설/.test(infoLineText));

  // 체크박스 존재 + 클릭 가능(라벨).
  const infoActBoxes = await page.$$('[data-hub="info-act"] [data-act-info-line] input[type=checkbox]');
  ck("(1) 정보 라인급 체크박스 >=1", infoActBoxes.length >= 1, { n: infoActBoxes.length });
  const infoLineBoxes = await page.$$('[data-hub="info-line"] [data-line-info-line] input[type=checkbox]');
  ck("(2) 정보 라인 체크박스 >=1", infoLineBoxes.length >= 1, { n: infoLineBoxes.length });
  const clubActBoxes = await page.$$('[data-hub="club-act"] [data-act-club-line] input[type=checkbox]');
  ck("(6) 클럽 라인급 체크박스 >=1", clubActBoxes.length >= 1, { n: clubActBoxes.length });
  const expActCells = await page.$$('[data-hub="exp-act"] [data-act-exp-cell]');
  ck("(3) 경험 라인급 셀(팀×라인급) >=1", expActCells.length >= 1, { n: expActCells.length });
  const expLineCells = await page.$$('[data-hub="exp-line"] [data-line-exp-cell]');
  ck("(4) 경험 라인(오픈) 셀 >=1", expLineCells.length >= 1, { n: expLineCells.length });

  // 독립성(UI): (1) 체크 토글 시 (2) 체크 상태 불변.
  const line2Before = await page.$$eval('[data-hub="info-line"] input[type=checkbox]', (b: any[]) => b.map((x) => x.checked));
  await infoActBoxes[0].click();
  await page.waitForTimeout(200);
  const line2After = await page.$$eval('[data-hub="info-line"] input[type=checkbox]', (b: any[]) => b.map((x) => x.checked));
  ck("(1) 토글 → (2) 라인개설 체크 상태 불변", JSON.stringify(line2Before) === JSON.stringify(line2After));
  await infoActBoxes[0].click(); // 원복

  // 말줄임 없음: 라벨 텍스트 클리핑/ellipsis 없음.
  const clipped = await page.$$eval('[data-hub="info-act"] label span, [data-hub="club-act"] label span, [data-hub="info-line"] label span', (spans: any[]) =>
    spans.filter((el) => { const cs = getComputedStyle(el); return el.scrollWidth > el.clientWidth + 1 || cs.textOverflow === "ellipsis"; }).length);
  ck("라인급/라인 라벨 말줄임 없음", clipped === 0, { clipped });

  // 가로 스크롤 없음(데스크톱 폭).
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 2200 });
    await page.waitForTimeout(300);
    const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
    ck(`가로 스크롤 없음 @${width}`, o.doc <= o.inner + 1, o);
  }
  await page.setViewportSize({ width: 1440, height: 2600 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "claudedocs/qa-act-line-split-1440.png", fullPage: true });

  await browser.close();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
