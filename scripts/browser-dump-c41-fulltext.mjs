// cluster-4-1 진입 화면 전체 텍스트 + weekly-growth 응답 dump (demo)
import { chromium } from "playwright";

const UID = process.argv[2] || "bf3b4305-751a-49e3-88ad-95a20e5c4dad";
const BASE = process.env.FRONT_BASE || "http://localhost:3001";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });
let growthJson = null;
page.on("response", async (r) => {
  if (r.url().includes("/api/cluster4/weekly-growth")) {
    try { growthJson = await r.json(); } catch {}
  }
});
await page.goto(`${BASE}/cluster-4-1?demoUserId=${UID}`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(20000);

const text = await page.evaluate(() => document.body.innerText);
console.log("=== FULL TEXT ===");
console.log(text.slice(0, 7000));

if (growthJson?.data) {
  const d = growthJson.data;
  console.log("\n=== weekly-growth 응답 요약 ===");
  console.log("keys:", Object.keys(d).join(", "));
  if (d.currentWeekInfo) console.log("currentWeekInfo:", JSON.stringify(d.currentWeekInfo));
  if (d.seasonSummary) console.log("seasonSummary:", JSON.stringify(d.seasonSummary));
  if (d.growthSummary) console.log("growthSummary:", JSON.stringify(d.growthSummary));
  if (d.seasonPointSummary) console.log("seasonPointSummary:", JSON.stringify(d.seasonPointSummary));
}
await browser.close();
