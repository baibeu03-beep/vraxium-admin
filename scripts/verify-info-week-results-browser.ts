/**
 * "주차별 개설 결과 목록" 실제 브라우저 검증 (사용자 신고 화면).
 *   practical-info?org=encre[&mode=test] → 주차 드롭다운에서 2026봄 W13 선택 →
 *   주차별 개설 결과 목록에 운영 라인이 "개설 완료"로 보이는지:
 *     · info-line-results 응답 openedLineCount (React state 소스)
 *     · 렌더된 "개설 완료" 배지 수
 *   test 모드 = 0 (운영 라인 0건) · 운영 모드 = >0 (기존 동일).
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = "http://localhost:3000";
const U = process.env.NEXT_PUBLIC_SUPABASE_URL!,
  A = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  S = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TARGET_WEEK = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13 (encre 운영 라인 6개)
let fail = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) fail++;
};

async function cookies_() {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const admin = createClient(U, S), anon = createClient(U, A);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(U, A, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

async function main() {
  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const cks = await cookies_();

  async function run(mode: "operating" | "test") {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 2800 } });
    await ctx.addCookies(cks);
    const page = await ctx.newPage();
    let respOpened: number | null = null;
    page.on("response", async (r: any) => {
      if (!/\/api\/admin\/cluster4\/info-line-results/.test(r.url())) return;
      if (!new RegExp(`week_id=${TARGET_WEEK}`).test(r.url())) return;
      try {
        const j = await r.json();
        if (j?.data?.openedLineCount != null) respOpened = j.data.openedLineCount;
      } catch {}
    });
    const url = `${BASE}/admin/line-opening/practical-info?org=encre${mode === "test" ? "&mode=test" : ""}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(4000);
    const selected = await page.evaluate((wk: string) => {
      const sels = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
      for (const s of sels) {
        const opt = Array.from(s.options).find((o) => o.value === wk);
        if (opt) { s.value = wk; s.dispatchEvent(new Event("change", { bubbles: true })); return true; }
      }
      return false;
    }, TARGET_WEEK);
    await page.waitForTimeout(5000);
    // 렌더된 "개설 완료" 배지 수(주차별 개설 결과 카드).
    const renderedOpened = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("span,div,button"));
      return els.filter((e) => (e.textContent ?? "").trim() === "개설 완료").length;
    });
    await ctx.close();
    return { selected, respOpened, renderedOpened };
  }

  const t = await run("test");
  ck("[test] 주차 선택 성공", t.selected, { selected: t.selected });
  ck("[test] info-line-results 응답 openedLineCount = 0 (운영 라인 0건)", t.respOpened === 0, { respOpened: t.respOpened });
  ck("[test] 렌더 '개설 완료' 배지 0개", t.renderedOpened === 0, { rendered: t.renderedOpened });

  const o = await run("operating");
  ck("[operating] info-line-results openedLineCount > 0 (기존 동일)", (o.respOpened ?? 0) > 0, { respOpened: o.respOpened });
  ck("[operating] 렌더 '개설 완료' 배지 > 0", o.renderedOpened > 0, { rendered: o.renderedOpened });

  await browser.close();
  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
