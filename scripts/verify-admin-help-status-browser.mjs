import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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
const contentPresent = `도움말 상태 검증 ${Date.now()}`;
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
  const api = async (method, content, query = "") => {
    const response = await fetch(`${base}/api/admin/help?path=${encodeURIComponent(helpPath)}${query}`, {
      method,
      headers: { cookie: cookieHeader, "Content-Type": "application/json" },
      body: method === "PUT" ? JSON.stringify({ path: helpPath, content }) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };
  const original = await api("GET");
  if (original.status !== 200 || !original.json?.success) throw new Error("원본 도움말 조회 실패");
  const originalContent = original.json.data.content;

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
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("admin-help-seen:/admin:")) localStorage.removeItem(key);
    });
    pageHelpGetCount = 0;
    await page.reload({ waitUntil: "domcontentloaded" });
    await trigger.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-admin-help-trigger="page"]')?.classList.contains("admin-help-has-content"));
    check("설명 있음: glow", await trigger.evaluate((el) => getComputedStyle(el).boxShadow !== "none"));
    check("최초 미열람: 알림 점", (await dot.count()) === 1);
    check("최초 미열람: 유한 강조 클래스", await trigger.evaluate((el) => el.classList.contains("admin-help-nudge")));
    await trigger.hover();
    await page.waitForTimeout(300);
    check("등록 도움말 커스텀 툴팁", (await page.locator('[role="tooltip"]').textContent()) === "도움말이 등록되어 있습니다");

    const getsBeforeModal = pageHelpGetCount;
    await trigger.click();
    await page.locator('[role="dialog"]').waitFor();
    check("페이지 진입 시 help GET 1회", getsBeforeModal === 1, `GET ${getsBeforeModal}회`);
    check("모달이 공통 조회 결과 재사용", pageHelpGetCount === getsBeforeModal, `클릭 전 ${getsBeforeModal}회 · 후 ${pageHelpGetCount}회`);
    check("실제 열람 후 알림 점 제거", (await dot.count()) === 0);
    await page.getByRole("button", { name: "닫기" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await trigger.waitFor();
    check("새로고침 후 열람 상태 유지", (await dot.count()) === 0);

    await api("PUT", `${contentPresent} 수정`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".admin-help-ping"));
    check("내용 수정 후 다시 미열람", (await dot.count()) === 1);

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
  } finally {
    await api("PUT", originalContent);
    await browser.close();
  }
  console.log(`원본 도움말 복원: ${JSON.stringify(originalContent)}`);
  if (failures) throw new Error(`검증 실패 ${failures}건`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
