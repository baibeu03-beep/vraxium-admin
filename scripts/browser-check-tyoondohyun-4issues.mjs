// T윤도현 4개 문제 브라우저 실측 (front :3001, demoUserId 테스트 모드)
//   node scripts/browser-check-tyoondohyun-4issues.mjs
import { chromium } from "playwright";

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현
const W14_ID = "286ddd42-aa7c-4df8-bcff-c7c1a9f5425e"; // 2026-spring W14 (2026-06-01)
const BASE = process.env.FRONT_BASE || "http://localhost:3001";

const browser = await chromium.launch();
const ctx = await browser.newContext();

async function visit(path, waitMs, pickRegex, label) {
  const page = await ctx.newPage();
  const apiLog = [];
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/api/")) apiLog.push(`${r.status()} ${u.replace(BASE, "")}`);
  });
  const url = `${BASE}${path}`;
  console.log(`\n========== ${label} ==========`);
  console.log("open:", url);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(waitMs);
  } catch (e) {
    console.log("goto error:", e.message);
  }
  const text = await page.evaluate(() => document.body.innerText);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && pickRegex.test(l) && l.length < 120);
  for (const l of [...new Set(lines)].slice(0, 60)) console.log("  |", l);
  console.log("  -- api calls --");
  for (const a of [...new Set(apiLog)].slice(0, 25)) console.log("   ", a);
  await page.close();
  return text;
}

// 1) 이력서 카드 (career 사이드바): 시즌 활동 목록 + 누적 주차
await visit(
  `/career?demoUserId=${UID}`,
  15000,
  /시즌|주차|주 \/|메달|진행|완료|검수|승인|온보딩|성장/,
  "이력서 카드 (/career)",
);

// 2) 클러스터3: 성장 상태 + 누적(성공) 주차
await visit(
  `/cluster-3?demoUserId=${UID}`,
  15000,
  /성장|온보딩|주차|주$|상태|휴식/,
  "클러스터3 (/cluster-3)",
);

// 3) 클러스터4 카드 목록: W14 카드 상태 + 누적 주차 라벨
const t4 = await visit(
  `/cluster-4?demoUserId=${UID}`,
  18000,
  /14주차|주차|휴식|성장|개설|강화|집계/,
  "클러스터4 카드 목록 (/cluster-4)",
);

// 4) 클러스터4 W14 카드 상세
await visit(
  `/cluster-4-card/${W14_ID}?demoUserId=${UID}`,
  18000,
  /휴식|개설|강화|작성|14주차|주차|성장|미개설|라인/,
  "클러스터4 W14 카드 상세",
);

await browser.close();
console.log("\ndone");
