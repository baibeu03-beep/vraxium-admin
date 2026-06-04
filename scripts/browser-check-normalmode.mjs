// 일반 모드 렌더 경로(?userId=, demoUserId 없음) 회귀 확인 — T윤도현 + 일반 유저
import { chromium } from "playwright";

const BASE = process.env.FRONT_BASE || "http://localhost:3001";
const TARGETS = [
  ["T윤도현(일반 모드 경로)", "bf3b4305-751a-49e3-88ad-95a20e5c4dad"],
  ["일반 유저(김시원)", "566900f7-f4b2-4a95-bf11-d3dc4346453a"], // prefix → 아래에서 보정 불가하므로 full id 필요시 교체
];

const browser = await chromium.launch();
const ctx = await browser.newContext();
for (const [label, uid] of TARGETS) {
  if (uid.length < 36) { console.log(`\n=== ${label}: full uuid 필요 — 스킵`); continue; }
  const page = await ctx.newPage();
  const url = `${BASE}/cluster-3?userId=${uid}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(12000);
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(/성장 상태\n([^\n]+)/);
  console.log(`\n=== ${label} /cluster-3?userId= ===`);
  console.log("성장 상태:", m?.[1] ?? "(미발견)");
  await page.close();

  const page2 = await ctx.newPage();
  await page2.goto(`${BASE}/cluster-4?userId=${uid}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page2.waitForTimeout(15000);
  const t2 = await page2.evaluate(() => document.body.innerText);
  const rest = t2.includes("14주차를 휴식 (공식) 중");
  console.log("/cluster-4 W14 휴식 표기:", rest ? "휴식(공식) ✅" : "(확인 불가/다름)");
  const succ = t2.match(/성장 성공 주차\n(\d+) 개 주차/);
  console.log("성장 성공 주차:", succ?.[1] ?? "(미발견)");
  await page2.close();
}
await browser.close();
