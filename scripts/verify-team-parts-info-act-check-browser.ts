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
  // 요일 2행 그룹 테이블 2개.
  const groups = await page.$$('[data-day-group]');
  ck("요일 2행 그룹 테이블 2개", groups.length === 2, { groups: groups.length });
  // 그룹0 헤더 = 월화수목, 그룹1 = 금토일.
  const g0 = await page.$eval('[data-day-group="0"]', (e: any) => e.textContent);
  const g1 = await page.$eval('[data-day-group="1"]', (e: any) => e.textContent);
  ck("그룹0 = 월·화·수·목", ["월", "화", "수", "목"].every((d) => g0.includes(d)) && !g0.includes("금"), { });
  ck("그룹1 = 금·토·일", ["금", "토", "일"].every((d) => g1.includes(d)));
  // 요일 헤더 통계.
  ck("요일 헤더 전체/가동/체크/변동", ["전체", "가동", "체크", "변동"].every((k) => g0.includes(k)));
  // 위즈덤 라인 행 + 정규 액트 카드.
  ck("위즈덤 라인 행", !!(await page.$('[data-info-line-row="wisdom"]')));
  const anyActCard = await page.$('[data-act]');
  ck("정규 액트 카드 존재(오픈 알림 등)", !!anyActCard);
  // 변동 액트 행 항상 존재(그룹당 1).
  const varRows = await page.$$('[data-variable-row]');
  ck("변동 액트 행 존재(그룹당)", varRows.length === 2, { varRows: varRows.length });
  // 변동 카드(해당 주차에 변동 있을 때).
  const varCards = await page.$$('[data-variable-act]');
  if (expectVariable) ck("변동 액트 카드 렌더", varCards.length >= 1, { varCards: varCards.length });
  else console.log(`   (이 주차 변동 액트 없음 — 변동 행은 빈 상태 유지, cards=${varCards.length})`);

  await page.screenshot({ path: "claudedocs/qa-team-parts-act-check.png", fullPage: true });
  await ctx.browser()?.close?.();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
