// 브라우저 렌더링 검증 — 성장 중단 사용자의 이력서 메달 배지 + 허브 성장 배지 실측.
//   node scripts/verify-growth-stop-browser.mjs
// 전제: front dev :3001, admin dev :3000 가 떠 있어야 함.
import { chromium } from "playwright-core";

const PAUSED = "37b7ddce-6146-4941-8c5f-c1dfa4e09f7e"; // T안준혁 (encre, growth_status=paused)
const BASE = "http://localhost:3001";

async function launch() {
  for (const channel of ["chrome", "msedge", "chromium"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try next */
    }
  }
  return await chromium.launch({ headless: true });
}

async function readBadges(page, label) {
  // 메달(이력서 카드 배지) — .medal-text-inner. 허브 성장 배지 — .badge-text.
  const medal = await page
    .locator(".medal-text-inner")
    .first()
    .textContent()
    .catch(() => null);
  const hubBadge = await page
    .locator(".badge-text")
    .first()
    .textContent()
    .catch(() => null);
  console.log(`[${label}] medal=${JSON.stringify(medal?.trim())} hubBadge=${JSON.stringify(hubBadge?.trim())}`);
  return { medal: medal?.trim() ?? null, hubBadge: hubBadge?.trim() ?? null };
}

async function main() {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  const url = `${BASE}/cluster-4/?demoUserId=${PAUSED}&mode=test`;
  console.log("navigate:", url);
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => {
    console.log("goto warn:", e.message);
  });
  // 메달/배지 렌더 대기 (프로필 fetch → setCrewStatus).
  await page.waitForSelector(".medal-text-inner", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const res = await readBadges(page, "paused/mode=test");
  await page.screenshot({ path: "claudedocs/growth-stop-paused.png", fullPage: false });
  console.log("screenshot → claudedocs/growth-stop-paused.png");

  const medalOk = res.medal === "Next Challenge";
  const hubOk = res.hubBadge === "성장 중단";
  console.log(`ASSERT medal==='Next Challenge': ${medalOk ? "PASS" : "FAIL (" + res.medal + ")"}`);
  console.log(`ASSERT hubBadge==='성장 중단': ${hubOk ? "PASS" : "FAIL (" + res.hubBadge + ")"}`);

  await browser.close();
  process.exit(medalOk && hubOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
