// 브라우저 검증 — /admin/team-parts/info 팀 등록 팝업(시안 image (4)).
//   섹션.1 요약 + 섹션.2 "+ 팀 등록" 박스 → 팝업(팀명·개요·크루코드 호출·등록) + 과거 비활성.
//   스크린샷: claudedocs/team-register-popup.png. 전제: dev 서버 + 마이그레이션(register 컬럼) 적용.
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
const sb = createClient(URL, SERVICE);
const TEST_PREFIX = "검증B-";

async function cookies() {
  const browser = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const txt = async (page, sel) => (await page.locator(sel).first().textContent().catch(() => ""))?.trim() ?? "";

async function cleanup() {
  await sb.from("cluster4_team_halves").delete().like("team_name", `${TEST_PREFIX}%`);
}

const browser = await chromium.launch();
try {
  await cleanup();
  // 실제 encre 크루코드 1건.
  const { data: crew } = await sb.from("user_profiles").select("crew_code,display_name").eq("organization_slug", "encre").not("crew_code", "is", null).limit(1).maybeSingle();
  const CODE = crew?.crew_code;
  ck("[전제] encre 크루코드 확보", !!CODE, `${CODE} (${crew?.display_name})`);

  const cks = await cookies();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1100 } });
  await ctx.addCookies(cks);
  const page = await ctx.newPage();

  await page.goto(`${BASE}/admin/team-parts/info`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // ── 섹션.2 등록 박스 ──
  const box = page.locator("#team-parts-register-box");
  ck("'+ 팀 등록' 박스 존재", (await box.count()) > 0);
  ck("현재 반기 박스 활성(클릭 가능)", !(await box.isDisabled()));
  const beforeCount = await txt(page, "#team-parts-active-team-count");

  // ── 팝업 열기 ──
  await box.click();
  await page.waitForTimeout(400);
  ck("팀 등록 팝업 열림", (await page.locator("#team-parts-register-modal").count()) > 0);
  ck("팀 명 maxLength=12", (await page.locator("#team-parts-name-input").getAttribute("maxlength")) === "12");
  ck("팀 개요 maxLength=200", (await page.locator("#team-parts-desc-input").getAttribute("maxlength")) === "200");

  // 입력 + 호출
  const NAME = `${TEST_PREFIX}바나나`;
  await page.locator("#team-parts-name-input").fill(NAME);
  await page.locator("#team-parts-desc-input").fill("브라우저 검증 팀 개요");
  await page.locator("#team-parts-crewcode-input").fill(CODE);
  await page.locator("#team-parts-call-button").click();
  // 크루 조회(getCrewDetailDto)는 무거우므로 등록 버튼 활성화(=leader 로드 완료)까지 대기.
  await page.waitForSelector("#team-parts-register-submit:not([disabled])", { timeout: 20000 });
  const leaderInfo = await txt(page, "#team-parts-leader-info");
  ck("[6] 크루 정보 표시(이름 노출)", leaderInfo.includes(crew.display_name ?? "###"), leaderInfo.replace(/\s+/g, " ").slice(0, 90));
  await page.locator("#team-parts-register-modal").screenshot({ path: resolve(adminRoot, "claudedocs", "team-register-popup.png") }).catch(() => {});

  // 등록
  const regBtn = page.locator("#team-parts-register-submit");
  ck("등록 버튼 활성(유효 입력)", !(await regBtn.isDisabled()));
  await regBtn.click();
  await page.waitForTimeout(1500);
  ck("등록 후 팝업 닫힘", (await page.locator("#team-parts-register-modal").count()) === 0);
  const afterCount = await txt(page, "#team-parts-active-team-count");
  ck("섹션.2 팀 수 +1", Number(afterCount) === Number(beforeCount) + 1, `${beforeCount}→${afterCount}`);
  // 섹션.1 요약에 신규 팀 + 팀장명 반영
  const encreRow = (await page.locator('[data-club-row="encre"]').first().textContent()) ?? "";
  ck("섹션.1 신규 팀 노출", encreRow.includes(NAME), encreRow.replace(/\s+/g, " ").slice(0, 100));
  ck("섹션.1 팀장명 노출", encreRow.includes(crew.display_name ?? "###"));

  // ── 팀 box(시안 [4]) — 등록 박스 위 누적 ──
  const teamBox = page.locator(`[data-team-box="${NAME}"]`);
  ck("팀 box 표시", (await teamBox.count()) > 0);
  // 팀 box 가 '+ 팀 등록' 박스 위에 위치(DOM 순서).
  const boxOrder = await page.evaluate((name) => {
    const tb = document.querySelector(`[data-team-box="${name}"]`);
    const reg = document.querySelector("#team-parts-register-box");
    if (!tb || !reg) return -1;
    return tb.compareDocumentPosition(reg) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : 0;
  }, NAME);
  ck("팀 box가 '+ 팀 등록' 위에 표시", boxOrder === 1);
  const boxText = (await teamBox.textContent()) ?? "";
  ck("팀 box 팀명·개요·팀장 표시", boxText.includes(NAME) && boxText.includes("브라우저 검증 팀 개요") && boxText.includes(crew.display_name ?? "###"), boxText.replace(/\s+/g, " ").slice(0, 120));
  ck("팀 box 파트 수 = 1", (await txt(page, `[data-team-partcount="${NAME}"]`)) === "1", await txt(page, `[data-team-partcount="${NAME}"]`));
  ck("팀 box 파트 목록 = 일반", (await txt(page, `[data-team-parts="${NAME}"]`)).includes("일반"), await txt(page, `[data-team-parts="${NAME}"]`));
  ck("팀 box 수정 버튼", (await teamBox.getByRole("button", { name: "수정" }).count()) > 0);
  ck("팀 box 삭제 버튼", (await teamBox.getByRole("button", { name: "삭제" }).count()) > 0);
  ck("현재 반기 수정 버튼 활성", !(await teamBox.getByRole("button", { name: "수정" }).first().isDisabled()));
  await teamBox.screenshot({ path: resolve(adminRoot, "claudedocs", "team-box.png") }).catch(() => {});

  // ── 다음 반기(2026-H2) → 박스 활성 + 팝업 열림 ──
  await page.locator("#team-parts-half-select").selectOption("2026-H2");
  await page.getByText("다음 반기 · 수정 가능").first().waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(300);
  ck("다음 반기(2026 하반기) 박스 활성", !(await page.locator("#team-parts-register-box").isDisabled()));
  await page.locator("#team-parts-register-box").click();
  await page.waitForTimeout(400);
  ck("다음 반기 팀 등록 팝업 열림", (await page.locator("#team-parts-register-modal").count()) > 0);
  await page.getByRole("button", { name: "닫기" }).click();
  await page.waitForTimeout(400);
  ck("다음 반기 팝업 닫힘", (await page.locator("#team-parts-register-modal").count()) === 0);

  // ── 과거 반기 → 박스 비활성 ──
  await page.locator("#team-parts-half-select").selectOption("2024-H1");
  await page.getByText("과거 반기 · 조회 전용").first().waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(300);
  ck("과거 반기 박스 비활성", await page.locator("#team-parts-register-box").isDisabled());
  await page.locator("#team-parts-register-box").click({ force: true }).catch(() => {});
  await page.waitForTimeout(300);
  ck("과거 반기 클릭해도 팝업 미열림", (await page.locator("#team-parts-register-modal").count()) === 0);
  // 과거 반기 팀 box 의 수정/삭제 비활성(시드 팀 box 존재).
  const pastBox = page.locator("[data-team-box]").first();
  if ((await pastBox.count()) > 0) {
    ck("과거 반기 팀 box 수정 버튼 비활성", await pastBox.getByRole("button", { name: "수정" }).first().isDisabled());
    ck("과거 반기 팀 box 삭제 버튼 비활성", await pastBox.getByRole("button", { name: "삭제" }).first().isDisabled());
  }
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); await browser.close(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
