/**
 * 액트 체크 관리 탭 레이아웃 브라우저 검증 (dev server 필요).
 *   - 요일 2행 그룹(월~목 / 금~일) 테이블 2개
 *   - 요일 헤더에 전체/가동/체크/변동 표시
 *   - 라인 행(위즈덤…) + 변동 액트 행(항상 존재)
 *   - 정규 액트 카드(액트명·신청시점·담당자·가동/비가동·체크 원)
 *   - 변동 액트가 있는 주차에서는 변동 카드 렌더
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-info-act-check-browser.ts
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
  // 변동 액트가 있는 (oranke, operating) 주차 우선, 없으면 활동 주차.
  const { data: irr } = await supabaseAdmin
    .from("process_irregular_acts").select("week_id").eq("organization_slug", "oranke").eq("scope_mode", "operating").not("week_id", "is", null).limit(1);
  let weekId = (irr?.[0] as { week_id: string } | undefined)?.week_id ?? null;
  let expectVariable = !!weekId;
  if (!weekId) {
    const { rows } = await loadSeasonWeeks();
    weekId = (rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0]).week_id;
  }
  console.log(`   week=${weekId.slice(0, 8)} expectVariable=${expectVariable}`);

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1600, height: 2200 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  const resp = await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=oranke`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);
  ck("페이지 200", resp?.status() === 200);
  await page.click('[data-tab="act"]');
  await page.waitForTimeout(2500);

  ck("액트 체크 패널 렌더", !!(await page.$("[data-act-check-panel]")));

  // 허브 섹션 2개(실무 정보 + 실무 경험).
  ck("실무 정보 허브 섹션", !!(await page.$('[data-hub-section="info"]')));
  ck("실무 경험 허브 섹션", !!(await page.$('[data-hub-section="experience"]')));

  // ── 실무 정보 허브 ──
  const infoGroups = await page.$$('[data-hub-section="info"] [data-day-group]');
  ck("[정보] 요일 2행 그룹", infoGroups.length === 2, { groups: infoGroups.length });
  const g0 = await page.$eval('[data-hub-section="info"] [data-day-group="0"]', (e: any) => e.textContent);
  const g1 = await page.$eval('[data-hub-section="info"] [data-day-group="1"]', (e: any) => e.textContent);
  ck("[정보] 그룹0 = 월·화·수·목", ["월", "화", "수", "목"].every((d) => g0.includes(d)) && !g0.includes("금"));
  ck("[정보] 그룹1 = 금·토·일", ["금", "토", "일"].every((d) => g1.includes(d)));
  ck("[정보] 요일 헤더 전체/가동/체크/변동", ["전체", "가동", "체크", "변동"].every((k) => g0.includes(k)));
  ck("[정보] 위즈덤 라인 행", !!(await page.$('[data-hub-section="info"] [data-info-line-row="wisdom"]')));
  const varCards = await page.$$('[data-hub-section="info"] [data-variable-act]');
  if (expectVariable) ck("[정보] 변동 액트 카드 렌더", varCards.length >= 1, { varCards: varCards.length });
  else console.log(`   (이 주차 변동 액트 없음, cards=${varCards.length})`);

  // ── 실무 경험 허브 ──
  const expTabs = await page.$$('[data-exp-team-tab]');
  ck("[경험] 팀 탭 렌더(>=1)", expTabs.length >= 1, { tabs: expTabs.length });
  const expGroups = await page.$$('[data-hub-section="experience"] [data-day-group]');
  ck("[경험] 선택 팀 요일 2행 그룹", expGroups.length === 2, { groups: expGroups.length });
  const expText = await page.$eval('[data-hub-section="experience"]', (e: any) => e.textContent);
  ck("[경험] 허브 요약 제목", /허브 급 2 : \[실무 경험\]/.test(expText));
  ck("[경험] 라인급(조직 관리) 행", /조직 관리/.test(expText), { has: /조직 관리/.test(expText) });
  // 팀 탭 전환 시 팀 요약 제목이 바뀐다.
  if (expTabs.length >= 2) {
    const before = await page.$eval('[data-hub-section="experience"]', (e: any) => e.textContent);
    await expTabs[1].click();
    await page.waitForTimeout(500);
    const after = await page.$eval('[data-hub-section="experience"]', (e: any) => e.textContent);
    ck("[경험] 팀 탭 전환 시 팀 요약 변경", before !== after);
  }

  await page.screenshot({ path: "claudedocs/qa-team-parts-act-check.png", fullPage: true });
  await ctx.browser()?.close?.();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
