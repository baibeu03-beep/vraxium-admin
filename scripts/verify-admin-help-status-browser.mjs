import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontRoot = resolve(root, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(root, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(root, ".env.local"), "utf8");
const envValue = (key) => env.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim();
const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const email = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const supabaseUrl = envValue("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = envValue("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const serviceKey = envValue("SUPABASE_SERVICE_ROLE_KEY");
const helpPath = "/admin";
const helpKey = "admin.periods.register.submit";
const contentPresent = `도움말 상태 검증 ${Date.now()}`;
const shotDir = resolve(root, "claudedocs", "admin-help-status");
let failures = 0;

function check(label, condition, detail = "") {
  if (!condition) failures += 1;
  console.log(`${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function authCookies() {
  const service = createClient(supabaseUrl, serviceKey);
  const browserClient = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await service.auth.admin.generateLink({ type: "magiclink", email });
  if (linkError) throw linkError;
  const { data: verified, error: verifyError } = await browserClient.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError) throw verifyError;
  const captured = [];
  const ssr = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await ssr.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured;
}

async function main() {
  const cookies = await authCookies();
  const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  const apiFor = async (path, method, content, query = "") => {
    const response = await fetch(`${base}/api/admin/help?path=${encodeURIComponent(path)}${query}`, {
      method,
      headers: { cookie: cookieHeader, "Content-Type": "application/json" },
      body: method === "PUT" ? JSON.stringify({ path, content }) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };
  const api = (method, content, query = "") => apiFor(helpPath, method, content, query);
  const original = await api("GET");
  const originalKey = await apiFor(helpKey, "GET");
  if (original.status !== 200 || !original.json?.success) throw new Error("원본 도움말 조회 실패");
  if (originalKey.status !== 200 || !originalKey.json?.success) throw new Error("원본 help key 조회 실패");
  const originalContent = original.json.data.content;
  const originalKeyContent = originalKey.json.data.content;
  mkdirSync(shotDir, { recursive: true });

  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(cookies.map(({ name, value }) => ({ name, value, domain: "localhost", path: "/" })));
    const page = await context.newPage();
    let pageHelpGetCount = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/admin/help" && url.searchParams.get("path") === helpPath) pageHelpGetCount += 1;
    });
    const trigger = page.locator('[data-admin-help-trigger="page"]');
    const dot = page.locator(".admin-help-ping");

    await api("PUT", contentPresent);
    await page.goto(`${base}/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    pageHelpGetCount = 0;
    await page.reload({ waitUntil: "domcontentloaded" });
    await trigger.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-admin-help-trigger="page"]')?.classList.contains("admin-help-has-content"));
    check("설명 있음: glow", await trigger.evaluate((el) => getComputedStyle(el).boxShadow !== "none"));
    check("설명 있음: 정적 상태 점", (await dot.count()) === 1);
    check("설명 있음: 유한 강조 클래스", await trigger.evaluate((el) => el.classList.contains("admin-help-nudge")));
    await trigger.hover();
    await page.waitForTimeout(300);
    check("등록 도움말 커스텀 툴팁", (await page.locator('[role="tooltip"]').textContent()) === "도움말이 등록되어 있습니다");

    const getsBeforeModal = pageHelpGetCount;
    await trigger.click();
    await page.locator('[role="dialog"]').waitFor();
    check("페이지 진입 시 help GET 1회", getsBeforeModal === 1, `GET ${getsBeforeModal}회`);
    check("모달이 공통 조회 결과 재사용", pageHelpGetCount === getsBeforeModal, `클릭 전 ${getsBeforeModal}회 · 후 ${pageHelpGetCount}회`);
    check("열람 후 점 유지", (await dot.count()) === 1);
    check("열람 후 glow 유지", await trigger.evaluate((el) => el.classList.contains("admin-help-has-content")));
    await page.getByRole("button", { name: "닫기" }).click();
    check("모달 닫은 후 점 유지", (await dot.count()) === 1);
    check("열람으로 localStorage 키를 만들지 않음", await page.evaluate(() => Object.keys(localStorage).every((key) => !key.startsWith("admin-help-seen:"))));
    await page.reload({ waitUntil: "domcontentloaded" });
    await trigger.waitFor();
    await page.waitForFunction(() => document.querySelector(".admin-help-ping"));
    check("새로고침 후 점 유지", (await dot.count()) === 1);

    await api("PUT", `${contentPresent} 수정`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".admin-help-ping"));
    check("내용 수정 후 점 유지", (await dot.count()) === 1);

    for (const [label, value] of [["공백", " \n\t "], ["HTML 태그만", "<p><br></p>"], ["빈 문자열", ""]]) {
      await api("PUT", value);
      await page.reload({ waitUntil: "domcontentloaded" });
      await trigger.waitFor();
      await page.waitForTimeout(150);
      check(`${label}: 기본 스타일`, !(await trigger.evaluate((el) => el.classList.contains("admin-help-has-content"))) && (await dot.count()) === 0);
    }

    await api("PUT", contentPresent);
    for (const theme of ["light", "dark"]) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.evaluate((nextTheme) => document.documentElement.classList.toggle("dark", nextTheme === "dark"), theme);
      await page.waitForFunction(() => document.querySelector('[data-admin-help-trigger="page"]')?.classList.contains("admin-help-has-content"));
      check(`${theme} 모드 glow 표시`, await trigger.evaluate((el) => getComputedStyle(el).boxShadow !== "none"));
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    check("prefers-reduced-motion 애니메이션 비활성", await trigger.evaluate((el) => getComputedStyle(el).animationName === "none"));
    await page.emulateMedia({ reducedMotion: "no-preference" });

    for (const query of ["", "?mode=test", "?actAsTestUserId=verify", "?demoUserId=verify"]) {
      await page.goto(`${base}/admin${query}`, { waitUntil: "domcontentloaded" });
      await trigger.waitFor();
      await page.waitForFunction(() => document.querySelector('[data-admin-help-trigger="page"]')?.classList.contains("admin-help-has-content"));
      check(`화면 경로 공통 판정 ${query || "일반"}`, await trigger.evaluate((el) => el.getAttribute("aria-label")?.includes("안내 있음")));
    }

    const queryCases = ["", "&mode=test", "&actAsTestUserId=verify", "&demoUserId=verify"];
    const responses = await Promise.all(queryCases.map((query) => api("GET", undefined, query)));
    const baseline = responses[0].json.data;
    for (let index = 0; index < responses.length; index += 1) {
      const result = responses[index];
      check(
        `HTTP DTO/내용 동일 ${queryCases[index] || "일반"}`,
        result.status === 200 && JSON.stringify(Object.keys(result.json.data).sort()) === JSON.stringify(Object.keys(baseline).sort()) && result.json.data.content === baseline.content,
      );
    }

    await page.screenshot({ path: resolve(shotDir, "page-help-dark.png"), fullPage: true });

    await apiFor(helpKey, "PUT", contentPresent);
    await page.goto(`${base}/admin/periods/register`, { waitUntil: "domcontentloaded" });
    const keyTrigger = page.locator(`[data-help-key="${helpKey}"]`);
    await keyTrigger.waitFor();
    await page.waitForFunction((key) => document.querySelector(`[data-help-key="${key}"]`)?.classList.contains("admin-help-has-content"), helpKey);
    const keyDot = keyTrigger.locator('[data-admin-help-indicator="content"]');
    check("help key 설명 있음: 점/glow", (await keyDot.count()) === 1 && await keyTrigger.evaluate((el) => getComputedStyle(el).boxShadow !== "none"));
    await keyTrigger.click();
    await page.getByRole("dialog", { name: "등록", exact: true }).waitFor();
    check("help key 열람 후 점/glow 유지", (await keyDot.count()) === 1 && await keyTrigger.evaluate((el) => el.classList.contains("admin-help-has-content")));
    await page.getByRole("button", { name: "닫기" }).click();
    check("help key 모달 닫은 후 점 유지", (await keyDot.count()) === 1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction((key) => document.querySelector(`[data-help-key="${key}"]`)?.classList.contains("admin-help-has-content"), helpKey);
    check("help key 새로고침 후 점 유지", (await page.locator(`[data-help-key="${helpKey}"] [data-admin-help-indicator="content"]`).count()) === 1);
    await page.screenshot({ path: resolve(shotDir, "help-key-content.png"), fullPage: true });

    await apiFor(helpKey, "PUT", "<p><br></p>");
    await page.reload({ waitUntil: "domcontentloaded" });
    await keyTrigger.waitFor();
    await page.waitForTimeout(200);
    check("help key 실질적 빈 내용: 점/glow 없음", (await keyDot.count()) === 0 && !(await keyTrigger.evaluate((el) => el.classList.contains("admin-help-has-content"))));
    await page.screenshot({ path: resolve(shotDir, "help-key-empty.png"), fullPage: true });
  } finally {
    await api("PUT", originalContent);
    await apiFor(helpKey, "PUT", originalKeyContent);
    await browser.close();
  }
  console.log(`원본 도움말 복원: ${JSON.stringify(originalContent)}`);
  if (failures) throw new Error(`검증 실패 ${failures}건`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
