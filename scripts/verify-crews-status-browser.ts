/**
 * 고객앱 /crews displayGrowthStatus 통일 — 브라우저 실측 (read-only).
 *   1) 기본 필터(활동 중): T윤도현 미노출 (display=graduated)
 *   2) 필터=활동 졸업: T윤도현 노출 + 카드 배지 "활동 졸업" (통일 후 기대값)
 *   3) 기본 필터 내 paused 멤버 카드 배지 "활동 유보" 표시 확인
 * 사전조건: front dev :3001.
 * Usage: npx tsx --env-file=.env.local scripts/verify-crews-status-browser.ts
 */
import { chromium } from "playwright-core";

const frontBase = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const TARGET = "T윤도현";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function cardBadgeFor(page: import("playwright-core").Page, name: string) {
  return page.evaluate((target) => {
    const cards = Array.from(document.querySelectorAll(".trending__single"));
    for (const card of cards) {
      const nameEl = card.querySelector(".author-meta .text-sm.fw-6");
      if (nameEl?.textContent?.trim() === target) {
        return (
          card.querySelector(".author-title p")?.textContent?.trim() ?? "(배지 없음)"
        );
      }
    }
    return null; // 카드 미노출
  }, name);
}

async function waitForCards(page: import("playwright-core").Page) {
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(
      () => document.querySelectorAll(".trending__single").length,
    );
    const empty = await page.evaluate(() =>
      document.body.innerText.includes("조건에 맞는 크루가 없습니다"),
    );
    if (n > 0 || empty) return n;
    await page.waitForTimeout(1000);
  }
  return 0;
}

async function main() {
  // paused 표본 1명을 API 에서 동적으로 선정 (활동 중 그룹에 포함되므로 기본 필터에서 검사).
  const apiJson = (await (
    await fetch(`${frontBase}/api/crews/?org=encre`, { cache: "no-store" })
  ).json()) as { data: Array<{ name: string; displayGrowthStatus: string }> };
  const pausedName =
    apiJson.data.find((r) => r.displayGrowthStatus === "paused")?.name ?? null;
  console.log(`paused 표본: ${pausedName ?? "(없음 — 검사 생략)"}`);

  const browser = await chromium.launch({ channel: "chromium" });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
  const page = await ctx.newPage();

  await page.goto(`${frontBase}/crews/?org=encre`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  // ── 1) 기본 필터(활동 중) ──
  const initialCount = await waitForCards(page);
  console.log(`[기본 필터=활동 중] 카드 ${initialCount}장`);
  const badgeInActive = await cardBadgeFor(page, TARGET);
  check(
    `기본(활동 중) 필터에서 ${TARGET} 미노출`,
    badgeInActive === null,
    badgeInActive === null ? "" : `노출됨, 배지=${badgeInActive}`,
  );

  // ── 3) paused 멤버 배지 = 활동 유보 (활동 중 그룹 내 구분 표시) ──
  if (pausedName) {
    const pausedBadge = await cardBadgeFor(page, pausedName);
    check(
      `paused(${pausedName}) 카드 배지="활동 유보"`,
      pausedBadge === "활동 유보",
      `실제=${pausedBadge}`,
    );
  }
  await page.screenshot({
    path: "claudedocs/browser-crews-unified-active.png",
    fullPage: false,
  });

  // ── 2) 필터=활동 졸업 ──
  await page
    .locator('.filter-dropdown:has(img[alt="status"])')
    .click({ timeout: 15000 });
  await page
    .locator(".dropdown-item", { hasText: "활동 졸업" })
    .click({ timeout: 15000 });
  await page.locator(".filter-card", { hasText: "조회" }).last().click();
  await page.waitForTimeout(1500);
  const gradCount = await waitForCards(page);
  console.log(`[필터=활동 졸업] 카드 ${gradCount}장`);

  const badgeInGraduated = await cardBadgeFor(page, TARGET);
  check(
    `활동 졸업 필터에서 ${TARGET} 노출`,
    badgeInGraduated !== null,
    `배지=${badgeInGraduated}`,
  );
  check(
    `${TARGET} 카드 배지="활동 졸업" (필터그룹과 일치)`,
    badgeInGraduated === "활동 졸업",
    `실제=${badgeInGraduated}`,
  );
  await page.screenshot({
    path: "claudedocs/browser-crews-unified-graduated.png",
    fullPage: false,
  });

  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}
void main();
