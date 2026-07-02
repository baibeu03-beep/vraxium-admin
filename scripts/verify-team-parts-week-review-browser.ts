/**
 * [검수 완료] 버튼 → V 표시 브라우저 검증 (dev server 필요).
 *
 *  안전: 이미 공표된 성공/실패 주차의 result_reviewed_at 만 임시 null → 브라우저에서 검수 완료 클릭
 *        → 상세 V·목록 V 확인 → 원본 시각 원복. (published 내내 불변 → 실크루 표시 무손상.)
 *
 *   1) 상세 페이지: 검수 전 [주차 검수] 버튼 활성·V 없음
 *   2) 클릭 → 검수 완료 → 상세 상단 V(data-reviewed=true)·버튼 disabled
 *   3) 목록 페이지: 해당 주차 행 data-week-reviewed=true (새로고침 반영)
 *
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-week-review-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CLUB = "encre";

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
  // 공표+검수된 성공/실패 주차 1건.
  const { data: weeks } = await supabaseAdmin
    .from("weeks").select("id,season_key,week_number,start_date,result_published_at,result_reviewed_at")
    .not("result_published_at", "is", null).order("start_date", { ascending: false });
  let target: any = null;
  for (const w of (weeks ?? []) as any[]) {
    const { data: st } = await supabaseAdmin.from("user_week_statuses").select("status").eq("week_start_date", w.start_date);
    const rows = (st ?? []) as any[];
    if (rows.some((r) => r.status === "success") && rows.some((r) => r.status === "fail")) { target = w; break; }
  }
  if (!target) { console.log("⚠ 성공/실패 공표 주차 없음."); process.exit(2); }
  const weekId = target.id as string;
  const origRev = target.result_reviewed_at as string | null;
  console.log(`   대상 주차 = ${target.season_key} W${target.week_number} id=${weekId.slice(0, 8)}`);

  // 검수 전 상태로: reviewed=null (published 불변).
  await supabaseAdmin.from("weeks").update({ result_reviewed_at: null }).eq("id", weekId);

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1900 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.accept().catch(() => d.dismiss()); });

  try {
    // ── (1) 상세: 검수 전 ──
    const resp = await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${CLUB}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3500);
    ck("상세 200", resp?.status() === 200, { status: resp?.status() });
    const btnBefore = await page.$("[data-review-button]");
    ck("검수 전: [주차 검수] 버튼 존재", !!btnBefore);
    const disabledBefore = await page.$eval("[data-review-button]", (e: any) => e.disabled).catch(() => null);
    ck("검수 전: 버튼 활성(enabled)", disabledBefore === false, { disabledBefore });
    const vBefore = await page.$('[data-reviewed="true"]');
    ck("검수 전: V 없음", !vBefore);

    // ── (2) 클릭 → 검수 완료 ──
    await page.click("[data-review-button]");
    // 서버 왕복 대기(이미 공표된 주차라 재계산 없음 — 빠름). 상태 반영까지 폴링.
    let vAfter: any = null;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      vAfter = await page.$('[data-reviewed="true"]');
      if (vAfter) break;
    }
    ck("클릭 후: 상세 상단 V(data-reviewed=true) 표시", !!vAfter);
    const disabledAfter = await page.$eval("[data-review-button]", (e: any) => e.disabled).catch(() => null);
    ck("클릭 후: 버튼 disabled", disabledAfter === true, { disabledAfter });
    const btnLabel = await page.$eval("[data-review-button]", (e: any) => e.textContent).catch(() => null);
    ck("클릭 후: 버튼 라벨 '검수 완료'", /검수 완료/.test(btnLabel ?? ""), { btnLabel });
    await page.screenshot({ path: "claudedocs/qa-team-parts-review-detail.png", fullPage: true });

    // ── (3) 목록: 해당 주차 V ──
    await page.goto(`${BASE}/admin/team-parts/info/weeks?org=${CLUB}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3000);
    let rowReviewed: string | null = null;
    for (let pageNo = 1; pageNo <= 12; pageNo++) {
      const cell = await page.$(`[data-week-row="${weekId}"] [data-week-reviewed]`);
      if (cell) { rowReviewed = await cell.evaluate((e: any) => e.getAttribute("data-week-reviewed")); break; }
      const next = await page.$("[data-page-next]");
      const nextDisabled = await page.$eval("[data-page-next]", (e: any) => e.disabled).catch(() => true);
      if (!next || nextDisabled) break;
      await next.click();
      await page.waitForTimeout(1500);
    }
    ck("목록: 해당 주차 행 data-week-reviewed=true", rowReviewed === "true", { rowReviewed });
    await page.screenshot({ path: "claudedocs/qa-team-parts-review-list.png", fullPage: true });
  } finally {
    await browser.close().catch(() => {});
    // 원복.
    await supabaseAdmin.from("weeks").update({ result_reviewed_at: origRev }).eq("id", weekId);
    const { data: r } = await supabaseAdmin.from("weeks").select("result_reviewed_at").eq("id", weekId).maybeSingle();
    ck("원복: reviewed 원본 복원", (r as any)?.result_reviewed_at === origRev);
  }

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
