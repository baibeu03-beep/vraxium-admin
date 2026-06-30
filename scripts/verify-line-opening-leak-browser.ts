/**
 * 라인 개설 4허브 mode=test 누수 브라우저 전수 검증 (catalog-free).
 *   각 허브를 운영/QA(?mode=test)로 열고, 페이지가 호출한 **모든** /api/admin/* 응답에서 user_id 를
 *   깊이 추출해 cross-mode 혼입을 검사한다. (특정 API 만 보지 않음 → 엔드포인트 누락 불가능.)
 *     test 모드: 응답에 운영 실유저(non-marker) 0
 *     운영 모드: 응답에 테스트유저(marker) 0
 *   모드마다 새 컨텍스트(깨끗한 localStorage) — 어드민 모드토글 영속 오염 차단.
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

// 응답 JSON 의 모든 *user_id / userId / target_user_id 값(uuid)을 깊이 추출.
function deepUserIds(o: any, acc: Set<string>) {
  if (!o || typeof o !== "object") return;
  for (const [k, val] of Object.entries(o)) {
    if (
      (/user_?id$/i.test(k) || k === "target_user_id" || k === "targetUserId") &&
      typeof val === "string" &&
      /^[0-9a-f-]{36}$/i.test(val)
    )
      acc.add(val);
    else if (val && typeof val === "object") deepUserIds(val, acc);
  }
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

  async function open(path: string) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 2600 } });
    await ctx.addCookies(cks);
    const page = await ctx.newPage();
    // url → {ids, status} : 페이지가 부른 모든 /api/admin/* 응답.
    const byUrl = new Map<string, { ids: Set<string>; status: number }>();
    page.on("response", async (r: any) => {
      const url = r.url();
      if (!/\/api\/admin\//.test(url)) return;
      const short = url.replace(BASE, "");
      try {
        const j = await r.json();
        const ids = new Set<string>();
        deepUserIds(j, ids);
        const ex = byUrl.get(short) ?? { ids: new Set<string>(), status: r.status() };
        ids.forEach((i) => ex.ids.add(i));
        byUrl.set(short, ex);
      } catch {}
    });
    const resp = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(11000);
    const body = await page.evaluate(() => document.body.innerText);
    const crash = /Jest worker|Internal Server Error|Application error/i.test(body);
    await ctx.close();
    return { status: resp?.status(), byUrl, crash };
  }

  const hubs = [
    { name: "practical-info(reported)", path: "/admin/line-opening/practical-info?org=encre" },
    { name: "practical-info[open탭]", path: "/admin/line-opening/practical-info?org=encre&tab=open" },
    { name: "practical-experience", path: "/admin/line-opening/practical-experience?org=encre" },
    { name: "practical-experience[open탭]", path: "/admin/line-opening/practical-experience?org=encre&tab=open" },
    { name: "practical-competency", path: "/admin/line-opening/practical-competency?org=encre" },
    { name: "practical-competency[open탭]", path: "/admin/line-opening/practical-competency?org=encre&tab=open" },
    { name: "practical-career", path: "/admin/line-opening/practical-career?org=encre" },
    { name: "practical-career[open탭]", path: "/admin/line-opening/practical-career?org=encre&tab=open" },
  ];
  for (const h of hubs) {
    // QA(test): 어떤 admin API 응답에도 운영 실유저(non-marker) 0.
    const qa = await open(`${h.path}&mode=test`);
    const opLeakUrls: Record<string, number> = {};
    for (const [url, info] of qa.byUrl) {
      const op = [...info.ids].filter((i) => !markers.has(i));
      if (op.length > 0) opLeakUrls[url] = op.length;
    }
    ck(
      `[${h.name}] QA(test) 전체 admin API 운영유저 0`,
      qa.status === 200 && !qa.crash && Object.keys(opLeakUrls).length === 0,
      { crash: qa.crash, leakUrls: opLeakUrls },
    );
    // 운영: 어떤 admin API 응답에도 테스트유저(marker) 0.
    const op = await open(h.path);
    const tLeakUrls: Record<string, number> = {};
    for (const [url, info] of op.byUrl) {
      const tu = [...info.ids].filter((i) => markers.has(i));
      if (tu.length > 0) tLeakUrls[url] = tu.length;
    }
    ck(
      `[${h.name}] 운영 전체 admin API 테스트유저 0`,
      op.status === 200 && !op.crash && Object.keys(tLeakUrls).length === 0,
      { crash: op.crash, leakUrls: tLeakUrls },
    );
  }
  await browser.close();
  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
