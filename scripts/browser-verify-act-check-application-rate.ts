/**
 * 브라우저 검증 — 액트 체크 신청율 (playwright-core).
 *   1) 목록 컬럼명 "액트 체크 신청율"(구 "액트 체크율" 부재)
 *   2) 상세 요약 명칭도 "액트 체크 신청율"
 *   3) 목록 렌더 수치 == 목록 DTO == 상세 DTO (화면-서버 정합)
 *   4) 신청율 컬럼 정렬 동작(aria-sort)
 *   5) 콘솔/네트워크 오류 없음
 *
 *   선행: npm run dev (:3000)
 *   npx tsx --env-file=.env.local scripts/browser-verify-act-check-application-rate.ts
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
function check(n: string, ok: boolean, d?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
}

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({
    email,
    token: (link as { properties: { email_otp: string } }).properties.email_otp,
    type: "magiclink",
  });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  const sess = (v as { session: { access_token: string; refresh_token: string } }).session;
  await server.auth.setSession({
    access_token: sess.access_token,
    refresh_token: sess.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name,
    value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

// "액트 체크율" 이 (신청율이 아닌 형태로) 남아 있는지 — 신청율 문자열 제거 후 검사.
function hasLegacyLabel(text: string): boolean {
  return text.replace(/액트 체크 신청율/g, "").includes("액트 체크율");
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("no health");
  } catch {
    console.log(`❌ dev server 미기동(${BASE})`);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const netErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().includes("/api/")) netErrors.push(`${r.status()} ${r.url()}`);
  });

  const org = "encre";
  await page.goto(`${BASE}/admin/team-parts/info/weeks?club=${org}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const listText = await page.locator("body").innerText();
  check("[목록] '액트 체크 신청율' 컬럼명 노출", listText.includes("액트 체크 신청율"));
  check("[목록] 구 명칭 '액트 체크율' 미노출", !hasLegacyLabel(listText));

  // 목록 DTO
  const apiList = (await page.evaluate(async (o) => {
    const r = await fetch(`/api/admin/team-parts/info/weeks?club=${o}&page=1&pageSize=5`, { cache: "no-store" });
    return r.json();
  }, org)) as { data?: { items?: Array<{ weekId: string; actCheck: Record<string, number> }> } };
  const first = apiList?.data?.items?.[0];
  check("[목록] actCheck DTO(원본 count 포함) 존재", !!first?.actCheck, first?.actCheck);

  if (first) {
    // 화면 렌더값 == DTO
    const rateCell = (await page.locator("[data-act-rate]").first().innerText()).trim();
    check("[목록] 화면 신청율 셀 == DTO applicationRate", rateCell === `${first.actCheck.applicationRate}%`, {
      cell: rateCell,
      dto: `${first.actCheck.applicationRate}%`,
    });

    // 목록 DTO == 상세 DTO
    const apiDetail = (await page.evaluate(
      async ([w, o]) => {
        const r = await fetch(`/api/admin/team-parts/info/weeks/${w}/act-check-management?club=${o}`, {
          cache: "no-store",
        });
        return r.json();
      },
      [first.weekId, org],
    )) as { data?: { summary?: Record<string, number> } };
    const d = apiDetail?.data?.summary;
    check("[정합] 목록 DTO == 상세 DTO", !!d && JSON.stringify(d) === JSON.stringify(first.actCheck), {
      list: first.actCheck,
      detail: d,
    });

    // (4) 정렬 동작 — 신청율 헤더 클릭 → aria-sort 변화
    const th = page.locator('th:has-text("액트 체크 신청율")').first();
    const before = await th.getAttribute("aria-sort");
    await th.locator("button").first().click();
    await page.waitForTimeout(1200);
    const after = await th.getAttribute("aria-sort");
    check("[목록] 신청율 정렬 aria-sort 변화", before !== after, { before, after });

    // (2) 상세 화면 명칭
    await page.goto(`${BASE}/admin/team-parts/info/weeks/${first.weekId}?club=${org}`, {
      waitUntil: "networkidle",
    });
    await page.waitForTimeout(1800);
    const detailText = await page.locator("body").innerText();
    check("[상세] '액트 체크 신청율' 노출", detailText.includes("액트 체크 신청율"));
    check("[상세] 구 명칭 '액트 체크율' 미노출", !hasLegacyLabel(detailText));
  }

  check("콘솔 오류 없음", consoleErrors.length === 0, consoleErrors.slice(0, 3));
  check("네트워크 4xx/5xx 없음", netErrors.length === 0, netErrors.slice(0, 3));

  await browser.close();
  console.log(`\n결과: ${failed === 0 ? "ALL PASS" : `${failed} FAIL`}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
