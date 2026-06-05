/**
 * 주차 인정 check 기준 — 브라우저 검증 (Playwright).
 *   1) admin(3000) /admin/week-recognitions: "주차 인정 check 기준 관리" 섹션 렌더,
 *      기준값 수정(25) 저장 → 반영 확인 → 기본값 복원.
 *   2) front(3001) 주차 카드: 케이스 B(강화 성공/주차 실패) · 케이스 A(주차 성공) 표시 분리.
 *
 *   사전조건: admin dev(3000) + front dev(3001).
 *   npx tsx --env-file=.env.local scripts/verify-week-check-browser.mts
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const requireFromFront = createRequire(
  new URL("../../vraxium/package.json", import.meta.url),
);
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const adminBase = "http://localhost:3000";
const frontBase = "http://localhost:3001";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

// UI 저장 테스트 대상 주차 — 참여자(uws 9명)가 가장 적어 snapshot 재계산이 빠르다.
const UI_WEEK_START = "2025-09-01";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeAdminCookies() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
  }));
}

async function main() {
  const sb = createClient(
    ensureEnv("NEXT_PUBLIC_SUPABASE_URL"),
    ensureEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
  const seedLog = JSON.parse(
    readFileSync("claudedocs/legacy-check-case-seed-20260605.json", "utf-8"),
  );
  const { data: pubWeeks } = await sb
    .from("weeks")
    .select("id,start_date,result_published_at")
    .not("result_published_at", "is", null);
  const weekIdByStart = new Map(
    ((pubWeeks ?? []) as any[]).map((w) => [w.start_date, w.id]),
  );
  const sampleB = seedLog.plans.find(
    (p: any) => p.case === "B" && weekIdByStart.has(p.weekStart),
  );
  const sampleA = seedLog.plans.find(
    (p: any) => p.case === "A" && weekIdByStart.has(p.weekStart),
  );

  const browser = await chromium.launch({ channel: "chromium" });
  const FRONT_ONLY = process.argv.includes("--front-only");
  const ADMIN_ONLY = process.argv.includes("--admin-only");

  // ── 1) admin UI: check 기준 관리 ─────────────────────────────────────
  if (!FRONT_ONLY) {
  console.log("\n===== admin /admin/week-recognitions — check 기준 관리 =====");
  {
    const context = await browser.newContext({ baseURL: adminBase });
    await context.addCookies(await makeAdminCookies());
    const page = await context.newPage();
    await page.goto("/admin/week-recognitions", { waitUntil: "networkidle" });

    // 탭: 기본 = "주차 인정 결과" (인정 결과 목록 노출, check 기준 카드 숨김).
    const listTitle = page.locator("text=인정 결과 목록").first();
    const checkCard = page.locator("#check-threshold");
    check("기본 탭: 인정 결과 목록 노출", await listTitle.isVisible());
    check("기본 탭: check 기준 카드 숨김", !(await checkCard.isVisible()));

    // 탭 전환 → check 기준 관리 (두 영역 동시 노출 금지).
    await page.locator("[role='tab']:has-text('check 기준 관리')").click();
    await checkCard.waitFor({ state: "visible", timeout: 10_000 });
    check("탭 전환: check 기준 카드 노출", await checkCard.isVisible());
    check("탭 전환: 인정 결과 목록 숨김", !(await listTitle.isVisible()));

    const row = page.locator(`tr:has-text("${UI_WEEK_START}")`).last();
    await row.scrollIntoViewIfNeeded();
    const rowText0 = (await row.innerText()).replace(/\s+/g, " ");
    check(
      `대상 주차(${UI_WEEK_START}) 초기 표시: 30개 + 기본값`,
      rowText0.includes("30개") && rowText0.includes("기본값"),
      rowText0,
    );

    // 수정: 25 저장
    const input = row.locator("input");
    await input.fill("25");
    const saveBtn = row.locator("button:has-text('저장')");
    await saveBtn.click();
    await page.waitForSelector("text=check 인정 기준을 25개로 저장했습니다", {
      timeout: 240_000,
    });
    check("저장 배너: 25개 저장", true);
    // refreshTick 재조회 후 행 표시 갱신
    await page.waitForTimeout(3_000);
    const rowText1 = (
      await page.locator(`tr:has-text("${UI_WEEK_START}")`).last().innerText()
    ).replace(/\s+/g, " ");
    check(
      "수정 후 표시: 25개 (기본값 배지 없음)",
      rowText1.includes("25개") && !rowText1.includes("기본값"),
      rowText1,
    );

    // API 기준 반영 확인
    const { data: wk } = await sb
      .from("weeks")
      .select("check_threshold")
      .eq("start_date", UI_WEEK_START)
      .maybeSingle();
    check("DB 반영: check_threshold=25", (wk as any)?.check_threshold === 25);

    // 복원: 빈값 → 기본값
    const row2 = page.locator(`tr:has-text("${UI_WEEK_START}")`).last();
    await row2.locator("input").fill("");
    await row2.locator("button:has-text('저장')").click();
    await page.waitForSelector("text=기본값(30개)로 저장했습니다", {
      timeout: 240_000,
    });
    await page.waitForTimeout(3_000);
    const rowText2 = (
      await page.locator(`tr:has-text("${UI_WEEK_START}")`).last().innerText()
    ).replace(/\s+/g, " ");
    check(
      "복원 후 표시: 30개 + 기본값",
      rowText2.includes("30개") && rowText2.includes("기본값"),
      rowText2,
    );
    const { data: wk2 } = await sb
      .from("weeks")
      .select("check_threshold")
      .eq("start_date", UI_WEEK_START)
      .maybeSingle();
    check("DB 복원: check_threshold=null", (wk2 as any)?.check_threshold === null);

    // 탭 복귀 → 주차 인정 결과: 목록 기존 동작(행 렌더) 유지.
    await page.locator("[role='tab']:has-text('주차 인정 결과')").click();
    await listTitle.waitFor({ state: "visible", timeout: 10_000 });
    check("탭 복귀: 인정 결과 목록 노출", await listTitle.isVisible());
    check("탭 복귀: check 기준 카드 숨김", !(await checkCard.isVisible()));
    const listRowCount = await page
      .locator("table")
      .first()
      .locator("tbody tr")
      .count();
    check("인정 결과 목록 행 렌더", listRowCount > 0, `rows=${listRowCount}`);

    await page.screenshot({
      path: "claudedocs/check-threshold-admin-ui.png",
      fullPage: true,
    });
    console.log("screenshot: claudedocs/check-threshold-admin-ui.png");
    await context.close();
  }
  }

  // ── 2) front 카드: 강화/주차 분리 표시 ───────────────────────────────
  if (!ADMIN_ONLY) {
  console.log("\n===== front 주차 카드 — 케이스 A/B =====");
  for (const [label, p, expectStatus] of [
    ["case-A", sampleA, "성공"],
    ["case-B", sampleB, "실패"],
  ] as const) {
    if (!p) {
      check(`${label} 샘플 존재`, false);
      continue;
    }
    const weekId = weekIdByStart.get(p.weekStart);
    const url = `${frontBase}/cluster-4-card/${weekId}?demoUserId=${p.userId}`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 2600 } });
    console.log(`\n--- ${label}: ${p.userId.slice(0, 8)} ${p.weekStart} ---\n${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(15_000);
    const text = await page.evaluate(() => document.body.innerText);
    check(`${label} 통합 라인명 노출`, text.includes("[통합] 주차 활동 내역"));
    check(
      `${label} 주차 상태(${expectStatus}) 표기`,
      text.includes(expectStatus),
      text.slice(0, 200).replace(/\n/g, " "),
    );
    const idx = text.indexOf("라인별 강화 결과");
    if (idx >= 0) {
      console.log("--- 라인별 강화 결과 섹션 ---");
      console.log(text.slice(idx, idx + 700));
    }
    await page.screenshot({
      path: `claudedocs/check-policy-${label}.png`,
      fullPage: true,
    });
    console.log(`screenshot: claudedocs/check-policy-${label}.png`);
    await page.close();
  }
  }

  await browser.close();
  console.log(`\n결과: 실패 ${failures}건`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
