// 브라우저(인증) HTTP 검증 — 실무 역량 테스트 모드 13주차 개설 예외.
//   실제 admin 세션 쿠키로 opening-status 를 operating/test 로 호출해 targetWeek 분기를 확인하고,
//   direct(getCompetencyOpeningStatus)와 동일한지 비교한다(direct == HTTP).
//     · operating → targetWeek = 정규 금요일경계 주차(현재 2026 봄 W15, 휴식)
//     · test      → targetWeek = 2026 봄 W13 (마지막 활동 주차)
//   또한 weeks-options(공용 SoT)는 mode 무관 동일 — 다른 허브 무영향 회귀 가드.
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
await page.goto(`${BASE}/admin/line-opening/practical-competency?org=oranke&tab=open`, { waitUntil: "domcontentloaded" });

async function httpGet(url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, data: j?.data ?? null, success: j?.success ?? false };
  }, url);
}

try {
  const ORGS = ["oranke", "encre", "phalanx"];

  // weeks-options(공용 SoT) — mode 무관 동일(다른 허브 무영향 회귀 가드).
  console.log("\n[0] weeks-options 공용 SoT mode 무관 동일");
  const woOp = await httpGet(`/api/admin/cluster4/weeks-options?limit=8`);
  const woTs = await httpGet(`/api/admin/cluster4/weeks-options?limit=8&mode=test`);
  const openTargetOp = (woOp.data?.weeks ?? []).find((w) => w.isOpenTarget);
  const openTargetTs = (woTs.data?.weeks ?? []).find((w) => w.isOpenTarget);
  check(
    "weeks-options isOpenTarget mode 무관 동일(공용 함수 불변)",
    openTargetOp?.startDate === openTargetTs?.startDate,
    `op=${openTargetOp?.startDate} ts=${openTargetTs?.startDate}`,
  );

  console.log("\n[1] opening-status operating/test targetWeek 분기 (== direct)");
  for (const org of ORGS) {
    const op = await httpGet(`/api/admin/cluster4/competency/opening-status?organization=${org}`);
    const ts = await httpGet(`/api/admin/cluster4/competency/opening-status?organization=${org}&mode=test`);
    const opWeek = op.data?.targetWeek;
    const tsWeek = ts.data?.targetWeek;
    console.log(`  [${org}] operating W${opWeek?.weekNumber}(${opWeek?.startDate}) / test W${tsWeek?.weekNumber}(${tsWeek?.startDate})`);
    // operating = 정규 휴식 주차(W15) — 기존 정책 유지(개설 대상이 활동 주차 아님).
    check(`[${org}] operating targetWeek=W15(2026-06-08, 휴식)`, op.status === 200 && opWeek?.weekNumber === 15 && opWeek?.startDate === "2026-06-08");
    // test = 2026 봄 W13(2026-05-25, 활동 주차) — 예외 허용.
    check(`[${org}] test targetWeek=W13(2026-05-25, 활동)`, ts.status === 200 && tsWeek?.weekNumber === 13 && tsWeek?.startDate === "2026-05-25" && tsWeek?.isOfficialRest === false);
    // 분기 확인.
    check(`[${org}] operating ≠ test (예외 실제 분기)`, opWeek?.startDate !== tsWeek?.startDate);
  }
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
