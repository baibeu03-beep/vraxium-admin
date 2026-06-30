/**
 * 라인 개설 4허브 "개설 대상 크루" QA 누수 브라우저 검증.
 *   admin 쿠키 주입 후 각 허브를 운영/QA(?mode=test)로 열어, 모집단 API(cluster4/users·crews)
 *   응답에 운영 유저(test 모드)·테스트 유저(operating 모드)가 섞이지 않는지 확인.
 *   주의: 어드민 모드토글이 localStorage 에 모드를 영속하므로, 모드마다 새 컨텍스트(깨끗한 storage)를 쓴다.
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!,
  a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
let fail = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) fail++;
};

async function cookies_() {
  const { data: adm } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s),
    N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({
    email,
    token: (l as any).properties.email_otp,
    type: "magiclink",
  });
  const cap: any[] = [];
  const sv = createServerClient(u, a, {
    cookies: {
      getAll: () => [],
      setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))),
    },
  });
  await sv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return cap.map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

function uids(j: any): string[] {
  const d = j?.data ?? j;
  const arr = Array.isArray(d) ? d : (d?.users ?? d?.crews ?? d?.rows ?? []);
  return (arr as any[]).map((x) => x.userId ?? x.user_id).filter(Boolean);
}

async function main() {
  const markers = new Set(
    ((await supabaseAdmin.from("test_user_markers").select("user_id")).data ?? []).map(
      (x: any) => x.user_id,
    ),
  );
  const pw: any = await import(
    pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href
  );
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const cks = await cookies_();

  // 모드마다 새 컨텍스트(깨끗한 localStorage) → 모드토글 영속 오염 차단.
  async function open(path: string) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 2400 } });
    await ctx.addCookies(cks);
    const page = await ctx.newPage();
    const ids = new Set<string>();
    page.on("response", async (r: any) => {
      const url = r.url();
      if (/\/api\/admin\/cluster4\/(users|crews)(\?|$)/.test(url)) {
        try {
          uids(await r.json()).forEach((i) => ids.add(i));
        } catch {}
      }
    });
    const resp = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(9000);
    const body = await page.evaluate(() => document.body.innerText);
    const crash = /Jest worker|Internal Server Error/i.test(body);
    await ctx.close();
    return { status: resp?.status(), ids: [...ids], crash };
  }

  const hubs = [
    { name: "practical-info(reported)", path: "/admin/line-opening/practical-info?org=encre" },
    { name: "practical-experience", path: "/admin/line-opening/practical-experience?org=encre" },
    { name: "practical-competency", path: "/admin/line-opening/practical-competency?org=encre" },
    { name: "practical-career", path: "/admin/line-opening/practical-career?org=encre" },
  ];
  for (const h of hubs) {
    const qa = await open(`${h.path}&mode=test`);
    const opLeak = qa.ids.filter((i) => !markers.has(i));
    ck(
      `[${h.name}] QA(test) 개설대상크루 운영유저 0`,
      qa.status === 200 && !qa.crash && opLeak.length === 0,
      { total: qa.ids.length, opLeak: opLeak.length, crash: qa.crash },
    );
    const op = await open(h.path);
    const tLeak = op.ids.filter((i) => markers.has(i));
    ck(`[${h.name}] 운영 개설대상크루 테스트유저 0`, op.status === 200 && tLeak.length === 0, {
      total: op.ids.length,
      testLeak: tLeak.length,
    });
  }
  await browser.close();
  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
