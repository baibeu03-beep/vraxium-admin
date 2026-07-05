// 브라우저(인증 세션) 검증 — 표준 쿠키 기반 어드민 세션 정책.
//
// 검증 시나리오
//   A. 여러 탭/창에서 로그인 상태 공유(같은 프로필)
//   B. 새로고침·페이지 이동·뒤로가기 → 로그인 유지
//   C. 한 탭 로그아웃 브로드캐스트 → 다른 탭 즉시 로그아웃(/login)
//   D. 미사용 자동 로그아웃(서버 SoT): 오래된 admin_last_active → API 401 / 페이지 /login?reason=idle
//      + 정상 요청은 admin_last_active 를 슬라이딩 갱신
//   E. 브라우저 종료 후 재로그인: 인증 쿠키가 세션 쿠키(Max-Age/Expires 없음)인지
//   F. HTTP API: 인증 200 / 미인증 401
//
// 실행: node scripts/browser-verify-standard-session.mjs
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

// Decode the (already-trusted) session id from a JWT so idle can be simulated
// faithfully: real idle keeps the SAME session_id, only the timestamp goes old.
function sessionIdFromJwt(token) {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")).session_id ?? null;
  } catch {
    return null;
  }
}

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
  const cookies = captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
  cookies.sessionId = sessionIdFromJwt(verifyData.session.access_token);
  return cookies;
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const isLogin = (url) => /\/login/.test(url);
const isAdmin = (url) => /\/admin(\b|\/|$)/.test(url) && !isLogin(url);
const loginFormVisible = (page) =>
  page.evaluate(() => !!document.body.textContent?.includes("Admin Login"));
const getSetCookie = (res) => {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
};

const browser = await chromium.launch({ channel: "chromium", headless: true });

