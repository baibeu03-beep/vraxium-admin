/**
 * 후속 UI/초기화 검증 (dev server 필요).
 *   1) 허브별 카드 색상 통일(정보 두 카드 동일·경험 두 카드 동일·정보≠경험)
 *   2) "→ 액트 체크"/"→ 라인 개설" 문구 제거
 *   3) 긴 문자열(무공백 롱토큰 포함) 카드 밖 overflow 없음·말줄임 없음
 *   4) [초기화] → 정보/역량/클럽 미선택·경험 라인급 전체체크·경험 라인 기본값
 *   5) 초기화 후 [오픈 확인] → 리로드해도 값 유지
 *   npx tsx --env-file=.env.local scripts/verify-hub-reset-browser.ts
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
const allChecked = (page: any, sel: string) => page.$$eval(sel, (b: any[]) => b.length > 0 && b.every((x) => x.checked));
const noneChecked = (page: any, sel: string) => page.$$eval(sel, (b: any[]) => b.every((x) => !x.checked));

async function main() {
  const { rows } = await loadSeasonWeeks();
  const weekId = (rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0]).week_id;
  const org = "oranke";
  // 긴 무공백 롱토큰 라인급(클럽) 시드 — 줄바꿈/overflow 검증용.
  const LONG_LG = "0c1e0000-0000-4000-8000-0000000000e1";
  const LONG_NAME = "긴테스트라인급명" + "가나다라마바사아자차카타파하".repeat(4);
  await supabaseAdmin.from("process_line_groups").delete().eq("id", LONG_LG);
  await supabaseAdmin.from("process_line_groups").insert({ id: LONG_LG, hub: "club", name: LONG_NAME, sort_order: 90, is_active: true });
  // 시작 시 config 정리(깨끗한 기본값).
  await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", org);

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2600 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });
  const url = `${BASE}/admin/team-parts/info/weeks/${weekId}?club=${org}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);

  // 1) 허브별 카드 색상 통일.
  const bg = async (hub: string) => page.$eval(`[data-hub="${hub}"]`, (e: any) => getComputedStyle(e).backgroundColor);
  const [infoAct, infoLine, expAct, expLine, comp, club] = await Promise.all([bg("info-act"), bg("info-line"), bg("exp-act"), bg("exp-line"), bg("competency"), bg("club-act")]);
  ck("정보 두 카드 색상 동일", infoAct === infoLine, { infoAct, infoLine });
  ck("경험 두 카드 색상 동일", expAct === expLine, { expAct, expLine });
  ck("정보 ≠ 경험 색상", infoAct !== expAct, { infoAct, expAct });
  ck("역량·클럽 색상 존재(구분)", comp !== infoAct && club !== infoAct && comp !== club, { comp, club });

  // 2) 안내 문구 제거.
  const secText = await page.$eval('section:has([data-hub="info-act"])', (e: any) => e.textContent).catch(async () => {
    // 폴백: 상위 섹션 텍스트.
    return page.$eval('[data-hub="info-act"]', (e: any) => e.closest("section")?.textContent ?? "");
  });
  ck("'→ 액트 체크' 문구 제거", !/→\s*액트 체크/.test(secText));
  ck("'→ 라인 개설' 문구 제거", !/→\s*라인 개설/.test(secText));

  // 3) 긴 문자열 overflow 없음(카드/라벨 span).
  const longSpanOverflow = await page.$$eval('[data-hub="club-act"] label span', (spans: any[]) =>
    spans.filter((el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === "ellipsis").length);
  ck("클럽 라인급 라벨 overflow/말줄임 없음(롱토큰 포함)", longSpanOverflow === 0, { longSpanOverflow });
  const cardOverflow = await page.$$eval('[data-hub]', (cards: any[]) => cards.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
  ck("카드 밖 가로 overflow 없음", cardOverflow === 0, { cardOverflow });
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 2400 });
    await page.waitForTimeout(300);
    const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
    ck(`페이지 가로 스크롤 없음 @${width}`, o.doc <= o.inner + 1, o);
  }
  await page.setViewportSize({ width: 1440, height: 2600 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "claudedocs/qa-hub-reset-1440.png", fullPage: true });

  // 4) [초기화] 클릭 → 기본값.
  ck("초기화 버튼 존재", !!(await page.$("[data-hub-reset-button]")));
  await page.click("[data-hub-reset-button]");
  await page.waitForTimeout(400);
  ck("초기화: 정보 라인급 전부 해제", await noneChecked(page, '[data-hub="info-act"] input[type=checkbox]'));
  ck("초기화: 정보 라인(개설) 전부 해제", await noneChecked(page, '[data-hub="info-line"] input[type=checkbox]'));
  ck("초기화: 경험 라인급 전부 체크", await allChecked(page, '[data-hub="exp-act"] input[type=checkbox]'));
  ck("초기화: 경험 라인 도출 체크(기본값)", await allChecked(page, '[data-line-exp-cell$=":derive"]'));
  ck("초기화: 역량 정상진행 해제", await page.$eval("[data-competency-checkbox]", (e: any) => !e.checked));
  ck("초기화: 클럽 라인급 전부 해제", await noneChecked(page, '[data-hub="club-act"] input[type=checkbox]'));

  // 5) 오픈 확인 → 리로드 후 값 유지.
  await page.click("[data-open-confirm-button]");
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  ck("리로드 후: 정보 라인급 해제 유지", await noneChecked(page, '[data-hub="info-act"] input[type=checkbox]'));
  ck("리로드 후: 경험 라인급 체크 유지", await allChecked(page, '[data-hub="exp-act"] input[type=checkbox]'));
  ck("리로드 후: 역량 해제 유지", await page.$eval("[data-competency-checkbox]", (e: any) => !e.checked));
  ck("리로드 후: 클럽 라인급 해제 유지", await noneChecked(page, '[data-hub="club-act"] input[type=checkbox]'));
  ck("리로드 후: 정보 라인(개설) 해제 유지", await noneChecked(page, '[data-hub="info-line"] input[type=checkbox]'));

  await browser.close();
  // cleanup.
  await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", org);
  await supabaseAdmin.from("process_line_groups").delete().eq("id", LONG_LG);
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
