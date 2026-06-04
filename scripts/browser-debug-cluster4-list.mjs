// /cluster-4 (Cluster41Content 주차 카드 목록) DOM 구조 디버그
import { chromium } from "playwright";
const TESTER = "36138fb1-6fea-4b22-b6d2-9c46cba47314";
const TARGET = "abef6e53-53c5-4277-bb70-e031153e533f";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:3001/cluster-4?demoUserId=${TESTER}&userId=${TARGET}`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(20000);
const info = await page.evaluate(() => ({
  url: location.href,
  metricCount: document.querySelectorAll(".metric").length,
  weekItemish: ["[class*='week']", "[class*='card']", "li", "article"].map((s) => `${s}:${document.querySelectorAll(s).length}`),
  sampleClasses: [...document.querySelectorAll("main div[class], section[class]")].slice(0, 40).map((d) => d.className).filter((c, i, a) => a.indexOf(c) === i).slice(0, 25),
  bodySnippet: document.body.textContent.replace(/\s+/g, " ").slice(0, 600),
}));
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "claudedocs/debug-cluster4-list.png", fullPage: true });
await browser.close();
