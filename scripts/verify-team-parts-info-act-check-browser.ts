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

  // 허브 섹션 3개(실무 정보 + 실무 경험 + 실무 역량).
  ck("실무 정보 허브 섹션", !!(await page.$('[data-hub-section="info"]')));
  ck("실무 경험 허브 섹션", !!(await page.$('[data-hub-section="experience"]')));
  ck("실무 역량 허브 섹션", !!(await page.$('[data-hub-section="competency"]')));

  // ── 실무 정보 허브 ──
  const infoGroups = await page.$$('[data-hub-section="info"] [data-day-group]');
  ck("[정보] 요일 2행 그룹", infoGroups.length === 2, { groups: infoGroups.length });
  const g0 = await page.$eval('[data-hub-section="info"] [data-day-group="0"]', (e: any) => e.textContent);
  const g1 = await page.$eval('[data-hub-section="info"] [data-day-group="1"]', (e: any) => e.textContent);
  ck("[정보] 그룹0 = 월·화·수·목", ["월", "화", "수", "목"].every((d) => g0.includes(d)) && !g0.includes("금"));
  ck("[정보] 그룹1 = 금·토·일", ["금", "토", "일"].every((d) => g1.includes(d)));
  ck("[정보] 요일 헤더 전체/가동/체크/변동", ["전체", "가동", "체크", "변동"].every((k) => g0.includes(k)));
  ck("[정보] 라인급 행 존재(process_line_groups)", (await page.$$('[data-hub-section="info"] [data-info-line-row]')).length >= 1);
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
  // "[팀명] 팀 요약" 하위 제목은 제거됨 — 어떤 탭에서도 표시되지 않아야 한다(요약 지표 카드는 유지).
  ck("[경험] 팀 요약 제목 제거", !/팀 요약/.test(expText), { has: /팀 요약/.test(expText) });
  // 팀 탭 전환 시 aria-selected 가 이동한다(제목 텍스트가 아닌 탭 상태로 검증).
  if (expTabs.length >= 2) {
    await expTabs[1].click();
    await page.waitForTimeout(500);
    const sel1 = await expTabs[1].getAttribute("aria-selected");
    const sel0 = await expTabs[0].getAttribute("aria-selected");
    ck("[경험] 팀 탭 전환 시 선택 상태 이동", sel1 === "true" && sel0 !== "true", { sel0, sel1 });
    const stillNoTitle = await page.$eval('[data-hub-section="experience"]', (e: any) => e.textContent);
    ck("[경험] 탭 전환 후에도 팀 요약 제목 없음", !/팀 요약/.test(stillNoTitle));
  }

  // 허브 급 섹션 간 여백(space-y-10) 적용 확인 — 패널 공통 spacing.
  const panelCls = await page.$eval("[data-act-check-panel]", (e: any) => e.className);
  ck("액트 패널 space-y-10 적용", /\bspace-y-10\b/.test(panelCls), { panelCls });

  // ── 실무 역량 허브(실무 정보와 동일 UI) ──
  const compGroups = await page.$$('[data-hub-section="competency"] [data-day-group]');
  ck("[역량] 요일 2행 그룹", compGroups.length === 2, { groups: compGroups.length });
  const compText = await page.$eval('[data-hub-section="competency"]', (e: any) => e.textContent);
  ck("[역량] 허브 요약 제목", /허브 급 3 : \[실무 역량\]/.test(compText));
  ck("[역량] 요일 헤더 전체/가동/체크/변동", ["전체", "가동", "체크", "변동"].every((k) => compText.includes(k)));

  await page.screenshot({ path: "claudedocs/qa-team-parts-act-check.png", fullPage: true });

  // 라인 개설 관리 탭도 동일한 세로 리듬(space-y-10) 사용 — 두 탭 파리티(act 탭 검증 완료 후 전환).
  await page.click('[data-tab="line"]');
  await page.waitForTimeout(2500);
  const lineCls = await page.$eval("[data-line-opening-panel]", (e: any) => e.className);
  ck("라인 개설 패널 space-y-10 적용", /\bspace-y-10\b/.test(lineCls), { lineCls });
  await ctx.browser()?.close?.();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
