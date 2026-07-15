// 브라우저 검증 — 선택 탭 대비 강화(role=tab/aria-selected · 배경+굵기 차이 · 레이아웃 무시프트 · 다크).
//   대상: 실무 정보 라인 개설(?tab=open) 활동유형 탭(강화 적용). operating + mode=test, dark 재검사.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();
page.setDefaultNavigationTimeout(120000);

const readTabs = () => page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]'));
  return tabs.map((b) => {
    const s = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return { sel: b.getAttribute("aria-selected"), bg: s.backgroundColor, color: s.color, weight: s.fontWeight,
      w: Math.round(r.width), h: Math.round(r.height), text: (b.textContent || "").trim().slice(0, 10) };
  });
});

async function verify(org, mode) {
  const tag = `${org}${mode ? "/test" : "/operating"}`;
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=${org}&tab=open${mode ? "&mode=test" : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll('[role="tablist"] [role="tab"]').length > 1, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(800);

  let tabs = await readTabs();
  ck(`[${tag}] role=tab 탭 다수`, tabs.length > 1, `n=${tabs.length}`);
  if (tabs.length < 2) return;
  const selCount = tabs.filter((t) => t.sel === "true").length;
  ck(`[${tag}] 정확히 1개 aria-selected=true`, selCount === 1, `sel=${selCount}`);
  const sel = tabs.find((t) => t.sel === "true"), non = tabs.find((t) => t.sel === "false");
  const bgDiff = sel && non && sel.bg !== non.bg;
  const weightDiff = sel && non && sel.weight !== non.weight;
  ck(`[${tag}] 선택 vs 비선택: 배경 다름`, !!bgDiff, `sel.bg=${sel?.bg} non.bg=${non?.bg}`);
  ck(`[${tag}] 선택 vs 비선택: font-weight 다름(비색상 표현)`, !!weightDiff, `sel=${sel?.weight} non=${non?.weight}`);

  // 레이아웃 무시프트: 첫 비선택 탭 크기 기록 → 클릭(선택 전환) → 같은 탭 크기 불변.
  const before = tabs.find((t) => t.sel === "false");
  const idx = tabs.findIndex((t) => t.sel === "false");
  const btn = page.locator('[role="tablist"] [role="tab"]').nth(idx);
  await btn.click().catch(() => {});
  await page.waitForTimeout(400);
  const after = (await readTabs())[idx];
  const noShift = before && after && Math.abs(before.w - after.w) <= 1 && Math.abs(before.h - after.h) <= 1;
  ck(`[${tag}] 선택 전환 시 레이아웃 무시프트`, !!noShift, `w:${before?.w}->${after?.w} h:${before?.h}->${after?.h}`);
  ck(`[${tag}] 클릭한 탭이 선택됨`, after?.sel === "true");

  // 다크 모드: root data-theme=dark → 선택 배경이 비선택과 여전히 다름.
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(400);
  const dtabs = await readTabs();
  const dsel = dtabs.find((t) => t.sel === "true"), dnon = dtabs.find((t) => t.sel === "false");
  ck(`[${tag}] 다크 모드에서도 선택 배경 구분`, !!(dsel && dnon && dsel.bg !== dnon.bg), `sel=${dsel?.bg} non=${dnon?.bg}`);
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", `selected-state-${org}${mode ? "-test" : ""}-dark.png`) });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
}

try {
  await verify("encre", false);
  await verify("oranke", false);
  await verify("encre", true);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
