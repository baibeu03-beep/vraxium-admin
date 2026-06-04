// /cluster-4 진입 화면 셀렉터/상태 디버그
import { chromium } from "playwright";
const TESTER = "36138fb1-6fea-4b22-b6d2-9c46cba47314";
const TARGET = "abef6e53-53c5-4277-bb70-e031153e533f";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)); });
const resp = await page.goto(`http://localhost:3001/cluster-4?demoUserId=${TESTER}&userId=${TARGET}`, { waitUntil: "domcontentloaded", timeout: 90000 });
console.log("status:", resp?.status());
await page.waitForTimeout(15000);
const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  hasArea4: !!document.querySelector(".area-4-stats"),
  bodyClasses: document.body.className,
  firstClasses: [...document.querySelectorAll("div[class]")].slice(0, 15).map((d) => d.className.split(" ")[0]),
  bodyText: document.body.textContent.replace(/\s+/g, " ").slice(0, 300),
}));
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "claudedocs/debug-cluster4-entry.png" });
await browser.close();
