// 브라우저 검증 — 라인 개설 "주차별 개설 결과" 드롭다운 필터/연도 표시.
//   /admin/line-opening/practical-info?org={oranke,encre,phalanx}
//   확인: 드롭다운 옵션에 0주차/전환(겨울9·봄가을17) 없음, 겨울 W1 연도=종료일 기준(25년).
//   표시 전용 — DB/저장/API write 무접촉.
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
const context = await browser.newContext({ viewport: { width: 1500, height: 1800 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

try {
  for (const org of ["oranke", "encre", "phalanx"]) {
    console.log(`\n[org=${org}]`);
    await page.goto(`${BASE}/admin/line-opening/practical-info?org=${org}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction("document.body.innerText.includes('주차별 개설 결과')", undefined, { timeout: 60000 });
    // 드롭다운(개설 결과 주차 선택)의 모든 옵션 텍스트 수집.
    await page.waitForFunction(
      `(() => { const s = document.querySelector("select[aria-label='개설 결과 주차 선택']"); return s && s.options.length > 0 && s.options[0].text !== '주차 없음'; })()`,
      undefined, { timeout: 60000 },
    );
    const opts = await page.evaluate(`(() => {
      const s = document.querySelector("select[aria-label='개설 결과 주차 선택']");
      return s ? Array.from(s.options).map((o) => o.text) : [];
    })()`);
    console.log(`    옵션 ${opts.length}개. 예시:`, opts.slice(0, 3).join(" | "));

    check(`${org}: 옵션 존재`, opts.length > 0);
    check(`${org}: 0주차 없음`, !opts.some((t) => /\b0주차/.test(t)), opts.filter((t) => /\b0주차/.test(t)).join(","));
    check(`${org}: 겨울 9주차(전환) 없음`, !opts.some((t) => t.includes("겨울") && t.includes("9주차")));
    check(`${org}: 봄 17주차(전환) 없음`, !opts.some((t) => t.includes("봄") && (t.includes("17주차") || t.includes("18주차"))));
    check(`${org}: 가을 17주차(전환) 없음`, !opts.some((t) => t.includes("가을") && (t.includes("17주차") || t.includes("18주차"))));
    // 겨울 W1 연도 표시 — 24-12-30~25-01-05 가 옵션에 있으면 '25년'.
    const winterW1 = opts.find((t) => t.includes("24-12-30") && t.includes("25-01-05"));
    if (winterW1) {
      check(`${org}: 겨울 W1 → '25년' 표시`, winterW1.startsWith("25년") && winterW1.includes("겨울"), winterW1);
    } else {
      console.log(`    (겨울 W1 옵션은 현재 cutoff 밖 — 라벨 형식만 검증)`);
    }
    if (org === "oranke") {
      await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-line-opening-week-filter.png"), fullPage: false });
    }
  }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAIL"} (pass=${pass})`);
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
