// cluster-4-1 진입 화면 데모 모드 확인 (14주차 휴식 — 라인 개설 노출 여부)
import { chromium } from "playwright";

const UID = process.argv[2] || "bf3b4305-751a-49e3-88ad-95a20e5c4dad";
const BASE = process.env.FRONT_BASE || "http://localhost:3001";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });
const apiLog = [];
const lineJson = {};
page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("/api/")) apiLog.push(`${r.status()} ${u.replace(BASE, "").slice(0, 140)}`);
  if (u.includes("lines/detail")) {
    try {
      const j = await r.json();
      const key = u.match(/partType=(\w+)/)?.[1] ?? u;
      lineJson[key] = j;
    } catch {}
  }
});
const url = `${BASE}/cluster-4-1?demoUserId=${UID}`;
console.log("open:", url);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(20000);

const text = await page.evaluate(() => document.body.innerText);
console.log("=== 본문 텍스트 (주차/라인/휴식 관련) ===");
const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
for (const l of lines) {
  if (/주차|라인|휴식|개설|작성|캘린더|위클리|성장|시즌/.test(l) && l.length < 110) console.log("  |", l);
}
console.log("\n-- api calls --");
for (const a of [...new Set(apiLog)].slice(0, 40)) console.log("  ", a);
console.log("\n-- lines/detail json keys --");
for (const [k, v] of Object.entries(lineJson)) {
  const d = v?.data;
  console.log(`  partType=${k}: success=${v?.success} lines=${Array.isArray(d?.lines) ? d.lines.length : JSON.stringify(d)?.slice(0, 200)}`);
}
await page.screenshot({ path: "c41-entry-demo.png", fullPage: true });
console.log("screenshot: c41-entry-demo.png");
await browser.close();
