// 브라우저 검증 — /admin/weekly-card-finalization (로컬 :3000, 어드민 세션 쿠키 주입).
//   preview 플로우만 실제 클릭으로 구동하고, 확정 모달은 열어서 확인 후 "취소"(공표 안 함).
//   prod SoT 변경 없음. page.evaluate 는 문자열형(SYS_NO_PATHCONV 회피).
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
// org/주차/기대값 파라미터(기본 Oranke W13 = 82/66/9/7).
const ORG_LABEL = process.env.ORG_LABEL ?? "Oranke";
const EXP = {
  total: process.env.EXP_TOTAL ?? "82",
  success: process.env.EXP_SUCCESS ?? "66",
  fail: process.env.EXP_FAIL ?? "9",
  rest: process.env.EXP_REST ?? "7",
};

async function makeAdminCookies() {
  const supabaseUrl = get("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, get("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost",
    path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1700 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

try {
  await page.goto(`${BASE}/admin/weekly-card-finalization`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('주차 카드 집계 확정')", undefined, { timeout: 60000 });
  check("어드민 페이지 렌더(주차 카드 집계 확정)", true);

  // 시즌 선택.
  await page.locator('[data-slot="select-trigger"]').nth(0).click();
  await page.waitForTimeout(400);
  await page.locator('[data-slot="select-item"]', { hasText: "2026-spring" }).first().click();
  await page.waitForTimeout(300);

  // 주차 선택(13주차).
  await page.locator('[data-slot="select-trigger"]').nth(1).click();
  await page.waitForTimeout(400);
  await page.locator('[data-slot="select-item"]', { hasText: "13주차" }).first().click();
  await page.waitForTimeout(300);

  // 조직 선택.
  await page.locator('[data-slot="select-trigger"]').nth(2).click();
  await page.waitForTimeout(400);
  await page.locator('[data-slot="select-item"]', { hasText: ORG_LABEL }).first().click();
  await page.waitForTimeout(300);

  // 집계 미리보기.
  await page.getByRole("button", { name: "집계 미리보기" }).click();
  await page.waitForFunction("document.body.innerText.includes('전체 크루')", undefined, { timeout: 30000 });
  await page.waitForTimeout(800);

  // 표 행에서 라벨→숫자를 정확히 추출(부분일치로 인한 오탐 방지).
  const cellByLabel = await page.evaluate(`(() => {
    const out = {};
    for (const tr of document.querySelectorAll('tr')) {
      const tds = tr.querySelectorAll('td');
      if (tds.length === 2) out[tds[0].innerText.trim()] = tds[1].innerText.trim();
    }
    return out;
  })()`);
  const bodyText = await page.evaluate("document.body.innerText");
  check("집계 표 '전체 크루' 노출", bodyText.includes("전체 크루"));
  check("집계 표 행 라벨(성장 도전/성공/실패/개인 휴식/공식 휴식/미확정)",
    ["성장 도전", "성장 성공", "성장 실패", "개인 휴식", "공식 휴식", "미확정"].every((s) => bodyText.includes(s)));
  check(`전체 크루 = ${EXP.total} (${ORG_LABEL}, 테스트 제외)`, cellByLabel["전체 크루"] === EXP.total, `표값=${cellByLabel["전체 크루"]}`);
  check(`성장 성공 = ${EXP.success}`, cellByLabel["성장 성공"] === EXP.success, `표값=${cellByLabel["성장 성공"]}`);
  check(`성장 실패 = ${EXP.fail}`, cellByLabel["성장 실패"] === EXP.fail, `표값=${cellByLabel["성장 실패"]}`);
  check(`개인 휴식 = ${EXP.rest}`, cellByLabel["개인 휴식"] === EXP.rest, `표값=${cellByLabel["개인 휴식"]}`);
  check("상태 배지 '집계 중'(미공표)", bodyText.includes("집계 중"));
  check("snapshot stale/신선 배지 노출", /snapshot (stale|신선)/.test(bodyText));

  await page.screenshot({ path: resolve(adminRoot, `claudedocs/browser-weekly-card-finalization-preview-${ORG_LABEL}.png`), fullPage: true });

  // 확정 모달 열기(취소 — 공표 안 함).
  await page.getByRole("button", { name: "집계 확정" }).first().click();
  await page.waitForFunction("document.body.innerText.includes('이 주차를 확정하면')", undefined, { timeout: 10000 });
  check("확정 확인 모달 노출", true);
  await page.screenshot({ path: resolve(adminRoot, `claudedocs/browser-weekly-card-finalization-modal-${ORG_LABEL}.png`) });

  await page.getByRole("button", { name: "취소" }).click();
  await page.waitForTimeout(500);
  const afterCancel = await page.evaluate("document.body.innerText");
  check("취소 후 공표 안 함(모달 닫힘, 여전히 집계 중)",
    !afterCancel.includes("이 주차를 확정하면") && afterCancel.includes("집계 중"));

  console.log(`\n브라우저 검증 스크린샷: claudedocs/browser-weekly-card-finalization-{preview,modal}.png`);
} catch (e) {
  console.error("BROWSER FATAL", e?.message ?? e);
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs/browser-weekly-card-finalization-error.png"), fullPage: true }); } catch {}
  fail++;
} finally {
  await browser.close();
}

console.log(`\n=== 브라우저 결과: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
