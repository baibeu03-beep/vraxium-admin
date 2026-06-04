// 일반(비데모) 경로 확인 — userId 조회 모드(세션 없음)에서 같은 DTO/렌더가 쓰이는지
//   node scripts/browser-check-normal-mode.mjs [base]
import { chromium } from "playwright";

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad";
const W13 = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
const BASE = process.argv[2] || "http://localhost:3001";

const browser = await chromium.launch();
const page = await browser.newPage();

// 1) cluster-2 (userId 조회 — demoUserId 없음)
await page.goto(`${BASE}/cluster-2?userId=${UID}`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(12000);
const quotes = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".quote-card .quote-author").forEach((qa) => {
    out.push({
      name: qa.querySelector(".author-name")?.textContent?.trim(),
      imgSrc: qa.querySelector("img")?.getAttribute("src")?.slice(-40) ?? null,
    });
  });
  return out;
});
console.log("=== 일반(userId) cluster-2 quote-author ===");
for (const q of quotes) console.log(JSON.stringify(q));

// 2) cluster-4-card W13 (userId 조회 — demoUserId 없음)
await page.goto(`${BASE}/cluster-4-card/${W13}?userId=${UID}`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(15000);
const result = await page.evaluate(() => {
  const reps = [];
  document.querySelectorAll(".reputation-card").forEach((card) => {
    const img = card.querySelector(".profile-image img");
    reps.push({
      name: card.querySelector(".profile-name")?.innerText?.replace(/\s+/g, " ").trim(),
      imgSrc: img ? img.getAttribute("src")?.slice(-40) : null,
    });
  });
  const body = document.body.innerText;
  const i = body.indexOf("연계 동료");
  return { reps, colleagueText: body.slice(i, i + 260).replace(/\n+/g, " | ") };
});
console.log("\n=== 일반(userId) W13 평판 카드 ===");
for (const r of result.reps) console.log(JSON.stringify(r));
console.log("\n=== 일반(userId) W13 연계 동료 ===");
console.log(result.colleagueText);

await browser.close();
console.log("done");
