// 브라우저 실측: front 허브(/cluster-4)에 현재 주차/시즌/상태가 실제 반영되는지.
//   node scripts/browser-check-week-transition.mjs <demoUserId>
import { chromium } from "playwright";

const tester = process.argv[2];
if (!tester) {
  console.error("usage: node scripts/browser-check-week-transition.mjs <demoUserId>");
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const url = `http://localhost:3001/cluster-4?demoUserId=${tester}`;
console.log("open:", url);

let growthJson = null;
page.on("response", async (r) => {
  if (r.url().includes("/api/cluster4/weekly-growth")) {
    try {
      growthJson = await r.json();
    } catch {}
  }
});

let loaded = false;
for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(12000); // 데이터 fetch 대기
    loaded = true;
  } catch {
    await page.waitForTimeout(2000);
  }
}

const text = await page.evaluate(() => document.body.innerText);
const lines = text
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /주차|시즌|졸업|성장 완료|성장 진행|진행중|휴식/.test(l) && l.length < 80);

console.log("\n=== 화면 텍스트 중 주차/시즌/상태 관련 라인 ===");
for (const l of [...new Set(lines)].slice(0, 40)) console.log("  |", l);

if (growthJson?.data?.currentWeekInfo) {
  const cw = growthJson.data.currentWeekInfo;
  console.log(
    `\n[브라우저가 받은 weekly-growth] ${cw.year} ${cw.seasonName} ${cw.weekNumber}주차 status=${cw.status}`,
  );
  const g = growthJson.data.growthSummary;
  console.log(
    `  growthSummary: approved=${g?.approvedWeeks} available=${g?.availableWeeks} endStatus=${g?.endStatus}`,
  );
}

await page.screenshot({ path: "claudedocs/week-transition-hub.png", fullPage: false });
console.log("\nscreenshot → claudedocs/week-transition-hub.png");
await browser.close();
