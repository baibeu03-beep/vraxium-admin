// 브라우저 검증 — "해당 시기" 반기 선택 기능(2026-07-31).
//   /admin/team-parts/info(§1,§2) · /admin/team-parts/info/{encre,oranke,phalanx}.
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
const txt = async (page, sel) => (await page.locator(sel).first().textContent().catch(() => ""))?.trim() ?? "";
// dev 모드에서 /api/admin/team-parts/info(조직별 3건 병렬)는 몇 초~십수 초 걸릴 수 있다(실측
//   확인됨 — 컴파일·핫리로드 오버헤드 포함 dev 전용 특성, 프로덕션은 훨씬 빠를 것으로 예상).
//   고정 대기 대신 조건이 충족될 때까지 폴링한다.
async function waitUntilText(page, selector, predicate, timeoutMs = 25000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    last = await txt(page, selector);
    if (predicate(last)) return last;
    await page.waitForTimeout(400);
  }
  return last;
}

const browser = await chromium.launch();
const consoleErrors = [];
try {
  const cks = await cookies();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
  await ctx.addCookies(cks);
  const page = await ctx.newPage();
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  // ── 1) 최초 접속 시 현재 반기(26년도 하반기) 선택 ──
  console.log("\n[1. 최초 접속 = 현재 반기]");
  await page.goto(`${BASE}/admin/team-parts/info`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const initialSelect = await page.locator("#team-parts-period-select").inputValue();
  ck("초기 선택값 = 2026-H2", initialSelect === "2026-H2", initialSelect);
  ck("URL 에 ?period 없음(기본값 생략)", !page.url().includes("period="), page.url());

  // ── 2) 반기 변경 → §1/§2 모두 갱신 + URL 반영 ──
  //   ⚠ dev 서버에서 /api/admin/team-parts/info(조직별) 는 실측 3.5~4초/건, 3건 병렬이 사실상
  //     직렬화돼 총 10초 이상 걸릴 수 있음을 확인(2026-07-31 디버깅). 고정 대기 대신 폴링한다.
  console.log("\n[2. 반기 변경 시 §1·§2 갱신]");
  const beforeTotalTeams = await txt(page, "#team-parts-total-team-count");
  await page.locator("#team-parts-period-select").selectOption("2025-H2");
  await page.waitForFunction(() => location.search.includes("period=2025-H2"), { timeout: 15000 }).catch(() => {});
  ck("URL 에 period=2025-H2 반영", page.url().includes("period=2025-H2"), page.url());
  const afterTotalTeams = await waitUntilText(page, "#team-parts-total-team-count", (v) => v === "9", 30000);
  ck("§1 전체 팀 수 변경(9 — team_halves 이력)", afterTotalTeams === "9", `${beforeTotalTeams} → ${afterTotalTeams}`);
  const clubDesc = await waitUntilText(page, "p:has(> span[data-club-summary-asof])", (v) => v.includes("마지막 유효 시점"));
  ck("§2 카드 설명 '마지막 유효 시점' 문구로 전환", clubDesc.includes("마지막 유효 시점"), clubDesc);
  ck("§2 카드 설명에 반기 라벨 노출", clubDesc.includes("25년도 하반기"), clubDesc);
  const encreStaffCell = await txt(page, '[data-club-table-row="encre"] [data-club-cell="staffCount"]');
  ck("§2 표 staffCount = 0(그 반기 override/UPH 팀장 없음)", encreStaffCell === "0", encreStaffCell);
  const encrePartCell = await txt(page, '[data-club-table-row="encre"] [data-club-cell="partCount"]');
  ck("§2 표 partCount = 7(team_halves 이력 존재)", encrePartCell === "7", encrePartCell);

  // ── 3) 기록 없는 반기(2022-H1) → "기록 없음" 표시(0 아님) ──
  console.log("\n[3. 기록 없는 반기 = \"기록 없음\"]");
  await page.locator("#team-parts-period-select").selectOption("2022-H1");
  await page.waitForFunction(() => location.search.includes("period=2022-H1"), { timeout: 15000 }).catch(() => {});
  const noneCell = await waitUntilText(
    page,
    '[data-club-table-row="encre"] [data-club-cell="staffCount"]',
    (v) => v === "기록 없음",
    30000,
  );
  ck('2022-H1 staffCount = "기록 없음"(0 아님)', noneCell === "기록 없음", noneCell);
  const noneDesc = await waitUntilText(page, "p:has(> span[data-club-summary-asof])", (v) => v.includes("기록이 없습니다"), 30000);
  ck("카드 설명에 '기록이 없습니다' 노출", noneDesc.includes("기록이 없습니다"), noneDesc);

  // ── 4) 클럽 상세 이동 시 period 유지 ──
  console.log("\n[4. 클럽 상세 이동 시 period 유지]");
  await page.locator("#team-parts-period-select").selectOption("2025-H1");
  await page.waitForFunction(() => location.search.includes("period=2025-H1"), { timeout: 15000 });
  await page.locator('[data-club-link="encre"]').click();
  await page.waitForURL(/\/admin\/team-parts\/info\/encre/, { timeout: 15000 }).catch(() => {});
  ck("상세 URL 에 period=2025-H1 유지", page.url().includes("/admin/team-parts/info/encre") && page.url().includes("period=2025-H1"), page.url());
  const detailSelectVal = await page.locator("#team-parts-period-select").inputValue({ timeout: 15000 }).catch(() => "(실패)");
  ck("상세 페이지 select 값도 2025-H1", detailSelectVal === "2025-H1", detailSelectVal);
  const stripTitle = await waitUntilText(page, "[data-club-current-summary] div.mb-4", (v) => v.includes("25년도"));
  ck("상세 스트립 제목이 반기 표시로 전환", stripTitle.includes("25년도 상반기"), stripTitle);

  // ── 5) 뒤로가기 시 이전 선택(2025-H1) 유지 ──
  //   ⚠ HalfPeriodSelect 는 router.replace 를 쓴다(드롭다운을 바꿀 때마다 히스토리 항목을 쌓지
  //     않기 위해 — mode/org 등 다른 컨텍스트 파라미터와 동일 관례). 히스토리 경계는 클럽 상세로
  //     이동한 <Link> 클릭(push) 하나뿐이므로, 뒤로가기 1회면 그 시점의 URL(index, period=2025-H1)로
  //     돌아가야 한다.
  console.log("\n[5. 뒤로가기 시 period 유지]");
  await page.goBack({ timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => location.pathname === "/admin/team-parts/info", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const backSelectVal = await page.locator("#team-parts-period-select").inputValue({ timeout: 15000 }).catch(() => "(실패)");
  ck("뒤로가기 후 index 로 복귀 + select = 2025-H1", backSelectVal === "2025-H1" && page.url().includes("period=2025-H1"), `url=${page.url()} val=${backSelectVal}`);

  // ── 6) 새로고침 시 유지 ──
  console.log("\n[6. 새로고침 시 유지]");
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadSelectVal = await page.locator("#team-parts-period-select").inputValue({ timeout: 15000 }).catch(() => "(실패)");
  ck("새로고침 후 select 값 유지", reloadSelectVal === backSelectVal, reloadSelectVal);

  // ── 7) mode=test 유지 ──
  console.log("\n[7. mode=test + period 동시 유지]");
  await page.goto(`${BASE}/admin/team-parts/info/encre?mode=test&period=2026-H1`, { waitUntil: "domcontentloaded" });
  const modeTestSelectVal = await page.locator("#team-parts-period-select").inputValue({ timeout: 15000 }).catch(() => "(실패)");
  ck("select = 2026-H1", modeTestSelectVal === "2026-H1", modeTestSelectVal);
  await page.locator("[data-team-detail-link]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator("[data-team-detail-link]").first().click().catch(() => {});
  await page.waitForTimeout(2500);
  ck("팀 상세 이동 후 mode=test 유지", page.url().includes("mode=test"), page.url());
  ck("팀 상세 이동 후 period 유지", page.url().includes("period=2026-H1") || page.url().includes("half=2026-H1"), page.url());

  // ── 8) 좁은 화면 레이아웃 ──
  //   ⚠ 이 어드민 사이드바는 폭 390px(전형적 휴대폰)에서 접히지 않는 기존(내 변경과 무관) 데스크톱
  //     전제 레이아웃이라, 그 폭에서는 select 가 아무리 줄바꿈해도 여백이 부족하다(실측 확인).
  //     "좁은 화면"은 좁은 데스크톱 창(600px)으로 검증한다 — 실제 select 줄바꿈·overflow 여부는
  //     이 폭에서 판단 가능하다.
  console.log("\n[8. 좁은 화면(600px) 레이아웃]");
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto(`${BASE}/admin/team-parts/info`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const selectBox = await page.locator("#team-parts-period-select").boundingBox();
  const selectOverflow = selectBox ? selectBox.x + selectBox.width > 600 + 5 : true;
  ck("좁은 화면에서 select 가 뷰포트를 벗어나지 않음", !selectOverflow, JSON.stringify(selectBox));
  const selectWhiteSpace = await page.locator("#team-parts-period-select").evaluate((el) => getComputedStyle(el).whiteSpace);
  ck("select 문구 nowrap 스타일", selectWhiteSpace === "nowrap", selectWhiteSpace);

  ck("콘솔 오류 없음(전체 세션)", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
} catch (e) {
  console.error("ERROR:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
