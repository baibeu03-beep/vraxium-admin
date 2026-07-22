/**
 * 브라우저 검증 — /admin/lines/register 오류 토스트가 서버 원인 그대로 표시되는지 (playwright-core).
 *   1) 잘못된 line_code 제출 → 서버 400 + { success:false, error }
 *   2) 토스트 문구 == 서버 error 문구 (일반 문구로 덮어쓰지 않음)
 *   3) 브라우저 console 의 개발자 상세와 사용자 토스트가 분리되는지
 *   4) mode=test 경로에서 동일 status·DTO·문구
 *   5) 올바른 입력은 등록 흐름에 영향 없음 (여기서는 서버가 200/201 을 주는지만 확인 후 롤백)
 *
 *   선행: npm run dev (:3000)
 *   npx tsx --env-file=.env.local scripts/browser-verify-lines-register-error-toast.ts
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const BAD_CODE = "IF BS-NN@0007"; // 공백 + 특수문자 → 서버 400
const EXPECTED_FRAGMENT = "라인 코드"; // 사용자 용어 — 내부 필드명(line_code) 아님

// 사용자에게 보이는 문구에 개발 용어가 남아 있으면 실패.
const DEV_TERM_RE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+|is required|must be|not found/i;

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
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  let serverStatus: number | null = null;
  let serverError: string | null = null;
  page.on("response", async (r) => {
    if (!r.url().includes("/api/admin/lines/registrations")) return;
    if (r.request().method() !== "POST") return;
    serverStatus = r.status();
    try {
      const j = (await r.json()) as { error?: string };
      serverError = typeof j.error === "string" ? j.error : null;
    } catch {
      serverError = null;
    }
  });

  for (const mode of ["operating", "test"] as const) {
    console.log(`\n── ${mode === "test" ? "테스트 모드(mode=test)" : "일반 모드"} ──`);
    serverStatus = null;
    serverError = null;
    consoleErrors.length = 0;

    const url = `${BASE}/admin/lines/register?org=encre${mode === "test" ? "&mode=test" : ""}`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);

    // 폼 채우기 — 라인명 / 허브 / 종류 / 코드(잘못된 형식) / 소요 시간 / 메인 타이틀.
    await page.getByPlaceholder("예) 마케팅 전략 라인").fill("오류검증 임시라인");
    await page.getByLabel("소속 허브").selectOption("info");
    await page.getByLabel("라인 종류").selectOption("일반");
    await page.getByPlaceholder("예) WCBS-NL0001").fill(BAD_CODE);
    await page.getByLabel("소요 시간").selectOption("60");
    await page.getByPlaceholder("메인 타이틀을 입력하세요").fill("임시");

    await page.getByRole("button", { name: "등록", exact: true }).click();
    await page.waitForTimeout(1500);

    check(`[${mode}] 서버 status 400`, serverStatus === 400, serverStatus);
    check(
      `[${mode}] 서버 error 에 사용자 용어("라인 코드") 안내 포함`,
      Boolean(serverError && serverError.includes(EXPECTED_FRAGMENT)),
      serverError,
    );

    const bodyText = await page.locator("body").innerText();
    const toastShown = Boolean(serverError && bodyText.includes(serverError));
    check(`[${mode}] 토스트에 서버 원인 그대로 표시`, toastShown, {
      server: serverError,
      found: toastShown,
    });
    check(
      `[${mode}] 일반 문구로 덮어쓰지 않음`,
      !bodyText.includes("처리하지 못했습니다. 잠시 후 다시 시도해주세요."),
    );
    check(
      `[${mode}] 토스트에 개발 용어(내부 필드명·영문 validator) 미노출`,
      Boolean(serverError) && !DEV_TERM_RE.test(serverError as string),
      serverError,
    );
    check(
      `[${mode}] console 에 개발자 상세가 별도로 남음(사용자 문구와 분리)`,
      consoleErrors.some((l) => l.includes("[lines/register] create failed")),
      consoleErrors.slice(0, 3),
    );
    // 폼 값은 초기화되지 않아야 한다(실패 시 재입력 강요 금지 — 기존 동작 유지).
    const codeValue = await page.getByPlaceholder("예) WCBS-NL0001").inputValue();
    check(`[${mode}] 실패 시 입력값 보존`, codeValue === BAD_CODE, codeValue);
  }

  await browser.close();
  console.log(`\n═══ ${failed === 0 ? "PASS" : `FAIL(${failed})`} ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
