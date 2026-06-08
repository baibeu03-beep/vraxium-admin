// '역대 시즌' 필터 드롭다운 구조 진단 + 여름 선택 시도 (read-only)
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const requireFront = createRequire(resolve(__dirname, "..", "..", "vraxium", "package.json"));
const { chromium } = requireFront("playwright");

const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 2200 } });
await page.goto("https://vraxium.vercel.app/cluster-4?userId=bf3b4305-751a-49e3-88ad-95a20e5c4dad", {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction("document.body.innerText.includes('전체 주차 수')", undefined, { timeout: 90000 });
await page.waitForTimeout(2500);

// 역대 시즌 드롭다운 열기
const dd = page.locator("text=역대 시즌").first();
await dd.click();
await page.waitForTimeout(800);
const open1 = await page.evaluate("document.body.innerText.split('역대 시즌')[1]?.slice(0, 300).replace(/\\n/g, ' | ')");
console.log("드롭다운 열림 후:", open1);

// '여름' 옵션 클릭 시도
const summerOpt = page.locator("text=/여름/").last();
try {
  await summerOpt.click({ timeout: 5000 });
  await page.waitForTimeout(1500);
} catch (e) {
  console.log("여름 옵션 클릭 실패:", e.message.slice(0, 120));
}
const after = await page.evaluate(`(() => {
  const t = document.body.innerText;
  return {
    search: t.match(/검색 결과[\\s\\S]{0,30}/)?.[0]?.replace(/\\n/g, ' | '),
    titles: [...new Set((t.match(/\\d{4}년,?\\s*(봄|여름|가을|겨울) 시즌,?\\s*\\d+주차/g) ?? []))],
  };
})()`);
console.log("필터 후:", JSON.stringify(after, null, 1));
await page.screenshot({ path: "claudedocs/browser-summer-filter-probe.png" });
await browser.close();
