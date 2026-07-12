/**
 * 활동 관리(상세) — 과거 주차 [오픈 확인] 재확인 모달 브라우저 검증 (dev server 필요).
 *
 *   open-confirm API 는 route.fulfill 로 스텁(실제 DB write 없음) → 순수 UI 게이트만 검증한다.
 *   검증:
 *     1) 과거 주차: [오픈 확인] 클릭 → 모달 표시(제목/버튼)·아직 요청 0
 *     2) 취소 → 모달 닫힘·요청 0(HTTP 미전송)
 *     3) 다시 [오픈 확인] → [그래도 변경] → 요청 정확히 1회(POST)
 *     4) 미래 주차: [오픈 확인] 클릭 → 모달 없음·요청 즉시 1회(기존 동작 유지)
 *     5) mode=test(과거): 동일하게 모달 표시·동일 URL(…&mode=test)·동일 method(POST)
 *
 *   npx tsx --env-file=.env.local scripts/verify-past-week-open-confirm-guard-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

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
  const today = getCurrentActivityDateIso();
  const { rows } = await loadSeasonWeeks();
  const past = rows.find((r) => !r.is_current_week && r.week_end_date != null && r.week_end_date < today && r.week_start_date);
  const future = rows.find((r) => !r.is_current_week && r.week_start_date != null && r.week_start_date > today);
  if (!past) { console.log("❌ 과거 주차 샘플 없음"); process.exit(2); }
  console.log(`   past=${past.week_label}(${past.week_start_date}) future=${future?.week_label ?? "-"}`);

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1900 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();

  // open-confirm API 스텁 — 실제 write 방지 + 호출 카운트/URL/method 캡처.
  const calls: { url: string; method: string }[] = [];
  await ctx.route("**/open-confirm**", async (route: any) => {
    calls.push({ url: route.request().url(), method: route.request().method() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { openConfirmed: true, weekRecognitionCount: null } }),
    });
  });

  const gotoWeek = async (weekId: string, org: string, mode?: string) => {
    calls.length = 0;
    await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${org}${mode ? `&mode=${mode}` : ""}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("[data-open-confirm-button]", { timeout: 30000 });
    await page.waitForTimeout(800);
  };

  // ── (1)(2)(3) 과거 주차 operating ──
  await gotoWeek(past.week_id, "oranke");
  await page.click("[data-open-confirm-button]");
  await page.waitForTimeout(300);
  ck("[과거] 클릭 시 모달 표시", !!(await page.$("[data-admin-dialog]")));
  const title = await page.$eval("[data-admin-dialog] h2", (e: any) => e.textContent).catch(() => null);
  ck("[과거] 모달 제목 '지난 주차의 오픈 상태를 변경하시겠습니까?'", (title ?? "").includes("지난 주차의 오픈 상태를 변경"), { title });
  ck("[과거] 모달 표시 시점 요청 0", calls.length === 0, { calls: calls.length });

  // 취소 → 모달 닫힘·요청 0
  await page.click("[data-admin-dialog-cancel]");
  await page.waitForTimeout(400);
  ck("[과거] 취소 시 모달 닫힘", !(await page.$("[data-admin-dialog]")));
  ck("[과거] 취소 시 HTTP 미전송(요청 0)", calls.length === 0, { calls });

  // 다시 클릭 → 그래도 변경 → 요청 1회
  await page.click("[data-open-confirm-button]");
  await page.waitForSelector("[data-admin-dialog-confirm]", { timeout: 5000 });
  await page.click("[data-admin-dialog-confirm]");
  await page.waitForTimeout(800);
  ck("[과거] '그래도 변경' 시 요청 정확히 1회", calls.length === 1, { calls });
  ck("[과거] 요청 method=POST", calls[0]?.method === "POST", { method: calls[0]?.method });
  ck("[과거] 확인 후 모달 닫힘", !(await page.$("[data-admin-dialog]")));

  // ── (4) 미래 주차 — 모달 없이 즉시 요청 ──
  if (future) {
    await gotoWeek(future.week_id, "oranke");
    await page.click("[data-open-confirm-button]");
    await page.waitForTimeout(700);
    ck("[미래] 모달 미표시(기존 동작 유지)", !(await page.$("[data-admin-dialog]")));
    ck("[미래] 즉시 요청 1회", calls.length === 1, { calls });
  } else {
    console.log("   (future 주차 없음 — 미래 케이스 스킵)");
  }

  // ── (5) 과거 주차 mode=test — 동일 게이트·동일 URL(mode=test)·POST ──
  await gotoWeek(past.week_id, "oranke", "test");
  await page.click("[data-open-confirm-button]");
  await page.waitForTimeout(300);
  ck("[과거/test] 모달 표시(동일 게이트)", !!(await page.$("[data-admin-dialog]")));
  await page.click("[data-admin-dialog-confirm]");
  await page.waitForTimeout(800);
  ck("[과거/test] 요청 1회·POST·URL 에 mode=test", calls.length === 1 && calls[0]?.method === "POST" && /mode=test/.test(calls[0]?.url ?? ""), { calls });

  await browser.close();
  console.log(`\n${failed === 0 ? "🎉 ALL PASS" : `❌ ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
