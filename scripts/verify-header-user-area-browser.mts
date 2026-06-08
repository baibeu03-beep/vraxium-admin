/**
 * Header 우측 사용자 영역 UI 브라우저 검증 (Playwright).
 *   1) 로그아웃 버튼: size default(h-8=32px, text-sm=14px, font-semibold=600)
 *   2) 버튼 아래 세로 여백(mb-2=8px + flex gap-0.5=2px ≈ 10px)
 *   3) "반갑습니다! 😊" / "{이름} 님 | {이메일}" 두 줄 왼쪽 x좌표 일치(left-align)
 *
 *   사전조건: dev 서버 (http://localhost:3000).
 *   npx tsx --env-file=.env.local scripts/verify-header-user-area-browser.mts
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// playwright 는 admin repo 에 미설치 — 인접 고객 repo(../vraxium) 설치본을 재사용.
const requireFromFront = createRequire(
  new URL("../../vraxium/package.json", import.meta.url),
);
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeAdminCookies() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
  }));
}

type Metrics = {
  button: { x: number; y: number; w: number; h: number; fontSize: string; fontWeight: string; text: string };
  welcome: { x: number; y: number; text: string };
  nameLine: { x: number; y: number; text: string };
};

// page.evaluate 는 문자열 폼 사용 (경로/직렬화 이슈 회피 — 기존 검증 스크립트 관례).
const MEASURE = `(() => {
  const header = document.querySelector("header");
  if (!header) return { error: "no header" };
  const btn = header.querySelector('button[aria-label="로그아웃"]');
  if (!btn) return { error: "no logout button" };
  const spans = [...header.querySelectorAll("span")];
  const welcome = spans.find((s) => s.textContent && s.textContent.includes("반갑습니다"));
  const nameLine = spans.find((s) => s.textContent && s.textContent.includes("님"));
  if (!welcome || !nameLine) return { error: "missing text lines" };
  const bb = btn.getBoundingClientRect();
  const wb = welcome.getBoundingClientRect();
  const nb = nameLine.getBoundingClientRect();
  const cs = getComputedStyle(btn);
  return {
    button: { x: bb.x, y: bb.y, w: bb.width, h: bb.height, fontSize: cs.fontSize, fontWeight: cs.fontWeight, text: (btn.textContent || "").trim() },
    welcome: { x: wb.x, y: wb.y, text: (welcome.textContent || "").trim() },
    nameLine: { x: nb.x, y: nb.y, text: (nameLine.textContent || "").trim() },
  };
})()`;

async function measureOn(page: import("playwright").Page, path: string, shot: string) {
  await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle", timeout: 60000 });
  const m = (await page.evaluate(MEASURE)) as Metrics & { error?: string };
  if (m.error) throw new Error(`${path}: ${m.error}`);
  console.log(`\n[${path}]`);
  console.log(`  버튼: ${JSON.stringify(m.button)}`);
  console.log(`  환영: x=${m.welcome.x.toFixed(1)} y=${m.welcome.y.toFixed(1)} "${m.welcome.text}"`);
  console.log(`  이름: x=${m.nameLine.x.toFixed(1)} y=${m.nameLine.y.toFixed(1)} "${m.nameLine.text}"`);

  // 1) 버튼 크기: size default = h-8(32px), text-sm(14px), font-semibold(600)
  check(`${path} 버튼 높이 h-8=32px`, Math.round(m.button.h) === 32, `실제=${m.button.h}px`);
  check(`${path} 버튼 폰트 text-sm=14px`, m.button.fontSize === "14px", `실제=${m.button.fontSize}`);
  check(`${path} 버튼 font-semibold=600`, m.button.fontWeight === "600", `실제=${m.button.fontWeight}`);

  // 2) 버튼-환영문구 세로 여백: mb-2(8px)+gap-0.5(2px)=10px (±1px 허용)
  const gap = m.welcome.y - (m.button.y + m.button.h);
  check(`${path} 버튼 아래 여백 ≈10px`, Math.abs(gap - 10) <= 1.5, `실제=${gap.toFixed(1)}px`);

  // 3) 두 줄 왼쪽 시작 x좌표 일치 (서브픽셀 1px 미만 허용)
  const dx = Math.abs(m.welcome.x - m.nameLine.x);
  check(`${path} 두 줄 left x좌표 일치`, dx < 1, `환영=${m.welcome.x.toFixed(2)} 이름=${m.nameLine.x.toFixed(2)} Δ=${dx.toFixed(2)}px`);

  // 헤더 영역만 잘라 스크린샷
  const header = await page.locator("header").first().boundingBox();
  await page.screenshot({
    path: shot,
    clip: header
      ? { x: 0, y: 0, width: 1440, height: Math.ceil(header.y + header.height + 8) }
      : undefined,
  });
  console.log(`  screenshot: ${shot}`);
}

const cookies = await makeAdminCookies();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(cookies as never);
const page = await context.newPage();

await measureOn(page, "/admin", "claudedocs/verify-header-user-area-home.png");
await measureOn(page, "/admin/members", "claudedocs/verify-header-user-area-members.png");

await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
