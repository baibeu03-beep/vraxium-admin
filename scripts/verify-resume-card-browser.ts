/**
 * 이력서 카드(resume-card) 브라우저 DOM 검증 — demoUserId 테스트 모드.
 *   medal-week-num(누적 주차), resume-activities 행("N주 / M주"), 주차 카드 info 라인 노출 확인.
 *
 *   USER_ID=<uuid> ROUTE=/cluster-4-ec CUSTOMER_URL=http://localhost:3001 \
 *     npx tsx --env-file=.env.local scripts/verify-resume-card-browser.ts
 *
 * READ-ONLY. 스크린샷은 claudedocs/.
 */
import { chromium } from "@playwright/test";

const EXTRACT = `(() => {
  const medal = document.querySelector('.medal-week-num');
  const rows = Array.from(document.querySelectorAll('.resume-activities .activity-row')).map((r) => {
    const season = (r.querySelector('.activity-season') || {}).textContent || '';
    const period = (r.querySelector('.activity-period') || {}).textContent || '';
    const badge = (r.querySelector('.activity-badge') || {}).textContent || '';
    const check = (r.querySelector('.activity-check') || {}).textContent || '';
    return { season: season.trim(), period: period.trim(), badge: badge.trim(), check: check.trim() };
  });
  return { medal: medal ? medal.textContent : null, rows };
})()`;

async function main() {
  const userId = (process.env.USER_ID ?? process.argv[2] ?? "").trim();
  if (!userId) throw new Error("USER_ID 미지정");
  const customer = (process.env.CUSTOMER_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const route = process.env.ROUTE ?? "/cluster-4";
  const url = `${customer}${route}?demoUserId=${encodeURIComponent(userId)}&admin=true`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1200 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(12000); // 데이터 fetch 대기
    const result = await page.evaluate(EXTRACT);
    console.log("URL:", url);
    console.log("medal-week-num:", JSON.stringify((result as any).medal));
    console.log("resume-activities rows:");
    for (const r of (result as any).rows) console.log(" ", JSON.stringify(r));
    await page.screenshot({ path: "claudedocs/resume-card-backfill-verify.png", fullPage: false });
    console.log("screenshot: claudedocs/resume-card-backfill-verify.png");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
