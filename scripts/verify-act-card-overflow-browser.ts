/**
 * 액트 체크 관리 표 — 액트 카드 셀 밖 overflow 방지 검증 (dev server 필요).
 *   모든 액트 카드가 자신의 <td> 안에 머물고(rect 비교)·말줄임 없음·scrollWidth<=clientWidth.
 *   재현 대상: 긴 액트명("7월 9일 1823에 한 테스트, 523…"·"테스트 입니다. 어떻게 등록되는지 보자구요.")
 *             + 무공백 롱토큰(시드).
 *   npx tsx --env-file=.env.local scripts/verify-act-card-overflow-browser.ts
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
// 모든 액트 카드: 카드 우측이 자기 td 우측을 넘지 않음·좌측 침범 없음·자체 overflow 없음·말줄임 없음.
const scanCards = (page: any) => page.$$eval('[data-act-check-panel] [data-card-state]', (cards: any[]) =>
  cards.map((card) => {
    const td = card.closest("td");
    if (!td) return null;
    const c = card.getBoundingClientRect(), t = td.getBoundingClientRect();
    const cs = getComputedStyle(card);
    return {
      text: (card.textContent || "").trim().slice(0, 28),
      overflowRight: c.right > t.right + 1,
      overflowLeft: c.left < t.left - 1,
      selfScroll: card.scrollWidth > card.clientWidth + 1,
      ellipsis: cs.textOverflow === "ellipsis",
    };
  }).filter((r: any) => r && (r.overflowRight || r.overflowLeft || r.selfScroll || r.ellipsis)));

async function main() {
  const { rows } = await loadSeasonWeeks();
  const weekId = (rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0]).week_id;
  const org = "oranke";
  // 무공백 롱토큰 액트 시드(클럽 전체 가이드 라인급) — 강제 줄바꿈 재현.
  const CLUB_LG = "0c1b0000-0000-4000-8000-000000000001";
  const LONG_ACT = "0c1a0000-0000-4000-8000-0000000000bb";
  const LONG_ACT_NAME = "무공백롱토큰" + "가나다라마바사아자차카타파하ABC123".repeat(2);
  await supabaseAdmin.from("process_check_statuses").delete().eq("act_id", LONG_ACT);
  await supabaseAdmin.from("process_acts").delete().eq("id", LONG_ACT);
  await supabaseAdmin.from("process_acts").insert({
    id: LONG_ACT, line_group_id: CLUB_LG, hub: "club", act_name: LONG_ACT_NAME.slice(0, 30),
    duration_minutes: 5, occur_week: "N", occur_dow: 1, occur_time: "09:00",
    check_week: "N", check_dow: 1, check_time: "10:00", point_check: 0, point_advantage: 0, point_penalty: 0,
    cafe: "none", check_target: "check", act_type: "basic", is_active: true,
  });
  // 오픈 확인(기본 전체체크) → 액트 카드가 신청시점 라벨까지 표시(다중 파트 줄바꿈 검증).
  await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", org);

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2600 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${org}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);
  await page.click("[data-open-confirm-button]"); // 기본 전체체크 저장 → 가동
  await page.waitForTimeout(1500);
  await page.click('[data-tab="act"]');
  await page.waitForTimeout(2500);

  const cardCount = (await page.$$('[data-act-check-panel] [data-card-state]')).length;
  ck("액트 카드 렌더(>=1)", cardCount >= 1, { cardCount });
  const longShown = await page.$eval("[data-act-check-panel]", (e: any) => e.textContent).then((t: string) => t.includes("무공백롱토큰"));
  ck("무공백 롱토큰 액트 표시", longShown);

  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 2600 });
    await page.waitForTimeout(400);
    const bad = await scanCards(page);
    ck(`@${width} 모든 액트 카드 td 안·말줄임 없음`, bad.length === 0, bad.slice(0, 4));
    const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
    ck(`@${width} 페이지 비정상 가로 스크롤 없음`, o.doc <= o.inner + 1, o);
  }
  await page.setViewportSize({ width: 1440, height: 2800 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "claudedocs/qa-act-card-overflow-1440.png", fullPage: true });

  // 일반/test 동일(카드 CSS 동일) — test 모드에서도 스캔.
  await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${org}&mode=test`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);
  await page.click('[data-tab="act"]');
  await page.waitForTimeout(2000);
  const badTest = await scanCards(page);
  ck("mode=test 액트 카드 td 안·말줄임 없음", badTest.length === 0, badTest.slice(0, 4));

  await browser.close();
  await supabaseAdmin.from("process_check_statuses").delete().eq("act_id", LONG_ACT);
  await supabaseAdmin.from("process_acts").delete().eq("id", LONG_ACT);
  await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", org);
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
