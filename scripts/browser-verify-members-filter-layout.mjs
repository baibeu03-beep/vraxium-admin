// 검증(브라우저) — /admin/members 필터/집계 레이아웃 개편.
//   1) 안내 문구("…목록에 반영됩니다 … 다중 정렬") 완전 제거
//   2) 집계값(전체/활동/휴식/중단/결과 값)이 카드 헤더(제목 "크루 목록" 아래)로 이동 · 중복 없음
//   3) 클럽·필터 드롭다운 폭 확대(>=180px) · 필터 줄 가로 스크롤 없음
//   1280 / 1440 / 1920 세 폭에서 측정. read-only. 사전조건: admin dev :3000.
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

async function runAt(width) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("크루 목록"), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const m = await page.evaluate(() => {
    const body = document.body.innerText;
    // 안내 문구 제거 확인.
    const guideGone =
      !body.includes("목록에\n반영됩니다") &&
      !body.includes("목록에 반영됩니다") &&
      !body.includes("다중 정렬(클릭 순서");
    // 카드 헤더(제목 "크루 목록" 포함)에는 전체/활동/휴식/중단만, 결과 값은 없어야 함.
    const header = Array.from(document.querySelectorAll('[data-slot="card-header"]'))
      .find((h) => (h.innerText || "").includes("크루 목록"));
    const headerText = header ? header.innerText : "";
    const headerHasStatus = ["전체", "활동", "휴식", "중단"].every((t) => headerText.includes(t));
    const headerHasResult = headerText.includes("결과 값");
    // 결과 값 badge는 확인 버튼과 같은 컨테이너(필터 줄)에 존재.
    const spans = Array.from(document.querySelectorAll("span"));
    const resultSpan = spans.find((s) => s.textContent?.trim().startsWith("결과 값"));
    let resultNearConfirm = false;
    if (resultSpan) {
      const grp = resultSpan.closest("div");
      resultNearConfirm = !!grp && Array.from(grp.querySelectorAll("button")).some((b) => b.textContent?.trim() === "확인");
    }
    const resultLabelCount = (body.match(/결과 값/g) || []).length;
    // 드롭다운 폭.
    const selects = Array.from(document.querySelectorAll("select"));
    const selWidths = selects.map((s) => Math.round(s.getBoundingClientRect().width));
    // 가로 스크롤.
    const docScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    // 확인/초기화 버튼 존재.
    const btns = Array.from(document.querySelectorAll("button")).map((b) => b.textContent?.trim());
    const hasConfirm = btns.some((t) => t === "확인");
    const hasReset = btns.some((t) => (t || "").includes("초기화"));
    return { guideGone, headerHasStatus, headerHasResult, resultNearConfirm, resultLabelCount, selWidths, docScroll, hasConfirm, hasReset };
  });

  console.log(`▶ /admin/members @ ${width}`);
  ck("안내 문구 완전 제거", m.guideGone);
  ck("헤더(제목 아래)=전체/활동/휴식/중단만", m.headerHasStatus && !m.headerHasResult);
  ck("결과 값 badge=확인 버튼 옆", m.resultNearConfirm);
  ck("결과 값 중복 없음(1회)", m.resultLabelCount === 1, `${m.resultLabelCount}회`);
  ck("드롭다운 폭 확대(>=180px)", m.selWidths.length > 0 && m.selWidths.every((w) => w >= 180), `widths=[${m.selWidths.join(", ")}]`);
  ck("확인·초기화 버튼 유지", m.hasConfirm && m.hasReset);
  ck("페이지 가로 스크롤 없음", !m.docScroll);
  await context.close();
}

for (const w of [1280, 1440, 1920]) await runAt(w);

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
