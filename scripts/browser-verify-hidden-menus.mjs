// 검증(브라우저) — 어드민 사이드바에서 시즌 참여/휴식·공식 휴식 관리 메뉴 임시 비노출.
//   1) 통합 모드 + 각 org × 일반/mode=test 사이드바에 두 메뉴 라벨 미노출
//   2) 크루 활동 그룹은 유지(빈 그룹/여백 없음) · 다른 메뉴 순서 불변
//   3) 직접 URL 접근 시 두 페이지는 그대로 열림(404/redirect 아님)
// read-only. 사전조건: admin dev :3000.
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

const HIDDEN_LABELS = ["시즌 참여/휴식", "공식 휴식 관리"];

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

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
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies(cookies);

// ── 사이드바 메뉴 라벨 미노출 ──
async function checkSidebar(label, url) {
  const page = await context.newPage();
  await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.querySelector("aside[data-collapsed]"), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const aside = document.querySelector("aside[data-collapsed]");
    const text = aside ? aside.innerText : "";
    return {
      text,
      hasCrewGroup: text.includes("크루 활동"),
      hasRestMgmt: text.includes("휴식 관리"),      // 유지되어야 할 형제 메뉴
      hasCrewMgmt: text.includes("크루 관리"),
    };
  });
  const leaked = HIDDEN_LABELS.filter((l) => r.text.includes(l));
  console.log(`▶ 사이드바 ${label}`);
  ck("두 메뉴 라벨 미노출", leaked.length === 0, leaked.length ? `노출됨: ${leaked.join(", ")}` : "없음");
  ck("크루 활동 그룹 유지(빈 그룹 아님)", r.hasCrewGroup && r.hasRestMgmt, `크루활동=${r.hasCrewGroup} 휴식관리=${r.hasRestMgmt}`);
  await page.close();
}

// 통합 모드(org 없음) + 각 org × 일반/test.
await checkSidebar("통합 모드(일반)", "/admin/dashboard");
await checkSidebar("통합 모드(test)", "/admin/dashboard?mode=test");
for (const org of ["encre", "oranke", "phalanx"]) {
  await checkSidebar(`org=${org}(일반)`, `/admin/dashboard?org=${org}`);
  await checkSidebar(`org=${org}(test)`, `/admin/dashboard?org=${org}&mode=test`);
}

// ── 직접 URL 접근 유지(페이지 그대로 열림) ──
async function checkDirect(label, url, heading) {
  const page = await context.newPage();
  const resp = await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const r = await page.evaluate((h) => {
    const body = document.body.innerText;
    const headings = Array.from(document.querySelectorAll("h1,h2")).map((e) => e.textContent.trim());
    return {
      status: null,
      hasHeading: headings.includes(h),
      is404: body.includes("찾을 수 없") || body.includes("404") || body.includes("페이지를 찾을"),
    };
  }, heading);
  console.log(`▶ 직접 URL ${label} (${url})`);
  ck("페이지 정상 열림(헤딩 표시)", (resp?.status() ?? 0) < 400 && r.hasHeading, `status=${resp?.status()} heading="${heading}"`);
  ck("404/차단 아님", !r.is404);
  await page.close();
}

await checkDirect("시즌 참여/휴식", "/admin/season-participations", "시즌 참여/휴식");
await checkDirect("공식 휴식 관리", "/admin/official-rest-periods", "공식 휴식 관리");

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
