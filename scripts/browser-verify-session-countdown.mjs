// 브라우저(인증 세션) 검증 — 헤더 자동 로그아웃 카운트다운.
//   · 헤더에 "자동 로그아웃까지 mm:ss" 표시 · data-level 색상 규칙 일치
//   · 매초 감소(틱) · 활동(클릭) 시 즉시 리셋(증가)
//   · (WAIT_LOGOUT_MS 설정 시) 미사용 지속 → /login?reason=idle 자동 이동
// env: SMOKE_BASE_URL, EXPECT_FULL_WINDOW=1(기본 20분 서버), WAIT_LOGOUT_MS=16000(짧은 서버)
// 실행: node scripts/browser-verify-session-countdown.mjs
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
const EXPECT_FULL_WINDOW = process.env.EXPECT_FULL_WINDOW === "1";
const WAIT_LOGOUT_MS = process.env.WAIT_LOGOUT_MS ? Number(process.env.WAIT_LOGOUT_MS) : 0;
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

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

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const expectedLevel = (sec) => (sec <= 60 ? "danger" : sec <= 300 ? "warning" : "normal");

async function readCountdown(page) {
  const el = page.getByTestId("admin-session-countdown");
  const text = (await el.textContent())?.trim() ?? "";
  const level = await el.getAttribute("data-level");
  const m = text.match(/(\d{2}):(\d{2})/);
  const seconds = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  return { text, level, seconds };
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const ctx = await browser.newContext();
  await ctx.addCookies(await makeAdminCookies());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600); // 하이드레이션 + 첫 틱

  // 1) 표시 & 포맷
  const c0 = await readCountdown(page);
  check("헤더에 카운트다운 표시", /자동 로그아웃까지 \d{2}:\d{2}/.test(c0.text), c0.text);
  check("mm:ss 파싱 가능", Number.isFinite(c0.seconds), `${c0.seconds}s`);

  // 2) 기본 20:00(가득) — 기본 서버에서만
  if (EXPECT_FULL_WINDOW) {
    check("기본 진입 시 ~20:00(가득 창)", c0.seconds >= 1150 && c0.seconds <= 1201, `${c0.text}`);
  }

  // 3) 색상 규칙(data-level) 일치
  check("색상 레벨 규칙 일치", c0.level === expectedLevel(c0.seconds), `level=${c0.level} sec=${c0.seconds}`);

  // 4) 매초 감소(틱) — 무활동 3.5초
  await page.waitForTimeout(3500);
  const c1 = await readCountdown(page);
  check("무활동 시 카운트다운 감소", c1.seconds < c0.seconds, `${c0.text} → ${c1.text}`);

  // 5) 활동(클릭) 시 즉시 리셋(증가)
  await page.mouse.click(5, 5);
  await page.waitForTimeout(250);
  const c2 = await readCountdown(page);
  check("활동 시 카운트다운 리셋(증가)", c2.seconds > c1.seconds + 1, `${c1.text} → ${c2.text}`);

  // 6) 자동 로그아웃 — 짧은 서버에서만
  if (WAIT_LOGOUT_MS > 0) {
    console.log(`  … 무활동 ${Math.round(WAIT_LOGOUT_MS / 1000)}초 대기(자동 로그아웃 관찰)`);
    await page.waitForURL(/\/login/, { timeout: WAIT_LOGOUT_MS + 6000 }).catch(() => {});
    const url = page.url();
    check("미사용 지속 → /login?reason=idle 자동 이동",
      /\/login/.test(url) && /reason=idle/.test(url), url);
    check("로그인 폼 렌더", await page.evaluate(() => !!document.body.textContent?.includes("Admin Login")));
  }

  await ctx.close();
  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
