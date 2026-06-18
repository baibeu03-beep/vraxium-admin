// 브라우저 검증 — 저장/완료 계열 Confirm 게이트 동작(네트워크 인터셉트로 net-zero).
//
//   Scenario A — 검수 신청 완료(ProcessIrregularDialog, /admin/processes/check/irregular)
//     A1 validation 실패 → 확인창 안 뜸·API 호출 0·팝업 유지
//     A2 확인창 표시 → 취소 → API 호출 0·입력값 유지·팝업 유지
//     A3 확인 → API 호출(실패 500) → 팝업 유지 + 에러 배너
//     A4 확인 → API 호출(성공) → 팝업 닫힘
//   Scenario B — 저장(ProcessRegisterManager 라인급 등록, /admin/processes/register)
//     B1 validation 실패 → 확인창 안 뜸·API 호출 0
//     B2 확인창 표시 → 취소 → API 호출 0·입력값 유지
//     B3 확인 → API 호출(실패 500) → 에러 배너·입력값 유지
//     B4 확인 → API 호출(성공) → 입력값 비워짐
//
//   POST 는 전부 라우트 인터셉트(서버 미도달) → DB 무변경. GET(board/loadHub)은 그대로 통과.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies(await cookies());
  const page = await ctx.newPage();

  // POST 인터셉트 — 시나리오별 동작을 mutable 로 전환.
  let postBehavior = "pass"; // "fail" | "success"
  let postCount = 0;
  const installPostRoute = async (pattern) => {
    await page.route(pattern, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      postCount++;
      if (postBehavior === "fail")
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false, error: "강제 실패(검증용)" }) });
      if (postBehavior === "success")
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { id: "00000000-0000-0000-0000-000000000000" } }) });
      return route.continue();
    });
  };

  const dialog = page.getByRole("alertdialog"); // 확인창(Confirm)

  try {
    // ─────────────────────────────────────────────────────────────
    // Scenario A — 검수 신청 완료
    // ─────────────────────────────────────────────────────────────
    console.log("\n[A] 검수 신청 완료 (ProcessIrregularDialog)");
    await installPostRoute("**/api/admin/processes/check/irregular");
    await page.goto(`${BASE}/admin/processes/check/irregular?org=oranke&mode=test`, { waitUntil: "networkidle" });

    const openReview = page.getByRole("button", { name: "검수 신청", exact: true });
    await openReview.waitFor({ state: "visible", timeout: 15000 });
    await page.waitForFunction(
      () => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "검수 신청"); return b && !b.disabled; },
      { timeout: 15000 },
    ).catch(() => {});
    await openReview.click();

    const submitReview = page.getByRole("button", { name: "체크 신청", exact: true });
    await submitReview.waitFor({ state: "visible", timeout: 5000 });
    ck("팝업(검수 신청) 열림", await submitReview.isVisible());

    // A1) validation 실패 — 빈 입력으로 제출 → 확인창 안 뜸·호출 0
    postBehavior = "pass"; postCount = 0;
    await submitReview.click();
    await sleep(400);
    ck("A1) validation 실패 시 확인창 안 뜸", !(await dialog.isVisible()));
    ck("A1) validation 실패 시 API 호출 0", postCount === 0, `count=${postCount}`);
    ck("A1) validation 실패 시 팝업 유지", await submitReview.isVisible());
    ck("A1) 에러 배너 표시", await page.getByText("액트명을 입력해주세요").isVisible());

    // 유효 입력 채우기
    const tomorrow = new Date(Date.now() + 86_400_000);
    const dstr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    await page.getByPlaceholder("변동 액트명").fill("ZZ-검증-검수신청");
    await page.getByPlaceholder("https://cafe.naver.com/...").fill("https://cafe.naver.com/oranke/12345");
    await page.locator('input[type="date"]').fill(dstr);
    await page.getByLabel("검수 시각").selectOption("12:00");

    // A2) 확인창 표시 → 취소 → 호출 0·입력값 유지
    postBehavior = "pass"; postCount = 0;
    await submitReview.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    ck("A2) 확인창 표시", await dialog.isVisible());
    ck("A2) 확인 버튼 라벨 '검수 신청 완료'", await dialog.getByRole("button", { name: "검수 신청 완료" }).isVisible());
    await dialog.getByRole("button", { name: "취소" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    ck("A2) 취소 시 API 호출 0", postCount === 0, `count=${postCount}`);
    ck("A2) 취소 시 팝업 유지", await submitReview.isVisible());
    ck("A2) 취소 시 입력값 유지", (await page.getByPlaceholder("변동 액트명").inputValue()) === "ZZ-검증-검수신청");

    // A3) 확인 → API 실패(500) → 팝업 유지 + 에러
    postBehavior = "fail"; postCount = 0;
    await submitReview.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await dialog.getByRole("button", { name: "검수 신청 완료" }).click();
    await page.getByText("강제 실패(검증용)").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ck("A3) 실패 시 API 호출됨", postCount === 1, `count=${postCount}`);
    ck("A3) 실패 시 팝업 유지", await submitReview.isVisible());
    ck("A3) 실패 시 에러 배너 표시", await page.getByText("강제 실패(검증용)").isVisible());

    // A4) 확인 → API 성공 → 팝업 닫힘
    postBehavior = "success"; postCount = 0;
    await submitReview.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await dialog.getByRole("button", { name: "검수 신청 완료" }).click();
    await submitReview.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    ck("A4) 성공 시 API 호출됨", postCount === 1, `count=${postCount}`);
    ck("A4) 성공 시에만 팝업 닫힘", !(await submitReview.isVisible()));

    // ─────────────────────────────────────────────────────────────
    // Scenario B — 저장(라인급 등록)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[B] 저장 (ProcessRegisterManager 라인급 등록)");
    await installPostRoute("**/api/admin/processes/line-groups");
    await page.goto(`${BASE}/admin/processes/register`, { waitUntil: "networkidle" });

    const groupInput = page.getByPlaceholder(/라인급명/);
    await groupInput.waitFor({ state: "visible", timeout: 15000 });
    // 라인급명 입력 옆의 '등록' 버튼(같은 flex 컨테이너).
    const addBtn = groupInput.locator("xpath=following-sibling::button[1]");

    // B1) validation 실패 — 빈 이름 → 확인창 안 뜸·호출 0
    postBehavior = "pass"; postCount = 0;
    await addBtn.click();
    await sleep(400);
    ck("B1) validation 실패 시 확인창 안 뜸", !(await dialog.isVisible()));
    ck("B1) validation 실패 시 API 호출 0", postCount === 0, `count=${postCount}`);
    ck("B1) 에러 배너 표시", await page.getByText("라인급명을 입력해주세요").isVisible());

    const NAME = "ZZ-검증-라인급";
    await groupInput.fill(NAME);

    // B2) 확인창 표시 → 취소 → 호출 0·입력값 유지
    postBehavior = "pass"; postCount = 0;
    await addBtn.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    ck("B2) 확인창 표시", await dialog.isVisible());
    ck("B2) 확인 버튼 라벨 '저장'", await dialog.getByRole("button", { name: "저장" }).isVisible());
    await dialog.getByRole("button", { name: "취소" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    ck("B2) 취소 시 API 호출 0", postCount === 0, `count=${postCount}`);
    ck("B2) 취소 시 입력값 유지", (await groupInput.inputValue()) === NAME);

    // B3) 확인 → 실패(500) → 에러·입력값 유지
    postBehavior = "fail"; postCount = 0;
    await addBtn.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await dialog.getByRole("button", { name: "저장" }).click();
    await page.getByText("강제 실패(검증용)").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    ck("B3) 실패 시 API 호출됨", postCount === 1, `count=${postCount}`);
    ck("B3) 실패 시 에러 배너 표시", await page.getByText("강제 실패(검증용)").isVisible());
    ck("B3) 실패 시 입력값 유지", (await groupInput.inputValue()) === NAME);

    // B4) 확인 → 성공 → 입력값 비워짐
    postBehavior = "success"; postCount = 0;
    await addBtn.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await dialog.getByRole("button", { name: "저장" }).click();
    await sleep(1200);
    ck("B4) 성공 시 API 호출됨", postCount === 1, `count=${postCount}`);
    ck("B4) 성공 시 입력값 비워짐(저장 처리)", (await groupInput.inputValue()) === "", `value="${await groupInput.inputValue()}"`);
  } catch (e) {
    ck("실행 오류", false, String(e?.stack ?? e?.message ?? e));
  } finally {
    await browser.close();
    console.log(`\n  결과: ${pass} pass / ${fail} fail`);
    process.exit(fail ? 1 : 0);
  }
})();
