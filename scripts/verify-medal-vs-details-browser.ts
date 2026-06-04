/**
 * 브라우저 검증: 이력서 카드 medal-week-num == Details 카드 "성장 성공 주차".
 *   /cluster-4?demoUserId=… 한 페이지에서 두 값을 동시에 추출해 비교한다.
 *
 *   USER_ID=<uuid> CUSTOMER_URL=http://localhost:3001 \
 *     npx tsx --env-file=.env.local scripts/verify-medal-vs-details-browser.ts
 *
 * READ-ONLY. 스크린샷은 claudedocs/.
 */
import { chromium } from "@playwright/test";

const EXTRACT = `(() => {
  const medal = document.querySelector('.medal-week-num');
  let detailsApproved = null;
  for (const row of document.querySelectorAll('.detail-row')) {
    const label = row.querySelector('.detail-label');
    if (label && label.textContent.trim() === '성장 성공 주차') {
      const num = row.querySelector('.detail-value .number');
      detailsApproved = num ? num.textContent.trim() : null;
      break;
    }
  }
  return { medal: medal ? medal.textContent.trim() : null, detailsApproved };
})()`;

async function main() {
  const userId = (process.env.USER_ID ?? process.argv[2] ?? "").trim();
  if (!userId) throw new Error("USER_ID 미지정");
  const customer = (process.env.CUSTOMER_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const url = `${customer}/cluster-4?demoUserId=${encodeURIComponent(userId)}&admin=true`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1200 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(15000); // 데이터 fetch 대기 (statsCards 프록시 포함)
    const result = (await page.evaluate(EXTRACT)) as {
      medal: string | null;
      detailsApproved: string | null;
    };
    console.log("URL:", url);
    console.log("medal-week-num        :", JSON.stringify(result.medal));
    console.log("Details 성장 성공 주차:", JSON.stringify(result.detailsApproved));
    const match =
      result.medal !== null &&
      result.detailsApproved !== null &&
      result.medal === result.detailsApproved;
    console.log(match ? "✅ MATCH" : "❌ MISMATCH");
    await page.screenshot({ path: `claudedocs/medal-vs-details-${userId.slice(0, 8)}.png`, fullPage: false });
    console.log(`screenshot: claudedocs/medal-vs-details-${userId.slice(0, 8)}.png`);
    if (!match) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
