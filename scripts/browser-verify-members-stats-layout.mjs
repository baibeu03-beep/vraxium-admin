// 검증(브라우저) — /admin/members 상단 통계(전체/활동/휴식/중단) 간격·폰트 개편.
//   1) 네 그룹이 좌측 가용 폭에 균등 배치(grid-cols-4) — 그룹 간 간격이 기존보다 넓음
//   2) 라벨/숫자 그룹이 분리되지 않음(같은 span)
//   3) 폰트 확대(라벨 text-base, 숫자 text-lg) · 숫자 더 굵고 큼
//   4) 가로 스크롤 없음 · 좁은 폭에선 2열로 자연 줄바꿈
//   1440 / 1920 / 768 세 폭에서 측정. read-only. 사전조건: admin dev :3000.
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

const browser = await chromium.launch({ channel: "chromium", headless: true });

async function runAt(width, { test = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  const url = `${BASE}/admin/members${test ? "?mode=test" : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("크루 목록"), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const m = await page.evaluate(() => {
    const header = Array.from(document.querySelectorAll('[data-slot="card-header"]'))
      .find((h) => (h.innerText || "").includes("크루 목록"));
    // 통계 그룹 = "전체/활동/휴식/중단" 으로 시작하는 span.
    const spans = Array.from((header || document).querySelectorAll("span"));
    const labels = ["전체", "활동", "휴식", "중단"];
    const groups = labels.map((lab) => spans.find((s) => (s.textContent || "").trim().startsWith(lab)));
    const found = groups.filter(Boolean).length;
    // 각 그룹 내부에 라벨+숫자(b)가 함께 있는지(분리 금지).
    const grouped = groups.every((s) => s && s.querySelector("b") && /\d/.test(s.querySelector("b").textContent || ""));
    // 그룹 폰트/숫자 폰트.
    const labelPx = groups[0] ? parseFloat(getComputedStyle(groups[0]).fontSize) : 0;
    const bEl = groups[0] ? groups[0].querySelector("b") : null;
    const numPx = bEl ? parseFloat(getComputedStyle(bEl).fontSize) : 0;
    const numWeight = bEl ? getComputedStyle(bEl).fontWeight : "";
    // 그룹 span 은 grid item(block)이라 셀 전체를 채움 → 텍스트 실제 간격은 Range 로 측정.
    const textRect = (s) => { const r = document.createRange(); r.selectNodeContents(s); return r.getBoundingClientRect(); };
    const rects = groups.map((s) => (s ? textRect(s) : null));
    const cellW = groups[0] ? Math.round(groups[0].getBoundingClientRect().width) : 0;
    let gapPx = null, sameRow = null;
    if (rects[0] && rects[1]) {
      gapPx = Math.round(rects[1].left - rects[0].right); // 텍스트 끝→다음 텍스트 시작
      sameRow = Math.abs(rects[0].top - rects[1].top) < 4;
    }
    const docScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    return { found, grouped, labelPx, numPx, numWeight, gapPx, sameRow, cellW, docScroll };
  });

  console.log(`▶ /admin/members${test ? " (mode=test)" : ""} @ ${width}`);
  ck("네 통계 그룹 모두 존재", m.found === 4, `found=${m.found}`);
  ck("라벨+숫자 같은 그룹(분리 없음)", m.grouped);
  ck("라벨 폰트 확대(>=16px)", m.labelPx >= 16, `${m.labelPx}px`);
  ck("숫자 라벨보다 큼(강조)", m.numPx > m.labelPx, `num=${m.numPx}px label=${m.labelPx}px`);
  ck("숫자 굵게(>=700)", parseInt(m.numWeight) >= 700, `weight=${m.numWeight}`);
  if (width >= 1280) {
    ck("데스크톱 4그룹 한 줄(균등 배치)", m.sameRow === true);
    ck("데스크톱 그룹 균등·간격 넓음(텍스트 gap>=100px)", m.gapPx != null && m.gapPx >= 100, `gap=${m.gapPx}px cellW=${m.cellW}px`);
  } else {
    console.log(`  · (narrow) sameRow=${m.sameRow} gap=${m.gapPx}px cellW=${m.cellW}px — 좁은 폭 줄바꿈 허용`);
  }
  ck("페이지 가로 스크롤 없음", !m.docScroll);

  await page.screenshot({ path: resolve(adminRoot, `claudedocs/qa-members-stats-${test ? "test-" : ""}${width}.png`) });
  await context.close();
}

await runAt(1920);
await runAt(1440);
await runAt(768); // 태블릿 폭: 4열 유지·가로 스크롤 없음
await runAt(480); // 좁은 폭: 2열 자연 줄바꿈 + 가로 스크롤 없음
await runAt(1440, { test: true }); // mode=test 동일 UI

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
