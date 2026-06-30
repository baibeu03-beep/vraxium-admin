/**
 * "현재 개설 대상 크루" 모달 실제 브라우저 검증 (사용자 신고 화면 그대로).
 *   practical-info?org=encre&mode=test → 주차별 개설 결과에서 운영 라인 보유 주차 선택 →
 *   "개설 대상 크루 수정" 클릭 → 모달의 "현재 개설 대상 크루" 가 운영 사용자 0 인지:
 *     · 모달 fetch(info-lines/crew?mode=test) HTTP 응답의 운영 userId 0
 *     · 렌더된 "현재 개설 대상 크루 N명" 카운트(0 또는 테스트유저만)
 *   운영 모드(mode 없음)는 같은 주차/라인에서 기존대로 운영 대상자가 보이는지도 확인.
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
const TARGET_WEEK = "67e07106-564e-4dab-b180-8f11c909973a"; // 2026-spring W11 (encre 운영 라인 91명)
let fail = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) fail++;
};

async function cookies_() {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
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
  const markers = new Set(((await supabaseAdmin.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const cks = await cookies_();

  async function run(mode: "operating" | "test") {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 2600 } });
    await ctx.addCookies(cks);
    const page = await ctx.newPage();
    const crewIds: string[] = [];
    page.on("response", async (r: any) => {
      if (!/\/api\/admin\/cluster4\/info-lines\/crew/.test(r.url())) return;
      try {
        const j = await r.json();
        for (const t of j?.data?.targets ?? []) if (t.userId) crewIds.push(t.userId);
      } catch {}
    });
    const url = `${BASE}/admin/line-opening/practical-info?org=encre${mode === "test" ? "&mode=test" : ""}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(4000);
    // 주차별 개설 결과 select 를 대상 주차로 변경.
    const selected = await page.evaluate((wk: string) => {
      const sels = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
      for (const s of sels) {
        const opt = Array.from(s.options).find((o) => o.value === wk);
        if (opt) {
          s.value = wk;
          s.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, TARGET_WEEK);
    await page.waitForTimeout(4000);
    // "개설 대상 크루 수정" 버튼 클릭.
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").includes("개설 대상 크루 수정"),
      ) as HTMLButtonElement | undefined;
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(5000);
    // 모달의 "현재 개설 대상 크루 N명" 카운트 텍스트 + 테이블 행 수.
    const modal = await page.evaluate(() => {
      const body = document.body.innerText;
      const m = body.match(/현재 개설 대상 크루\s*([0-9]+)명/);
      // 모달 테이블 데이터행 수(크루 번호/이름 열).
      const rows = document.querySelectorAll("table tbody tr").length;
      return { countText: m ? Number(m[1]) : null, hasModal: /개설 대상 크루 수정/.test(body), tableRows: rows };
    });
    await ctx.close();
    return { selected, clicked, crewIds: [...new Set(crewIds)], modal };
  }

  // TEST 모드 — 사용자 신고 핵심.
  const t = await run("test");
  const tOp = t.crewIds.filter((id) => !markers.has(id));
  ck("모달 진입(select+수정 클릭) 성공 [test]", t.selected && t.clicked && t.modal.hasModal, { selected: t.selected, clicked: t.clicked });
  ck("[test] info-lines/crew 응답 운영유저 0", tOp.length === 0, { total: t.crewIds.length, opLeak: tOp.length });
  ck("[test] 렌더 '현재 개설 대상 크루' 카운트 운영유저 미포함(0)", t.modal.countText === 0, { rendered: t.modal.countText });

  // OPERATING 모드 — 기존과 동일(운영 대상자 보임).
  const o = await run("operating");
  const oOp = o.crewIds.filter((id) => !markers.has(id));
  ck("[operating] info-lines/crew 운영 대상자 보임(기존 동일)", o.crewIds.length > 0 && oOp.length === o.crewIds.length, { total: o.crewIds.length, operating: oOp.length });
  ck("[operating] 렌더 카운트 = 운영 대상자(>0)", (o.modal.countText ?? 0) > 0, { rendered: o.modal.countText });

  await browser.close();
  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
