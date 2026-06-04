// W11 페이지 내부에서 front proxy 응답의 competency 라인을 직접 확인.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
const W11 = "67e07106-564e-4dab-b180-8f11c909973a";
const U = "36138fb1-6fea-4b22-b6d2-9c46cba47314";
await page.goto(`http://localhost:3001/cluster-4-card/${W11}?demoUserId=${U}&userId=${U}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".work-exp-section", { timeout: 30000 });
const r = await page.evaluate(async ([weekId, userId]) => {
  const res = await fetch(`/api/cluster4/weekly-cards?userId=${userId}&demoUserId=${userId}`);
  const j = await res.json();
  const card = (j.data ?? []).find((c) => c.weekId === weekId);
  const comp = (card?.lines ?? []).filter((l) => String(l.partType).toLowerCase().includes("comp"));
  return {
    status: res.status,
    cardFound: !!card,
    lineParts: (card?.lines ?? []).map((l) => `${l.partType}:${l.status}/${l.enhancementStatus}`),
    comp: comp.map((l) => ({ status: l.status, enh: l.enhancementStatus, reason: l.enhancementReason, weekId: l.weekId ?? null, num: l.numerator, den: l.denominator })),
  };
}, [W11, U]);
console.log(JSON.stringify(r, null, 1));
await browser.close();
