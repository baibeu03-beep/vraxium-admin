// 브라우저 검증 — 공통 Confirm UI(components/ui/confirm-dialog).
//   대상: /admin/processes/register 액트 폼 [초기화] 버튼.
//   1) 초기화 클릭 시 확인 다이얼로그(role=alertdialog) 표시
//   2) [취소] 클릭 시 입력값 유지(초기화 실행 안 됨)
//   3) [초기화] 확인 클릭 시에만 입력값 비워짐
//   전제: dev 서버(localhost:3000) 기동.
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
const EMAIL = "vanuatu.golden@gmail.com", BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function cookies() {
  const browser = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies(await cookies());
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/admin/processes/register`, { waitUntil: "networkidle" });

    const input = page.getByPlaceholder("예) [브리핑] 클럽 시작");
    await input.waitFor({ state: "visible", timeout: 15000 });
    const SAMPLE = "ZZ-confirm-검증-액트";
    await input.fill(SAMPLE);
    ck("액트명 입력", (await input.inputValue()) === SAMPLE);

    const resetBtn = page.getByRole("button", { name: "초기화", exact: true });
    const dialog = page.getByRole("alertdialog");

    // 1) 초기화 클릭 → 확인 다이얼로그 표시
    await resetBtn.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ck("1) 초기화 클릭 시 확인 다이얼로그 표시", await dialog.isVisible());
    ck("   안내 문구 노출", (await dialog.textContent())?.includes("초기화하시겠습니까"));

    // 2) 취소 → 입력값 유지
    await dialog.getByRole("button", { name: "취소" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    ck("2) 취소 시 다이얼로그 닫힘", !(await dialog.isVisible()));
    ck("2) 취소 시 입력값 유지", (await input.inputValue()) === SAMPLE, `value="${await input.inputValue()}"`);

    // 3) 초기화 → 확인 → 입력값 비워짐
    await resetBtn.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await dialog.getByRole("button", { name: "초기화", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    ck("3) 확인 클릭 시에만 초기화 실행", (await input.inputValue()) === "", `value="${await input.inputValue()}"`);
  } catch (e) {
    ck("실행 오류", false, String(e?.message ?? e));
  } finally {
    await browser.close();
    console.log(`\n  결과: ${pass} pass / ${fail} fail`);
    process.exit(fail ? 1 : 0);
  }
})();
