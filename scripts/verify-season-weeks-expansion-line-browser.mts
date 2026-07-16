/**
 * /admin/season-weeks 표 헤더 브라우저 검증 + 스크린샷.
 *   · "주차 코드" 헤더(구 "이름") 노출 / "이름" 헤더 미노출
 *   · [2026-07-16 정책] "[실무 경험] > 확장 류 라인" 컬럼은 제거됨 → 헤더 미노출(회귀 가드).
 *     확장 여부의 단일 SoT 를 주차 상세 저장값으로 일원화하면서 이 표에서 내렸다.
 *     (서버 DTO experienceExpansionLineMode 는 API 호환용으로 유지되나 렌더하지 않는다.)
 * 사전조건: dev :3000.
 * npx tsx --env-file=.env.local scripts/verify-season-weeks-expansion-line-browser.mts
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const requireFromFront = createRequire(
  new URL("../../vraxium/package.json", import.meta.url),
);
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeAdminCookies() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  const otp = linkData?.properties?.email_otp;
  if (!otp) throw new Error("generateLink failed");
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: otp,
    type: "magiclink",
  });
  if (!verifyData?.session) throw new Error("verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
  }));
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  await page.goto(`${baseUrl}/admin/season-weeks`, { waitUntil: "networkidle" });
  await page.waitForSelector("table tbody tr", { timeout: 15000 });

  const headers = await page.$$eval("table thead th", (ths) =>
    ths.map((th) => th.textContent?.replace(/\s+/g, " ").trim() ?? ""),
  );
  console.log("헤더:", JSON.stringify(headers));

  const nameIdx = headers.findIndex((h) => h.includes("주차 코드"));
  const expIdx = headers.findIndex((h) => h.includes("확장 류 라인"));

  check('"주차 코드" 헤더(구 "이름") 노출', nameIdx >= 0);
  check('"이름" 헤더 미노출', !headers.some((h) => h === "이름" || h.startsWith("이름")));
  // 회귀 가드 — 확장 류 라인 컬럼은 제거됐어야 한다(헤더/셀 모두 미노출).
  check('"[실무 경험] > 확장 류 라인" 헤더 미노출(컬럼 제거됨)', expIdx < 0, `expIdx=${expIdx}`);
  check(
    '확장 라벨(진행 없음/온라인/오프라인) 셀 미렌더',
    !headers.some((h) => h.includes("확장")),
    `headers=${JSON.stringify(headers)}`,
  );

  const screenshotPath =
    "claudedocs/qa-season-weeks-expansion-line-column-removed.png";
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`스크린샷: ${screenshotPath}`);

  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