try {
  const cookies = await makeAdminCookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  // ── A) 여러 탭/창 로그인 공유 ──
  console.log("\n[A] 같은 프로필 여러 탭/창 로그인 공유");
  const ctx = await browser.newContext();
  await ctx.addCookies(cookies);
  const tab1 = await ctx.newPage();
  const tab2 = await ctx.newPage();
  await tab1.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await tab2.goto(`${BASE}/admin/members?org=encre`, { waitUntil: "networkidle" });
  check("탭1 로그인 상태(/admin)", isAdmin(tab1.url()) && !(await loginFormVisible(tab1)), tab1.url());
  check("탭2 로그인 상태(/members)", isAdmin(tab2.url()) && !(await loginFormVisible(tab2)), tab2.url());
  // 새 창(같은 컨텍스트=같은 프로필)
  const win2 = await ctx.newPage();
  await win2.goto(`${BASE}/admin/processes/info?org=encre`, { waitUntil: "networkidle" });
  check("새 창도 로그인 공유", isAdmin(win2.url()) && !(await loginFormVisible(win2)), win2.url());
  await win2.close();

  // ── B) 새로고침·이동·뒤로가기 ──
  console.log("\n[B] 새로고침·페이지 이동·뒤로가기 → 유지");
  await tab1.reload({ waitUntil: "networkidle" });
  check("새로고침 유지", isAdmin(tab1.url()) && !(await loginFormVisible(tab1)));
  await tab1.goto(`${BASE}/admin/members?org=encre`, { waitUntil: "networkidle" });
  check("페이지 이동 유지", isAdmin(tab1.url()) && !(await loginFormVisible(tab1)));
  await tab1.goto(`${BASE}/admin/processes/info?org=encre`, { waitUntil: "networkidle" });
  await tab1.goBack({ waitUntil: "networkidle" });
  check("뒤로가기 유지", isAdmin(tab1.url()) && !(await loginFormVisible(tab1)), tab1.url());

  // ── C) 탭 간 즉시 로그아웃(BroadcastChannel) ──
  console.log("\n[C] 한 탭 로그아웃 브로드캐스트 → 다른 탭 즉시 로그아웃");
  await tab2.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await tab2.waitForTimeout(700); // AdminSessionManager useEffect(구독) 활성화 대기
  // 탭1에서 로그아웃 신호를 방송(실제 로그아웃 버튼과 동일한 채널/메시지).
  await tab1.evaluate(() => {
    const bc = new BroadcastChannel("admin-auth");
    bc.postMessage({ type: "logout" });
    bc.close();
  });
  await tab2.waitForURL(/\/login/, { timeout: 8000 }).catch(() => {});
  check("다른 탭이 /login 으로 이동", isLogin(tab2.url()), tab2.url());
  await ctx.close();

  // HTTP 섹션은 Playwright 트래픽으로 토큰이 회전되지 않은 신선한 세션을 별도로 발급해 사용한다.
  const httpCookies = await makeAdminCookies();
  const httpHeader = httpCookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const oldTs = Date.now() - 60 * 60 * 1000; // 1시간 전(모든 15~30분 창 초과)
  // 진짜 미사용은 "동일 세션"에서 시간만 흐른 것 → 마커를 현재 세션 id 로 키잉해야
  // 충실한 시뮬레이션이다(재로그인=다른 세션 id 와 구분).
  const idleMarker = `${oldTs}.${httpCookies.sessionId}`;

  // ── D) 미사용 자동 로그아웃(서버 SoT, HTTP) ──
  console.log("\n[D] 미사용 자동 로그아웃(서버 enforcement)");
  // 정상(활동시각 쿠키 없음) 요청 → 200 + admin_last_active 슬라이딩 갱신(세션키 형식)
  const freshApi = await fetch(`${BASE}/api/admin/me`, { headers: { cookie: httpHeader, connection: "close" } });
  const freshCookies = getSetCookie(freshApi);
  check("정상 요청 → 200", freshApi.status === 200, `status=${freshApi.status}`);
  check("정상 요청이 admin_last_active 슬라이딩 갱신(ts.sessionId)",
    freshCookies.some((c) => /^admin_last_active=\d+\.[0-9a-f-]{36}/.test(c)),
    freshCookies.filter((c) => /admin_last_active/.test(c)).join(" | ") || "(none)");
  // API + 오래된 활동시각(동일 세션) → 401 + sb 인증 쿠키 만료
  const idleApi = await fetch(`${BASE}/api/admin/me`, {
    headers: { cookie: `${httpHeader}; admin_last_active=${idleMarker}`, connection: "close" },
    redirect: "manual",
  });
  check("오래된 세션 API(동일 세션) → 401", idleApi.status === 401, `status=${idleApi.status}`);
  const clears = getSetCookie(idleApi);
  check("응답이 sb 인증 쿠키를 만료시킴", clears.some((c) => /^sb-/.test(c) && /(Max-Age=0|Expires=)/i.test(c)),
    clears.filter((c) => /^sb-/.test(c)).join(" | ") || `${clears.length} set-cookie`);
  // 페이지 + 오래된 활동시각(동일 세션) → /login?reason=idle 리다이렉트
  const idlePage = await fetch(`${BASE}/admin`, {
    headers: { cookie: `${httpHeader}; admin_last_active=${idleMarker}`, connection: "close" },
    redirect: "manual",
  });
  const loc = idlePage.headers.get("location") ?? "";
  check("오래된 세션 페이지(동일 세션) → /login?reason=idle 리다이렉트",
    [301, 302, 307, 308].includes(idlePage.status) && /\/login/.test(loc) && /reason=idle/.test(loc),
    `status=${idlePage.status} loc=${loc}`);
  // 재로그인 레이스: 새 세션 + 이전 세션의 stale 마커(다른 session id) → 로그아웃되면 안 됨(200)
  const priorCookies = await makeAdminCookies();
  const relogin = await fetch(`${BASE}/api/admin/me`, {
    headers: { cookie: `${httpHeader}; admin_last_active=${oldTs}.${priorCookies.sessionId}`, connection: "close" },
    redirect: "manual",
  });
  check("재로그인(이전 세션 stale 마커) → 200(로그아웃 안 됨)", relogin.status === 200,
    `status=${relogin.status} prior=${String(priorCookies.sessionId).slice(0, 8)} cur=${String(httpCookies.sessionId).slice(0, 8)}`);

  // ── E) 브라우저 종료 후 재로그인: 세션 쿠키 여부 ──
  console.log("\n[E] 인증 쿠키가 세션 쿠키(브라우저 종료 시 소멸)인지");
  const lastActiveCookie = freshCookies.find((c) => /^admin_last_active=/.test(c)) ?? "";
  check("admin_last_active=세션 쿠키(Max-Age/Expires 없음)",
    !!lastActiveCookie && !/Max-Age=/i.test(lastActiveCookie) && !/Expires=/i.test(lastActiveCookie),
    lastActiveCookie);

  // ── F) HTTP API 인증 게이트 ──
  console.log("\n[F] HTTP API 인증 게이트");
  const anon = await fetch(`${BASE}/api/admin/me`, { headers: { connection: "close" } });
  check("미인증 → 401", anon.status === 401, `status=${anon.status}`);
  const authed = await fetch(`${BASE}/api/admin/me`, { headers: { cookie: httpHeader, connection: "close" } });
  check("인증 → 200", authed.status === 200, `status=${authed.status}`);
  const hbAnon = await fetch(`${BASE}/api/admin/session/heartbeat`, { headers: { connection: "close" } });
  const hbAuth = await fetch(`${BASE}/api/admin/session/heartbeat`, { headers: { cookie: httpHeader, connection: "close" } });
  check("heartbeat 미인증 → 401", hbAnon.status === 401, `status=${hbAnon.status}`);
  check("heartbeat 인증 → 204", hbAuth.status === 204, `status=${hbAuth.status}`);

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
