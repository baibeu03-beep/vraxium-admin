// W14 카드 상세 라인 영역 정밀 캡처 (demo 모드)
import { chromium } from "playwright";

const UID = process.argv[2] || "bf3b4305-751a-49e3-88ad-95a20e5c4dad";
const WEEK = process.argv[3] || "286ddd42-aa7c-4df8-bcff-c7c1a9f5425e";
const BASE = "http://localhost:3001";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 2400 } });
const url = `${BASE}/cluster-4-card/${WEEK}?demoUserId=${UID}`;
console.log("open:", url);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(18000);

// 전체 텍스트 (라인 카드 섹션 중심)
const text = await page.evaluate(() => document.body.innerText);
const idx = text.indexOf("라인별 강화 결과");
console.log("=== '라인별 강화 결과' 이후 텍스트 ===");
console.log(text.slice(Math.max(0, idx), idx + 2500));

await page.screenshot({ path: "w14-detail-demo.png", fullPage: true });
console.log("screenshot: w14-detail-demo.png");
await browser.close();
