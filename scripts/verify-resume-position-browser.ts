/**
 * 브라우저 DOM 검증: resume-activities 시즌별 포지션(.activity-role) 실제 표시.
 *   USER_ID=<uuid> ROUTE=/cluster-4 CUSTOMER_URL=http://localhost:3001 \
 *     npx tsx --env-file=.env.local scripts/verify-resume-position-browser.ts
 * READ-ONLY.
 */
import { chromium } from "@playwright/test";

const EXTRACT = `(() => {
  const rows = Array.from(document.querySelectorAll('.resume-activities .activity-row, .activity-row')).map((r) => ({
    season: (r.querySelector('.activity-season')||{}).textContent?.trim() || '',
    period: (r.querySelector('.activity-period')||{}).textContent?.trim() || '',
    role:   (r.querySelector('.activity-role')||{}).textContent?.trim() || '',
    badge:  (r.querySelector('.activity-badge')||{}).textContent?.trim() || '',
    check:  (r.querySelector('.activity-check')||{}).textContent?.trim() || '',
  }));
  return rows;
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
    await page.waitForTimeout(12000);
    const rows = await page.evaluate(EXTRACT);
    console.log("URL:", url);
    console.log("resume-activities rows:");
    for (const r of rows as any[]) console.log(`  ${r.season} | ${r.role} | ${r.period} | ${r.badge} | ${r.check}`);
    await page.screenshot({ path: `claudedocs/resume-position-${userId.slice(0,8)}.png`, fullPage: false });
    console.log(`screenshot: claudedocs/resume-position-${userId.slice(0,8)}.png`);
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
