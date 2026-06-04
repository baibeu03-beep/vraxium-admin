// 브라우저 실측: T최수빈 봄 W12 cluster-4-card 실무 경험 "총 N개" vs 표시 카드 수.
//   node scripts/browser-check-subin-exp-count.mjs
import { chromium } from "playwright";

const WEEK_ID = "00000000-0000-0000-0000-202605210002"; // 2026-spring W12
const USER_ID = "36138fb1-6fea-4b22-b6d2-9c46cba47314"; // T최수빈
const URL = `http://localhost:3001/cluster-4-card/${WEEK_ID}?demoUserId=${USER_ID}&userId=${USER_ID}`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[cluster4-exp-linename-diag]") || t.includes("현재 주차 라인 적재")) {
    console.log("(console)", t.slice(0, 300));
  }
});
await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector(".work-exp-section", { timeout: 30000 });
// weekly-cards fetch 반영 대기 (section-count 가 비-0/하이픈으로 안정될 때까지 잠깐 더)
await page.waitForTimeout(3000);

const result = await page.evaluate(() => {
  const section = document.querySelector(".work-exp-section");
  if (!section) return { error: "work-exp-section 없음" };
  const countText = section.querySelector(".section-count")?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  const rate = section.querySelector(".rate-value")?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  const cards = [...section.querySelectorAll(".work-exp-card")].map((c) => ({
    cls: c.className,
    badgeAlt: c.querySelector(".status-badge img")?.getAttribute("alt") ?? null,
  }));
  const visibleCounted = cards.filter(
    (c) => !c.cls.includes("locked") && !c.cls.includes("not-applicable"),
  ).length;
  return { countText, rate, cards, visibleCounted };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
