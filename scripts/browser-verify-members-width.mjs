// 검증(브라우저) — /admin/members 목록(전체 너비) vs /admin/members/[userId] 상세(max-w 유지).
//   1) 목록 root wrapper = max-width 캡 없음(전체 너비) · 표 A 18컬럼 · 가로 스크롤 측정
//   2) 상세 root wrapper = max-width 1600px 유지 · 카드 레이아웃 정상
// read-only. 사전조건: admin dev :3000. Usage: node scripts/browser-verify-members-width.mjs
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

// 세션 쿠키.
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({
  email: EMAIL,
  token: link.properties.email_otp,
  type: "magiclink",
});
const cap = [];
const srv = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
});
await srv.auth.setSession({
  access_token: v.session.access_token,
  refresh_token: v.session.refresh_token,
});
const cookies = cap.map((i) => ({
  name: i.name, value: i.value, domain: "localhost", path: "/",
  httpOnly: false, secure: false, sameSite: "Lax",
}));

// 표본 상세 1명.
const { data: sample } = await sb
  .from("user_profiles").select("user_id")
  .eq("organization_slug", "oranke").not("activity_started_at", "is", null).limit(1);
const sampleId = (sample ?? [])[0]?.user_id;

const browser = await chromium.launch({ channel: "chromium", headless: true });
// 아주 넓은 뷰포트(2400)에서 측정 — 목록(캡 제거→전체 너비)과 상세(1600 캡)의 분리를 직접 대조.
//   2400 에선 콘텐츠 영역이 ~2100px → 목록은 거기까지 확장(>1600), 상세는 1600 에서 고정.
const context = await browser.newContext({ viewport: { width: 2400, height: 1000 } });
await context.addCookies(cookies);
const page = await context.newPage();

// ── 1) 목록 페이지(/admin/members, 기본 탭=크루 목록 표 A) ──
await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.innerText.includes("크루 목록"), { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);

const listMetrics = await page.evaluate(() => {
  // root wrapper = px-4 py-6 flex 컨테이너(첫 번째).
  const root = document.querySelector("main > div, main div.flex.w-full.flex-col");
  const rootMax = root ? getComputedStyle(root).maxWidth : null;
  const rootW = root ? root.clientWidth : 0;
  // 표 A = 18컬럼 table.
  const tables = Array.from(document.querySelectorAll("table"));
  let cols = 0, tableScroll = 0, contClient = 0, overflow = false;
  for (const t of tables) {
    const ths = t.querySelectorAll("thead th").length;
    if (ths >= cols) { cols = ths; }
  }
  const big = tables.sort((a, b) => b.querySelectorAll("thead th").length - a.querySelectorAll("thead th").length)[0];
  if (big) {
    const cont = big.closest("[class*=overflow]") || big.parentElement;
    tableScroll = big.scrollWidth;
    contClient = cont ? cont.clientWidth : 0;
    overflow = tableScroll > contClient + 1;
  }
  const docScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  return { rootMax, rootW, cols, tableScroll, contClient, overflow, docScroll, vw: window.innerWidth };
});

console.log(`▶ 목록 /admin/members (뷰포트 ${listMetrics.vw})`);
ck("목록 root max-width 캡 없음(none)", listMetrics.rootMax === "none", `maxWidth=${listMetrics.rootMax} clientW=${listMetrics.rootW}`);
ck("목록 root 너비 > 1600(전체 너비 사용·상세 캡 초과)", listMetrics.rootW > 1600, `${listMetrics.rootW}px`);
ck("표 A 컬럼 18+([이동] 포함 19)", listMetrics.cols >= 18, `${listMetrics.cols}컬럼`);
ck("표 A 컨테이너 가로 스크롤 없음", !listMetrics.overflow, `table=${listMetrics.tableScroll} cont=${listMetrics.contClient}`);
ck("페이지 가로 스크롤 없음", !listMetrics.docScroll, "");

// ── 2) 상세 페이지(/admin/members/[userId]) ──
if (sampleId) {
  await page.goto(`${BASE}/admin/members/${sampleId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("클럽 결과(시즌)"), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  const detailMetrics = await page.evaluate(() => {
    const root = document.querySelector("main div.flex.w-full.flex-col");
    return {
      rootMax: root ? getComputedStyle(root).maxWidth : null,
      rootW: root ? root.clientWidth : 0,
      hasPersonal: document.body.innerText.includes("인적사항"),
      hasClub: document.body.innerText.includes("클럽 소속"),
      docScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  console.log(`▶ 상세 /admin/members/${sampleId}`);
  ck("상세 root max-width 1600px 유지", detailMetrics.rootMax === "1600px", `maxWidth=${detailMetrics.rootMax} clientW=${detailMetrics.rootW}`);
  ck("상세 레이아웃 정상(인적사항+클럽 소속)", detailMetrics.hasPersonal && detailMetrics.hasClub, "");
  ck("상세 페이지 가로 스크롤 없음", !detailMetrics.docScroll, "");
}

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
