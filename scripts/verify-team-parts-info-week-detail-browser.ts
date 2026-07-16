/**
 * 활동 관리(상세) 페이지 브라우저 검증 (dev server 필요).
 *   - 페이지 200·크래시 없음
 *   - 현재 주차 배너 / 관리 주차 카드 / 4개 허브 섹션 렌더
 *   - 기본 체크(정보 unchecked·경험 도출~관리 checked·역량 checked) 반영
 *   - 하단 탭(액트 체크 관리/라인 개설 관리) 토글
 *   - 오픈 확인 클릭 시 (테이블 미적용) 에러 배너 graceful 노출(무크래시)·주차 검수 버튼 존재
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-info-week-detail-browser.ts
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
  const week = rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0];
  const weekId = week.week_id;

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1500, height: 1900 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  const resp = await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=oranke`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  const body = await page.evaluate(() => document.body.innerText);
  const crash = /Jest worker|child process exceptions|Internal Server Error|Application error/i.test(body);
  ck("상세 페이지 200·크래시 없음", resp?.status() === 200 && !crash, { status: resp?.status(), crash });

  ck("현재 주차 배너", !!(await page.$("[data-current-week]")));
  ck("관리 주차 카드", !!(await page.$("[data-managed-week]")));
  const managedName = await page.$eval("[data-managed-week-name]", (e: any) => e.textContent).catch(() => null);
  ck("관리 주차명 표시", !!managedName && managedName.trim() !== "", { managedName });

  ck("실무 정보 섹션", !!(await page.$('[data-hub="info"]')));
  ck("실무 경험 섹션", !!(await page.$('[data-hub="experience"]')));
  ck("실무 역량 섹션", !!(await page.$('[data-hub="competency"]')));
  ck("실무 경력 섹션(별도 페이지 안내)", !!(await page.$('[data-hub="career"]')) && /별도 페이지/.test(body));

  // 기본 체크 상태.
  const infoChecked = await page.$$eval('[data-hub="info"] input[type=checkbox]', (els: any[]) => els.map((e) => e.checked));
  ck("실무 정보 기본 전부 unchecked", infoChecked.length > 0 && infoChecked.every((c: boolean) => c === false), { count: infoChecked.length });
  const compChecked = await page.$eval("[data-competency-checkbox]", (e: any) => e.checked).catch(() => null);
  ck("실무 역량 기본 checked", compChecked === true);
  // 경험: 도출/분석/견문/관리 checked (첫 팀 기준).
  const firstTeam = await page.$('[data-exp-team]');
  if (firstTeam) {
    const cells = await firstTeam.$$eval("input[type=checkbox]", (els: any[]) => els.map((e) => e.checked));
    // 순서: 도출·분석·견문·관리·확장. 확장은 저장값 없으면 항상 미체크(season-weeks 확장 기간 무관).
    ck("실무 경험 도출~관리 기본 checked·확장 미체크(저장값 없음)", cells.length === 5 && cells[0] && cells[1] && cells[2] && cells[3] && cells[4] === false, { cells });
  } else {
    console.log("⚠ 경험 팀 행 없음 — 경험 체크 검증 생략.");
  }

  ck("오픈 확인 버튼", !!(await page.$("[data-open-confirm-button]")));
  ck("주차 검수 버튼", !!(await page.$("[data-review-button]")));

  // 탭 토글.
  await page.click('[data-tab="line"]');
  await page.waitForTimeout(300);
  const tabTxt1 = await page.$eval("[data-tab-content]", (e: any) => e.textContent);
  ck("탭: 라인 개설 관리 선택 반영", /라인 개설 관리/.test(tabTxt1), { tabTxt1: tabTxt1.trim().slice(0, 40) });
  await page.click('[data-tab="act"]');
  await page.waitForTimeout(300);
  const tabTxt2 = await page.$eval("[data-tab-content]", (e: any) => e.textContent);
  ck("탭: 액트 체크 관리 선택 반영", /액트 체크 관리/.test(tabTxt2), { tabTxt2: tabTxt2.trim().slice(0, 40) });

  await page.screenshot({ path: "claudedocs/qa-team-parts-week-detail.png", fullPage: true });

  // 오픈 확인 클릭 → (테이블 미적용) 에러 배너 graceful. 무크래시.
  await page.click("[data-open-confirm-button]");
  await page.waitForTimeout(1500);
  const body2 = await page.evaluate(() => document.body.innerText);
  const crash2 = /Application error|Internal Server Error/i.test(body2);
  ck("오픈 확인 클릭 후 무크래시(에러는 배너로 graceful)", !crash2);

  await ctx.browser()?.close?.();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
