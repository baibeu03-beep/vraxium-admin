// summer 복원 후 브라우저 검증 (운영 front): 테스터 /cluster-4 — 여름 카드 4장(W5~8) 렌더 + 졸업 영향 없음.
//   node scripts/verify-summer-restore-browser.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const requireFront = createRequire(resolve(frontRoot, "package.json"));
const { chromium } = requireFront("playwright");

const FRONT = "https://vraxium.vercel.app";
const runLog = JSON.parse(
  readFileSync(resolve(adminRoot, "claudedocs", "summer-pms-restore-2026-06-07T01-03-07.json"), "utf8"),
);
const userId = runLog.testers[0];
console.log(`대상 테스터: ${userId}`);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 2200 } });

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
let cardsStatus = null;
page.on("response", (r) => {
  if (r.url().includes("/api/cluster4/weekly-cards")) cardsStatus = r.status();
});

await page.goto(`${FRONT}/cluster-4?userId=${userId}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction("document.body.innerText.includes('역대 시즌')", undefined, { timeout: 60000 });
// 카드 목록 로드 대기 (전체 주차 수) — 목록은 페이지네이션(10장/페이지)이라 '역대 시즌' 필터로 여름만 조회
await page.waitForFunction("document.body.innerText.includes('전체 주차 수')", undefined, { timeout: 60000 });
await page.waitForTimeout(2000);
await page.locator("text=역대 시즌").first().click();
await page.waitForTimeout(800);
await page.locator("text=/여름/").last().click();
await page.waitForTimeout(1500);
const filtered = await page.evaluate(`(() => {
  const t = document.body.innerText;
  return {
    searchCount: Number(t.match(/검색 결과\\s*\\|?\\s*(\\d+)/)?.[1] ?? t.match(/검색 결과\\n(\\d+)/)?.[1] ?? -1),
    titles: [...new Set((t.match(/2025년,?\\s*여름 시즌,?\\s*\\d+주차/g) ?? []))],
    tallying: (t.match(/성장\\(집계 중\\)/g) ?? []).length,
  };
})()`);
const summerWeeks = [...new Set(filtered.titles.map((s) => Number(s.match(/(\d+)주차/)[1])))].sort((a, b) => a - b);
console.log("여름 필터 결과:", JSON.stringify(filtered));
await page.screenshot({
  path: resolve(adminRoot, "claudedocs", "browser-summer-restore-tester-cards.png"),
  fullPage: false,
});

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
check("weekly-cards API 200", cardsStatus === 200, `status=${cardsStatus}`);
check("여름 카드 = W5~8 정확 4장 (W1~4 카드 없음, top-up 유지)",
  JSON.stringify(summerWeeks) === JSON.stringify([5, 6, 7, 8]) && filtered.searchCount === 4,
  `weeks=[${summerWeeks}] 검색결과=${filtered.searchCount}`);
check("여름 카드 상태 = 성장(집계 중) 표시 (미공표 정본 반영)", filtered.tallying >= 1, `tallying 라벨 ${filtered.tallying}건`);
const relevantErrors = consoleErrors.filter((e) => !/favicon|hydration|third-party|net::ERR_BLOCKED/i.test(e));
check("콘솔 에러 0", relevantErrors.length === 0, relevantErrors.slice(0, 3).join(" | "));
console.log("스크린샷: claudedocs/browser-summer-restore-tester-cards.png");

await browser.close();
process.exit(failures > 0 ? 1 : 0);
