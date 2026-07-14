// 브라우저(인증 세션) 스모크 — 변동 액트 상단 안내 섹션 레이아웃 개편.
//   제목 "변동 액트 가동 · 신청" + 설명(링크 신청) + 설명 아래 [전원][부분] 버튼.
//   Help Key 유지 · 버튼 기능(다이얼로그) 동작 · 일반/mode=test · org 무관.
// 사용법: SMOKE_BASE_URL=http://localhost:3000 node scripts/browser-verify-irregular-header-layout.mjs
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

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"));
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

async function verifyScope(org, mode, shot) {
  const q = `?org=${org}${mode ? `&mode=${mode}` : ""}`;
  const label = `${org}${mode ? `/${mode}` : "/normal"}`;
  console.log(`\n== ${label} ==`);
  await page.goto(`${BASE}/admin/processes/check/irregular${q}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const body = await page.locator("body").innerText();
  check(`[${label}] 크래시 없음`, !/Application error|Unhandled Runtime/i.test(body));
  // 1) 제목
  check(`[${label}] 제목 "변동 액트 가동 · 신청" 표시`, body.includes("변동 액트 가동 · 신청"));
  // 2) 설명 문구
  check(`[${label}] 설명 본문 표시`, body.includes("을 대상으로 할 경우") && body.includes("모두 신청이 가능합니다"));
  // 3) 링크 신청 표기 · 링크 검수 미표기
  check(`[${label}] "링크 신청" 표기 존재`, body.includes("링크 신청"));
  check(`[${label}] "링크 검수" 표기 없음`, !body.includes("링크 검수"));
  // 4) 설명 아래에 전원/부분 버튼 (DOM 순서: 설명 <ul> 이 버튼보다 앞)
  const allBtn = page.getByRole("button", { name: "전원", exact: true });
  const partBtn = page.getByRole("button", { name: "부분", exact: true });
  check(`[${label}] [전원] 버튼 렌더`, (await allBtn.count()) >= 1);
  check(`[${label}] [부분] 버튼 렌더`, (await partBtn.count()) >= 1);
  const order = await page.evaluate(() => {
    const desc = Array.from(document.querySelectorAll("li")).find((el) => el.textContent?.includes("을 대상으로 할 경우"));
    const btn = Array.from(document.querySelectorAll("button")).find((el) => el.textContent?.trim() === "전원");
    if (!desc || !btn) return null;
    // compareDocumentPosition: 설명이 버튼보다 먼저 나오면 DOCUMENT_POSITION_FOLLOWING(4)
    return (desc.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  check(`[${label}] 설명 → 버튼 순서(설명이 위, 버튼이 아래)`, order === true);
  // 5) Help Key 돋보기 동작 — 항목 도움말 아이콘 존재(aria-label="이 항목 도움말"): 제목·전원·부분 최소 3개.
  const helpIcons = page.getByRole("button", { name: "이 항목 도움말" });
  check(`[${label}] Help Key 돋보기 아이콘 존재`, (await helpIcons.count()) >= 3);
  // 6) 버튼 기능 — [부분] 클릭 시 방식 선택 팝업(링크 신청/수동 부여)
  await partBtn.first().click();
  await page.waitForTimeout(400);
  const afterPart = await page.locator("body").innerText();
  const partialDialogOpened = afterPart.includes("방식 선택") && afterPart.includes("수동 부여");
  check(`[${label}] [부분] 클릭 → 방식 선택 팝업 오픈`, partialDialogOpened);
  // 팝업 닫기
  await page.getByRole("button", { name: "닫기" }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  if (shot) {
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", shot), fullPage: false });
    console.log(`  ▸ screenshot: claudedocs/${shot}`);
  }
}

try {
  await verifyScope("oranke", null, "qa-irregular-header-oranke-normal.png");
  await verifyScope("oranke", "test", "qa-irregular-header-oranke-test.png");
  await verifyScope("encre", null, "qa-irregular-header-encre-normal.png");
  check("콘솔 에러 없음", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} catch (e) {
  check("예외 없음", false, String(e?.stack ?? e?.message ?? e));
} finally {
  await browser.close();
  console.log(fail === 0 ? `\n✅ ALL PASS (${pass})` : `\n❌ ${fail} FAIL / ${pass} pass`);
  process.exit(fail === 0 ? 0 : 1);
}
