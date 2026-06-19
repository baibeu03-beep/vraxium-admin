// 브라우저 검증 — 수동 입력 완료(ProcessIrregularManualGrantDialog) Confirm 게이트.
//   버튼 라벨 "체크 완료" · 확인 라벨 "수동 입력 완료". 대상 크루 명단(1명 이상) 필수.
//   crew 검색(GET)·생성(POST) 모두 인터셉트 → DB 무변경(net-zero).
//   C1 확인창 표시 · C2 취소 → 호출 0·팝업 유지·입력 유지 · C3 성공 → 팝업 닫힘.
//   전제: dev 서버(localhost:3000).
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

  let postBehavior = "pass", postCount = 0;
  // 크루 검색(GET) — 가짜 크루 1명 주입.
  await page.route("**/api/admin/cluster4/cafe-line-crew**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { crews: [{ userId: "11111111-1111-1111-1111-111111111111", crewNo: 99, name: "검증크루", teamName: "검증팀", schoolName: "검증대" }] } }) }),
  );
  // 생성(POST) — 인터셉트(서버 미도달).
  await page.route("**/api/admin/processes/check/irregular", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    postCount++;
    if (postBehavior === "success")
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { created: 1 } }) });
    return route.continue();
  });

  const dialog = page.getByRole("alertdialog");
  try {
    await page.goto(`${BASE}/admin/processes/check/irregular?org=oranke&mode=test`, { waitUntil: "networkidle" });
    const openMg = page.getByRole("button", { name: "수동 입력", exact: true });
    await openMg.waitFor({ state: "visible", timeout: 15000 });
    await page.waitForFunction(
      () => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "수동 입력"); return b && !b.disabled; },
      { timeout: 15000 },
    ).catch(() => {});
    await openMg.click();

    const submitMg = page.getByRole("button", { name: "체크 완료", exact: true });
    await submitMg.waitFor({ state: "visible", timeout: 5000 });
    ck("팝업(수동 입력) 열림", await submitMg.isVisible());

    // 액트명 + 대상 크루(검색→선택→확인) 채우기
    await page.getByPlaceholder("변동 액트명").fill("ZZ-검증-수동부여");
    await page.getByPlaceholder("이름으로 검색").fill("검증");
    await page.getByRole("button", { name: /검증크루/ }).click();
    await page.getByRole("button", { name: "확인", exact: true }).click();
    ck("대상 크루 1명 추가", (await page.getByText("검증크루").count()) > 0);

    // C1) 확인창 표시
    postBehavior = "pass"; postCount = 0;
    await submitMg.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    ck("C1) 확인창 표시", await dialog.isVisible());
    ck("C1) 확인 버튼 라벨 '수동 입력 완료'", await dialog.getByRole("button", { name: "수동 입력 완료" }).isVisible());

    // C2) 취소 → 호출 0·팝업 유지·입력 유지
    await dialog.getByRole("button", { name: "취소" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    ck("C2) 취소 시 API 호출 0", postCount === 0, `count=${postCount}`);
    ck("C2) 취소 시 팝업 유지", await submitMg.isVisible());
    ck("C2) 취소 시 입력값 유지", (await page.getByPlaceholder("변동 액트명").inputValue()) === "ZZ-검증-수동부여");

    // C3) 확인 → 성공 → 팝업 닫힘
    postBehavior = "success"; postCount = 0;
    await submitMg.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await dialog.getByRole("button", { name: "수동 입력 완료" }).click();
    await submitMg.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    ck("C3) 성공 시 API 호출됨", postCount === 1, `count=${postCount}`);
    ck("C3) 성공 시에만 팝업 닫힘", !(await submitMg.isVisible()));
  } catch (e) {
    ck("실행 오류", false, String(e?.stack ?? e?.message ?? e));
  } finally {
    await browser.close();
    console.log(`\n  결과: ${pass} pass / ${fail} fail`);
    process.exit(fail ? 1 : 0);
  }
})();
