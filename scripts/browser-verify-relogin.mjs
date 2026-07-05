// 실제 브라우저 반복 검증 — 자동 로그아웃 직후 재로그인 레이스.
//
// 재현하는 상태(비밀번호 폼 downstream 전체):
//   · 클라이언트 주도 idle 로그아웃은 sb-* 를 지우지만 httpOnly `admin_last_active`
//     는 지우지 못해 이전 세션의 stale 마커가 살아남는다.
//   · 곧바로 재로그인하면 새 세션의 sb-* 가 발급된다(다른 session_id).
//   ⇒ 이 순간의 상태 = 새 세션 sb-* + 이전 세션의 stale `admin_last_active`.
//
// 각 반복에서 실제 미들웨어 + LoginForm 이 호출하는 실제 확인 API
// (/api/admin/debug-session) 를 그대로 통과시켜 검증한다.
//
// 실행: node scripts/browser-verify-relogin.mjs
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
const ITERATIONS = Number(process.env.RELOGIN_ITERATIONS ?? 6);
const ERROR_MSG = "로그인 세션을 서버에서 확인하지 못했습니다";

function sessionIdFromJwt(token) {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")).session_id ?? null;
  } catch {
    return null;
  }
}

async function makeSession() {
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
  const cookies = captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
  return { cookies, sessionId: sessionIdFromJwt(verifyData.session.access_token) };
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const isLogin = (url) => /\/login/.test(url);
const isAdmin = (url) => /\/admin(\b|\/|$)/.test(url) && !isLogin(url);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const oldTs = Date.now() - 60 * 60 * 1000; // 1시간 전(20분 창 초과)

try {
  // ── 재로그인 레이스 반복 ──
  console.log(`\n[재로그인 레이스] 자동 로그아웃 직후 재로그인 ${ITERATIONS}회 반복`);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const prior = await makeSession();  // 이전(자동 로그아웃된) 세션
    const fresh = await makeSession();  // 재로그인으로 방금 발급된 세션
    const ctx = await browser.newContext();
    // 재로그인 순간의 실제 쿠키 상태: 새 세션 sb-* + 이전 세션의 stale httpOnly 마커.
    await ctx.addCookies(fresh.cookies);
    await ctx.addCookies([{
      name: "admin_last_active", value: `${oldTs}.${prior.sessionId}`,
      domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
    }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });

    const onAdmin = isAdmin(page.url());
    const bodyText = await page.evaluate(() => document.body.textContent ?? "");
    const noError = !bodyText.includes(ERROR_MSG);
    // LoginForm 이 로그인 직후 호출하는 실제 확인 API 를 페이지 컨텍스트(=새 쿠키 포함)로 호출.
    const probe = await page.evaluate(async () => {
      const r = await fetch("/api/admin/debug-session", { cache: "no-store", credentials: "include" });
      return { status: r.status, ok: r.ok };
    });

    check(
      `#${i + 1} 재로그인 성공(/admin 유지·에러문구 없음·debug-session 200)`,
      onAdmin && noError && probe.status === 200,
      `url=${page.url()} probe=${probe.status} err=${noError ? "none" : "SHOWN"}`,
    );
    await ctx.close();
  }

  // ── 대조군: 진짜 미사용(동일 세션·stale) → /login?reason=idle 로 리다이렉트 ──
  console.log("\n[대조군] 진짜 미사용(동일 세션) → /login?reason=idle 리다이렉트 유지");
  {
    const s = await makeSession();
    const ctx = await browser.newContext();
    await ctx.addCookies(s.cookies);
    await ctx.addCookies([{
      name: "admin_last_active", value: `${oldTs}.${s.sessionId}`,
      domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
    }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
    check("동일 세션 stale → /login?reason=idle", isLogin(page.url()) && /reason=idle/.test(page.url()), page.url());
    await ctx.close();
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
