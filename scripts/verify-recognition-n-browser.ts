/**
 * Phase 3 실 브라우저 검증: 활동 관리 상세 "이번 주 활동 인정 개수 N".
 *   - 오픈확인된 encre 2주 → 화면 N = DTO 실계산값(30 아님)
 *   - operating / mode=test 동일 N · 2번째 org(oranke)=미오픈확인→폴백 30
 *   - 오픈확인 클릭 → 즉시 갱신(응답 200·fail-closed 422 없음) · 새로고침 후 유지
 *   - 버튼 회귀·콘솔오류·가로 오버플로 · 1440/1280/1024
 *   dev server(:3000) 필요. npx tsx --env-file=.env.local scripts/verify-recognition-n-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadWeekRecognitionCount } from "@/lib/weekRecognitionResolve";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WIDTHS = [1440, 1280, 1024];

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

async function readN(page: any): Promise<{ num: string | null; text: string | null; fw: string | null }> {
  return page.evaluate(() => {
    const strong = document.querySelector("[data-week-recognition-count]") as HTMLElement | null;
    // [2026-07-21] 인정 개수는 문장(<p>)이 아니라 독립 요약 카드(<div>)로 렌더된다.
    const p = strong?.closest("div") as HTMLElement | null;
    return {
      num: strong?.textContent?.trim() ?? null,
      text: p?.innerText?.replace(/\s+/g, " ").trim() ?? null,
      fw: strong ? getComputedStyle(strong).fontWeight : null,
    };
  });
}

async function main() {
  // 대상 주차 = encre 오픈확인 2주(N 확정) + oranke 폴백 비교.
  const { data: oc } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("week_id, recognition_count_n")
    .eq("open_confirmed", true).eq("organization_slug", "encre")
    .not("recognition_count_n", "is", null)
    .order("recognition_count_n", { ascending: false });
  const weeks = (oc ?? []).slice(0, 2) as Array<{ week_id: string; recognition_count_n: number }>;
  if (weeks.length < 2) { console.error("encre 오픈확인 주차 2개 미만 — 검증 불가"); process.exit(1); }
  console.log("대상 encre 주차:", weeks.map((w) => `${w.week_id.slice(0, 8)}=N${w.recognition_count_n}`).join(", "));

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1900 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m: any) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e: any) => consoleErrors.push(String(e)));
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  // ── (1) encre 각 주차: operating + test 에서 화면 N = DTO N ──
  for (const w of weeks) {
    const dtoN = await loadWeekRecognitionCount(w.week_id, "encre" as any);
    for (const mode of ["operating", "test"] as const) {
      const q = mode === "test" ? `?club=encre&mode=test` : `?club=encre`;
      const url = `${BASE}/admin/team-parts/info/weeks/${w.week_id}${q}`;
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(4000);
      const body = await page.evaluate(() => document.body.innerText);
      const crash = /Internal Server Error|Application error|Unhandled Runtime/i.test(body);
      const label = `[encre/${w.week_id.slice(0, 8)}/${mode}]`;
      ck(`${label} 200·무크래시`, resp?.status() === 200 && !crash, { status: resp?.status() });
      const rc = await readN(page);
      ck(`${label} 화면 N=${dtoN}(DTO 일치·30 아님)`, rc.num === String(dtoN) && rc.num !== "30", { shown: rc.num, dto: dtoN });
      ck(`${label} N 강조(fw≥700)·문구`, Number(rc.fw) >= 700 && !!rc.text?.includes("활동 인정 개수") && !!rc.text?.includes("개"), { fw: rc.fw, text: rc.text });
      ck(`${label} 버튼 회귀 없음`, !!(await page.$("[data-open-confirm-button]")) && !!(await page.$("[data-hub-reset-button]")) && !!(await page.$("[data-review-button]")));
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1600 });
        await page.waitForTimeout(200);
        const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        ck(`${label} @${width} 가로 오버플로 없음`, ov <= 2, { overflowPx: ov });
      }
      await page.setViewportSize({ width: 1440, height: 1900 });
    }
  }

  // ── (2) 2번째 org(oranke) 동일 weekId → 미오픈확인 → 폴백 30 ──
  {
    const w = weeks[0];
    const url = `${BASE}/admin/team-parts/info/weeks/${w.week_id}?club=oranke`;
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(4000);
    const rc = await readN(page);
    const dtoN = await loadWeekRecognitionCount(w.week_id, "oranke" as any);
    ck(`[oranke/${w.week_id.slice(0, 8)}] 200`, resp?.status() === 200, { status: resp?.status() });
    ck(`[oranke] 미오픈확인 → 폴백 30(DTO=${dtoN})`, rc.num === "30" && dtoN === null, { shown: rc.num, dto: dtoN });
  }

  // ── (3) 오픈확인 클릭 → 즉시 갱신(응답 200·fail-closed 없음) · 새로고침 후 유지 ──
  {
    const w = weeks[0];
    const url = `${BASE}/admin/team-parts/info/weeks/${w.week_id}?club=encre`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(4000);
    const before = (await readN(page)).num;
    const [ocResp] = await Promise.all([
      page.waitForResponse((r: any) => r.url().includes("/open-confirm") && r.request().method() === "POST", { timeout: 60000 }),
      page.click("[data-open-confirm-button]"),
    ]);
    await page.waitForTimeout(2500);
    const ocJson = await ocResp.json().catch(() => null);
    const apiN = ocJson?.data?.weekRecognitionCount as number | null;
    const after = (await readN(page)).num;
    const failMsg = await page.evaluate(() => /포인트 설정이 없습니다/.test(document.body.innerText));
    ck(`[클릭] open-confirm 응답 200(fail-closed 422 아님)`, ocResp.status() === 200, { status: ocResp.status() });
    ck(`[클릭] 미설정 config 0건(fail-closed 메시지 없음)`, ocResp.status() !== 422 && !failMsg, { failMsg });
    // 즉시 갱신 = 화면 N 이 API 가 반환한 재계산 N 과 일치(30 폴백 아님). 재확인은 현재 UI config 기준 재계산.
    ck(`[클릭] 즉시 갱신 화면 N=${apiN}=API(30 아님·재계산 반영)`, after === String(apiN) && after !== "30" && apiN !== null, { before, after, apiN });
    // 새로고침 후 유지(방금 저장된 apiN).
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(4000);
    const reload = (await readN(page)).num;
    ck(`[새로고침] N=${apiN} 영속 유지`, reload === String(apiN), { reload, apiN });
    await page.screenshot({ path: "claudedocs/qa-recognition-n-encre-1440.png", fullPage: false });
  }

  // ── (4) 실행취소(오픈확인 undo)는 이 페이지 UI 미노출 → API 로 검증: revert→폴백30→재확인→복원 ──
  {
    const w = weeks[1]; // 469 주차로 별도 검증(대상 격리)
    const { revertWeekOpenConfirm, saveWeekOpenConfirm } = await import("@/lib/adminTeamPartsInfoWeekDetailData");
    const { data: row } = await supabaseAdmin.from("cluster4_week_opening_configs").select("config").eq("week_id", w.week_id).eq("organization_slug", "encre").maybeSingle();
    await revertWeekOpenConfirm({ weekId: w.week_id, organization: "encre" as any, actorId: null });
    const nAfterRevert = await loadWeekRecognitionCount(w.week_id, "encre" as any);
    ck(`[revert] N 저장값 null 처리`, nAfterRevert === null, { n: nAfterRevert });
    // 브라우저에서 폴백 30 확인.
    const url = `${BASE}/admin/team-parts/info/weeks/${w.week_id}?club=encre`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(4000);
    ck(`[revert] 화면 폴백 30`, (await readN(page)).num === "30");
    // 재확인 → 재계산 복원.
    const re = await saveWeekOpenConfirm({ weekId: w.week_id, organization: "encre" as any, config: (row as any)?.config, actorId: null });
    ck(`[재확인] N 재계산 복원 =${w.recognition_count_n}`, re.weekRecognitionCount === w.recognition_count_n, { restored: re.weekRecognitionCount });
  }

  ck(`콘솔 오류 없음`, consoleErrors.length === 0, { errors: consoleErrors.slice(0, 5) });

  await browser.close();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
