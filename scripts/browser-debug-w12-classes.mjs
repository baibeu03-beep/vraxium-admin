import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("현재 주차 라인 적재") || t.includes("exp-linename-diag") || t.includes("weekly-cards")) logs.push(t.slice(0, 600));
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
const url = "http://localhost:3001/cluster-4-card/67e07106-564e-4dab-b180-8f11c909973a?demoUserId=36138fb1-6fea-4b22-b6d2-9c46cba47314&userId=36138fb1-6fea-4b22-b6d2-9c46cba47314";
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector(".work-exp-section", { timeout: 30000 });
await page.waitForTimeout(6000);
const r = await page.evaluate(() => ({
  infoCards: [...document.querySelectorAll(".work-info-section .work-info-card")].map((c) => ({
    cls: c.className,
    badge: c.querySelector(".status-badge img")?.getAttribute("alt") ?? null,
    desc: c.querySelector(".card-desc")?.textContent?.trim().slice(0, 20) ?? null,
  })),
  abilityCards: [...document.querySelectorAll(".work-ability-section .work-ability-card")].map((c) => ({
    cls: c.className,
    badge: c.querySelector(".status-badge img")?.getAttribute("alt") ?? null,
  })),
  expCards: [...document.querySelectorAll(".work-exp-section .work-exp-card")].map((c) => ({
    cls: c.className,
    badge: c.querySelector(".status-badge img")?.getAttribute("alt") ?? null,
  })),
  careerCards: [...document.querySelectorAll(".work-career-section .work-career-card")].map((c) => ({
    cls: c.className.slice(0, 60),
    badge: c.querySelector(".status-badge img")?.getAttribute("alt") ?? null,
  })),
}));
console.log(JSON.stringify(r, null, 1));
console.log("--- console logs ---");
for (const l of logs.slice(0, 8)) console.log(l);
await browser.close();
