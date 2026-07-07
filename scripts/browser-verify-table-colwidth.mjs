// 폰트 확대 후 긴 텍스트 컬럼 우선 배분 검증.
//   · /admin/processes/register 통합 표에서 '액트명' 컬럼 폭 vs 짧은 컬럼 폭 실측.
//   · 액트명이 짧은 컬럼(번호/소요/Po.A)보다 넓은지, 페이지 좌우 여백이 남는데 표가 좁게 안 갇혔는지,
//     긴 액트명이 몇 줄로 렌더되는지(줄 수) 측정. 스크린샷 저장.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);
const TAG = process.env.COLWIDTH_TAG ?? "after";

async function makeAdminCookies() {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

async function visit(url) {
  try { await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 30000 }); }
  catch { await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 30000 }); }
  await page.waitForTimeout(1500);
}

function measure() {
  return page.evaluate(() => {
    const table = document.querySelector('[data-slot="table"]');
    if (!table) return { err: "no-table" };
    const heads = Array.from(table.querySelectorAll("thead th")).map((th) => ({
      label: (th.innerText || "").trim(),
      w: Math.round(th.getBoundingClientRect().width),
    }));
    // 액트명 열 인덱스
    const actIdx = heads.findIndex((h) => h.label.includes("액트명"));
    // 본문에서 액트명 셀들의 줄 수/최장 텍스트
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    let maxLines = 0, longest = "", longestLines = 0, longestW = 0;
    for (const r of rows) {
      const cell = r.children[actIdx];
      if (!cell) continue;
      const txt = (cell.innerText || "").trim();
      const cs = getComputedStyle(cell);
      const lh = parseFloat(cs.lineHeight) || 24;
      const lines = Math.round(cell.getBoundingClientRect().height / lh);
      if (lines > maxLines) maxLines = lines;
      if (txt.length > longest.length) { longest = txt; longestLines = lines; longestW = Math.round(cell.getBoundingClientRect().width); }
    }
    const scroller = document.querySelector('[data-slot="table-container"] > div') || table.parentElement;
    const tableW = Math.round(table.getBoundingClientRect().width);
    const availW = scroller ? Math.round(scroller.clientWidth) : null;
    const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
    return {
      heads, actIdx,
      actW: actIdx >= 0 ? heads[actIdx].w : null,
      numW: heads[0]?.w ?? null,
      tableW, availW, docOverflow,
      maxLines, longest: longest.slice(0, 40), longestLines, longestW,
    };
  });
}

try {
  for (const w of [2200, 1920, 1440, 800]) {
    await page.setViewportSize({ width: w, height: 1000 });
    await visit("/admin/processes/register?org=encre");
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `qa-colwidth-${TAG}-${w}.png`), fullPage: false });
    const m = await measure();
    const scroll = m.tableW > m.availW + 2;
    console.log(`[${TAG}/${w}] table=${m.tableW}px avail=${m.availW}px 가로스크롤=${scroll ? "예" : "아니오"} docOverflow=${m.docOverflow} · 액트명열=${m.actW}px 최장줄수=${m.longestLines}`);
  }
} catch (e) {
  console.error("ERROR:", e);
} finally {
  await browser.close();
}
