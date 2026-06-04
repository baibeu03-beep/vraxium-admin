// 이슈4/5 실측 — W13 카드 상세 (demoUserId 테스트 모드)
//   주차 평판 카드 이미지 src + 연계 동료 카드 필드 추출
//   node scripts/browser-check-w13-rep-colleague.mjs
import { chromium } from "playwright";

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현
const W13_ID = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13
const BASE = process.env.FRONT_BASE || "http://localhost:3001";

const browser = await chromium.launch();
const page = await browser.newPage();
const apiLog = [];
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/")) apiLog.push(`${r.status()} ${u.replace(BASE, "")}`);
});
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("신규 평판/동료") || t.includes("weekly-cards 데이터") || t.includes("fetch 응답")) {
    console.log("[console]", t.slice(0, 400));
  }
});

const url = `${BASE}/cluster-4-card/${W13_ID}?demoUserId=${UID}`;
console.log("open:", url);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(20000);

const result = await page.evaluate(() => {
  const out = { reputations: [], colleagues: [] };
  // 주차 평판 카드
  document.querySelectorAll(".reputation-card").forEach((card) => {
    const img = card.querySelector(".profile-image img");
    const name = card.querySelector(".profile-name")?.innerText?.replace(/\s+/g, " ").trim();
    const details = card.querySelector(".profile-details")?.innerText?.replace(/\s+/g, " ").trim();
    out.reputations.push({ name, imgSrc: img ? img.getAttribute("src") : null, details });
  });
  // 연계 동료 카드 (클래스 추정 — colleague 포함 클래스 전부)
  document.querySelectorAll('[class*="colleague-card"], [class*="colleague"] .card-profile').forEach((card) => {
    const img = card.querySelector("img");
    const text = card.innerText?.replace(/\s+/g, " ").trim().slice(0, 200);
    out.colleagues.push({ text, imgSrc: img ? img.getAttribute("src") : null });
  });
  return out;
});

console.log("\n=== 주차 평판 카드 ===");
for (const r of result.reputations) console.log(JSON.stringify(r));
console.log("\n=== 연계 동료 카드(클래스 추정) ===");
for (const c of result.colleagues.slice(0, 10)) console.log(JSON.stringify(c));

// 전체 텍스트에서 동료 섹션 추출(클래스 추정 실패 대비)
const bodyText = await page.evaluate(() => document.body.innerText);
const idx = bodyText.indexOf("연계 동료");
console.log("\n=== body '연계 동료' 주변 텍스트 ===");
console.log(bodyText.slice(idx, idx + 700));

console.log("\n=== api calls ===");
for (const a of [...new Set(apiLog)]) console.log(" ", a);

await page.screenshot({ path: "w13-detail-demo.png", fullPage: true });
await browser.close();
console.log("done");
