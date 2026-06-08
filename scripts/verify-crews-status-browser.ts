/**
 * 고객앱 /crews 2분류(Cluving / Elite) 정책 — 브라우저 실측 (read-only).
 *   2026-06-08 개편: /crews 는 graduated(활동 졸업) / 그 외 전부(활동 중) 2분류만 노출.
 *   suspended(활동 중단)는 목록에서 완전 제외되고, "활동 중단" 라벨/옵션은 어디에도 없다.
 *
 *   1) 상태 드롭다운에 "활동 중단" 없음 (옵션 = 상태 전체 / 활동 중 / 활동 졸업)
 *   2) 화면 어디에도 "활동 중단" 문구 없음 (배지 0건 + body 텍스트 미포함)
 *   3) suspended 멤버는 목록 미노출
 *   4) graduated 멤버 → 배지 "활동 졸업"
 *   5) 그 외(paused/active/onboarding/휴식 등) → 전부 배지 "활동 중"
 *
 * 사전조건: front dev :3001. (oranke 조직이 suspended/graduated/paused/onboarding 표본 보유)
 * Usage: npx tsx --env-file=.env.local scripts/verify-crews-status-browser.ts
 */
import { chromium, type Page } from "playwright-core";

const frontBase = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const ORG = process.env.CREWS_ORG ?? "oranke";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function cardBadgeFor(page: Page, name: string) {
  return page.evaluate((target) => {
    const cards = Array.from(document.querySelectorAll(".trending__single"));
    for (const card of cards) {
      const nameEl = card.querySelector(".author-meta .text-sm.fw-6");
      if (nameEl?.textContent?.trim() === target) {
        return card.querySelector(".author-title p")?.textContent?.trim() ?? "(배지 없음)";
      }
    }
    return null; // 카드 미노출
  }, name);
}

async function allBadges(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".trending__single .author-title p")).map(
      (el) => el.textContent?.trim() ?? "",
    ),
  );
}

async function waitForCards(page: Page) {
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

type FrontCrew = { name: string; displayGrowthStatus: string };

async function main() {
  // 표본을 API 에서 동적으로 선정 (raw display_name 기준 — 마스킹 전 이름).
  const apiJson = (await (
    await fetch(`${frontBase}/api/crews/?org=${ORG}`, { cache: "no-store" })
  ).json()) as { data: FrontCrew[] };
  const rows = apiJson.data;
  const suspendedName = rows.find((r) => r.displayGrowthStatus === "suspended")?.name ?? null;
  const pausedName = rows.find((r) => r.displayGrowthStatus === "paused")?.name ?? null;
  const graduatedName = rows.find((r) => r.displayGrowthStatus === "graduated")?.name ?? null;
  console.log(
    `표본(${ORG}) — suspended: ${suspendedName} / paused: ${pausedName} / graduated: ${graduatedName}`,
  );

  const browser = await chromium.launch({ channel: "chromium" });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
  const page = await ctx.newPage();

  await page.goto(`${frontBase}/crews/?org=${ORG}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  // ── 기본 필터(활동 중) 카드 로드 ──
  const initialCount = await waitForCards(page);
  console.log(`[기본 필터=활동 중] 카드 ${initialCount}장`);

  // ── 1) 드롭다운 옵션 검사 ──
  await page.locator('.filter-dropdown:has(img[alt="status"])').click({ timeout: 15000 });
  await page.waitForTimeout(400);
  const options = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('.filter-dropdown:has(img[alt="status"]) .dropdown-item'),
    ).map((el) => el.textContent?.trim() ?? ""),
  );
  console.log(`드롭다운 옵션: ${JSON.stringify(options)}`);
  check("1) 드롭다운에 '활동 중단' 없음", !options.includes("활동 중단"));
  check(
    "1) 드롭다운 옵션 = [상태 전체, 활동 중, 활동 졸업]",
    JSON.stringify(options) === JSON.stringify(["상태 전체", "활동 중", "활동 졸업"]),
    JSON.stringify(options),
  );
  // 드롭다운 닫기(트리거 재클릭 토글)
  await page.locator('.filter-dropdown:has(img[alt="status"])').click({ timeout: 15000 });
  await page.waitForTimeout(400);

  // ── 2) 화면 어디에도 "활동 중단" 문구 없음 ──
  const badges = await allBadges(page);
  check(
    "2) 화면 내 '활동 중단' 배지 0건",
    !badges.includes("활동 중단"),
    `badges=${JSON.stringify([...new Set(badges)])}`,
  );
  const bodyHasSuspendedLabel = await page.evaluate(() =>
    document.body.innerText.includes("활동 중단"),
  );
  check("2) body 텍스트에 '활동 중단' 미포함", !bodyHasSuspendedLabel);

  // ── 3) suspended 멤버 미노출 ──
  if (suspendedName) {
    const badge = await cardBadgeFor(page, suspendedName);
    check(
      `3) suspended(${suspendedName}) 카드 미노출`,
      badge === null,
      badge === null ? "" : `노출됨, 배지=${badge}`,
    );
  } else {
    console.log("  · suspended 표본 없음 — 3) 생략");
  }

  // ── 5) graduated 외 전부 → 배지 "활동 중" ──
  if (pausedName) {
    const badge = await cardBadgeFor(page, pausedName);
    check(`5) paused(${pausedName}) 배지="활동 중"(Cluving)`, badge === "활동 중", `실제=${badge}`);
  }
  check(
    "5) 기본 뷰 모든 배지 = '활동 중' (졸업 제외 단일화)",
    badges.length > 0 && badges.every((b) => b === "활동 중"),
    `unique=${JSON.stringify([...new Set(badges)])}`,
  );

  await page.screenshot({ path: "claudedocs/browser-crews-2cat-active.png", fullPage: false });

  // ── 4) 활동 졸업 필터 → graduated 배지 "활동 졸업" ──
  await page.locator('.filter-dropdown:has(img[alt="status"])').click({ timeout: 15000 });
  await page
    .locator('.filter-dropdown:has(img[alt="status"]) .dropdown-menu')
    .waitFor({ state: "visible", timeout: 10000 });
  await page
    .locator('.filter-dropdown:has(img[alt="status"]) .dropdown-item', { hasText: "활동 졸업" })
    .click({ timeout: 15000 });
  await page.locator(".filter-card", { hasText: "조회" }).last().click();
  await page.waitForTimeout(1500);
  await waitForCards(page);
  if (graduatedName) {
    const badge = await cardBadgeFor(page, graduatedName);
    check(
      `4) graduated(${graduatedName}) 노출 + 배지="활동 졸업"(Elite)`,
      badge === "활동 졸업",
      `실제=${badge}`,
    );
  }
  const gradBadges = await allBadges(page);
  check(
    "4) 활동 졸업 필터 — 모든 배지 = '활동 졸업'",
    gradBadges.length > 0 && gradBadges.every((b) => b === "활동 졸업"),
    `unique=${JSON.stringify([...new Set(gradBadges)])}`,
  );
  await page.screenshot({ path: "claudedocs/browser-crews-2cat-graduated.png", fullPage: false });

  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}
void main();
