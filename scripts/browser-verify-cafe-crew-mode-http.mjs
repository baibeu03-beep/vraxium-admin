// 브라우저(인증) HTTP 검증 — 라인 개설 크루 매칭 mode 스코프.
//   실제 admin 세션 쿠키로 /api/admin/cluster4/cafe-line-crew GET 을 operating/test 로 호출,
//   operating=실사용자만(T 접두 없음) / test=테스트 사용자만(T 접두) 확인.
//   manual GET 과 cafe POST 는 동일 loadScopedCrews 를 공유하므로 이 검증이 양쪽을 대표한다.
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

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
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

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto(`${BASE}/admin/line-opening/practical-info?org=oranke&tab=open`, { waitUntil: "domcontentloaded" });

// 실제 HTTP(인증 세션) — page 컨텍스트에서 fetch.
async function httpCrews(org, mode, q) {
  const sp = new URLSearchParams({ q });
  if (org) sp.set("organization", org);
  if (mode === "test") sp.set("mode", "test");
  return page.evaluate(async (url) => {
    const r = await fetch(url);
    const j = await r.json();
    return { status: r.status, crews: j?.data?.crews ?? [] };
  }, `/api/admin/cluster4/cafe-line-crew?${sp.toString()}`);
}

try {
  const ORG = "oranke";
  const Q = "지"; // 광범위 — 실/테스트 양쪽 매칭 유도

  console.log("\n[HTTP operating]");
  const op = await httpCrews(ORG, "operating", Q);
  const opTest = op.crews.filter((c) => (c.name ?? "").startsWith("T"));
  check("operating 200", op.status === 200, `status=${op.status}`);
  check("operating 결과에 테스트(T 접두) 0명", opTest.length === 0, `count=${op.crews.length}, T=${opTest.length}`);

  console.log("\n[HTTP test]");
  const ts = await httpCrews(ORG, "test", Q);
  const tsReal = ts.crews.filter((c) => !(c.name ?? "").startsWith("T"));
  check("test 200", ts.status === 200, `status=${ts.status}`);
  check("test 결과 전원 테스트(T 접두), 실사용자 0명", ts.crews.length > 0 && tsReal.length === 0, `count=${ts.crews.length}, real=${tsReal.length}`);

  // operating ∩ test 겹침 0 (userId 기준)
  const tsIds = new Set(ts.crews.map((c) => c.userId));
  const overlap = op.crews.filter((c) => tsIds.has(c.userId));
  check("operating ∩ test 겹침 0", overlap.length === 0, `overlap=${overlap.length}`);

  console.log(`\n  operating 표본: ${op.crews.slice(0, 3).map((c) => c.name).join(", ")}`);
  console.log(`  test 표본: ${ts.crews.slice(0, 3).map((c) => c.name).join(", ")}`);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
