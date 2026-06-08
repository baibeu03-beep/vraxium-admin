// 재시드 후 브라우저 검증 (운영 front): 테스터 /cluster-4 카드 목록 정상 표시.
//   node scripts/verify-reseed-37-browser.mjs
//   Playwright 는 ../vraxium(front repo) 의존성 재사용, channel: chromium.
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
  readFileSync(resolve(adminRoot, "claudedocs", "reseed-tester-check-37-20260606.json"), "utf8"),
);
// 재시드 최다 테스터 1명
const counts = new Map();
for (const u of runLog.updated) counts.set(u.userId, (counts.get(u.userId) ?? 0) + 1);
const userId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log(`대상 테스터: ${userId} (재시드 ${counts.get(userId)}행)`);

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
// 카드 목록 로드 대기 (verify-winter-rest-browser 와 동일 신호) 후 스크롤로 카드 lazy 렌더 유도
await page.waitForFunction("document.body.innerText.includes('역대 시즌')", undefined, {
  timeout: 60000,
});
await page.waitForTimeout(2000);
let weekChips = 0;
for (let i = 0; i < 30; i++) {
  await page.evaluate("window.scrollBy(0, 1400)");
  await page.waitForTimeout(400);
  weekChips = await page.evaluate(
    "(document.body.innerText.match(/(봄|여름|가을|겨울) 시즌, \\d+주차/g) ?? []).length",
  );
  if (weekChips >= 5) break;
}
const bodyLen = await page.evaluate(() => document.body.innerText.length);
// 재시드 주차 1건의 카드 상태 라벨 확인 (성장=성공 계열 표시)
const sampleWeeks = runLog.updated
  .filter((u) => u.userId === userId && u.week.startsWith("2026-spring"))
  .map((u) => Number(u.week.split("W")[1]));
const probe = await page.evaluate(`(() => {
  const text = document.body.innerText;
  const out = {};
  for (const n of ${JSON.stringify(sampleWeeks.slice(0, 3))}) {
    const i = text.indexOf('봄 시즌, ' + n + '주차');
    out[n] = i < 0 ? null : text.slice(Math.max(0, i - 50), i + 120).replace(/\\n/g, ' | ');
  }
  return out;
})()`);
console.log("재시드 주차 카드 부근 텍스트:", JSON.stringify(probe, null, 1));
const probedOk = Object.values(probe).filter((v) => v && v.includes("성장")).length;
await page.screenshot({
  path: resolve(adminRoot, "claudedocs", "browser-reseed-37-tester-cards.png"),
  fullPage: false,
});

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
check("weekly-cards API 200", cardsStatus === 200, `status=${cardsStatus}`);
check("주차 카드 렌더 (시즌·주차 라벨 다수)", weekChips >= 5, `count=${weekChips}, bodyLen=${bodyLen}`);
check("재시드 주차 카드 성장(성공) 표시", probedOk >= 1, JSON.stringify(probe));
const relevantErrors = consoleErrors.filter(
  (e) => !/favicon|hydration|third-party|net::ERR_BLOCKED/i.test(e),
);
check("콘솔 에러 0", relevantErrors.length === 0, relevantErrors.slice(0, 3).join(" | "));
console.log("스크린샷: claudedocs/browser-reseed-37-tester-cards.png");

await browser.close();
process.exit(failures > 0 ? 1 : 0);
