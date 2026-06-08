// SoT 정리(2026-06-05) 브라우저 검증 — 로컬 front(:3001) /cluster-4 진입 화면.
//   1) 시즌 요약(area-1-title)·시즌 포인트(area-4-stats) 정상 렌더 (축소된 weekly-growth DTO)
//   2) 콘솔 에러 수집 — weekly-growth/weekly-cards 관련 신규 에러 없음
//   node scripts/verify-sot-fix-browser.mjs <userId>
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontRoot = resolve(__dirname, "..", "..", "vraxium");
const requireFront = createRequire(resolve(frontRoot, "package.json"));
const { chromium } = requireFront("playwright");

const userId = process.argv[2];
if (!userId) throw new Error("usage: node ... <userId>");
const FRONT = "http://localhost:3001";

const browser = await chromium.launch({ channel: "chromium", headless: true });
let failures = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  const apiResponses = {};
  page.on("response", (res) => {
    const u = res.url();
    if (u.includes("/api/cluster4/weekly-growth")) apiResponses.weeklyGrowth = res.status();
    if (u.includes("/api/cluster4/weekly-cards")) apiResponses.weeklyCards = res.status();
  });

  // 라우트 매핑: /cluster-4-1 → components/cluster-4/Cluster4Content (진입 화면, weekly-growth 소비처)
  await page.goto(`${FRONT}/cluster-4-1?userId=${userId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(12000); // dev 컴파일 + 데이터 로드 대기

  const text = await page.evaluate("document.body.innerText");
  const hasSeasonTitle = /년도\s*.+\s*시즌/.test(text);
  const hasStatusBadge = /(시즌 진행 중|시즌 성공|시즌 중단|시즌 휴식|시즌 중 졸업)/.test(text);
  console.log(`${hasSeasonTitle ? "✅" : "❌"} area-1 시즌 타이틀 렌더`);
  console.log(`${hasStatusBadge ? "✅" : "❌"} 시즌 상태 배지 렌더`);
  if (!hasSeasonTitle) failures++;
  if (!hasStatusBadge) failures++;

  console.log(
    `API: weekly-growth=${apiResponses.weeklyGrowth ?? "(미호출)"} weekly-cards=${apiResponses.weeklyCards ?? "(미호출)"}`,
  );
  if (apiResponses.weeklyGrowth !== 200) {
    console.log("❌ weekly-growth 비정상");
    failures++;
  }
  if (apiResponses.weeklyCards !== 200) {
    console.log("❌ weekly-cards 비정상");
    failures++;
  }

  const relevantErrors = consoleErrors.filter(
    (e) => /weekly-growth|weekly-cards|seasonSummary|cumulative/i.test(e),
  );
  console.log(
    `${relevantErrors.length === 0 ? "✅" : "❌"} 관련 콘솔 에러 0건 (전체 에러 ${consoleErrors.length}건)`,
  );
  if (relevantErrors.length) {
    failures++;
    relevantErrors.slice(0, 5).forEach((e) => console.log("  console.error:", e.slice(0, 200)));
  }

  await page.screenshot({
    path: resolve(__dirname, "..", "claudedocs", "browser-sot-fix-cluster4-entry.png"),
    fullPage: false,
  });
  console.log("screenshot → claudedocs/browser-sot-fix-cluster4-entry.png");
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
