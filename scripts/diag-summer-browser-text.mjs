// 카드 목록 구조/스크롤 컨테이너 진단 (read-only)
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
await page.waitForTimeout(3000);

// 1) 스크롤 가능한 컨테이너 후보
const containers = await page.evaluate(`(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight > el.clientHeight + 300 && el.clientHeight > 200) {
      out.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), sh: el.scrollHeight, ch: el.clientHeight });
    }
  }
  return out.slice(0, 10);
})()`);
console.log("스크롤 컨테이너 후보:", JSON.stringify(containers, null, 1));

// 2) 가장 큰 컨테이너를 끝까지 스크롤하며 카드 제목 수집
const titles = await page.evaluate(`(async () => {
  const els = [...document.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 300 && el.clientHeight > 200);
  els.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  const target = els[0] ?? document.scrollingElement;
  const seen = new Set();
  for (let i = 0; i < 80; i++) {
    target.scrollTop = target.scrollTop + 1500;
    window.scrollBy(0, 1500);
    await new Promise(r => setTimeout(r, 300));
    for (const m of document.body.innerText.matchAll(/\\d{4}년,?\\s*(봄|여름|가을|겨울) 시즌,?\\s*\\d+주차/g)) seen.add(m[0]);
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 10 && i > 10) break;
  }
  return [...seen];
})()`);
console.log(`수집된 카드 제목 ${titles.length}건:`);
for (const t of titles) console.log("  " + t);
const summer = titles.filter((t) => t.includes("여름"));
console.log("여름 카드:", JSON.stringify(summer));
await browser.close();
