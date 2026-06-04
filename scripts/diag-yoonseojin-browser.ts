/** READ-ONLY: T윤서진 고객 허브 카드 목록 실제 렌더 확인 */
import { chromium } from "@playwright/test";
const CUSTOMER = "http://localhost:3001";
const ID = "76a42307-f3b2-4c08-92ab-f339a20b7d38";
const EXTRACT = `(() => {
  const cards = Array.from(document.querySelectorAll('.weekly-card'))
    .filter((c) => c.querySelector('.weekly-card-title'));
  return cards.map((c) => {
    const title = (c.querySelector('.weekly-card-title')?.textContent || '').replace(/\s+/g, ' ').trim();
    const badge = (c.querySelector('.badge-tag')?.textContent || '').trim() || null;
    return { title, badge };
  });
})()`;
async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 2000 } });
  await page.goto(`${CUSTOMER}/cluster-4-ec?demoUserId=${ID}&admin=true`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);
  const cards = await page.evaluate(EXTRACT);
  console.log(JSON.stringify(cards, null, 1));
  await page.screenshot({ path: "claudedocs/diag-yoonseojin-hub.png", fullPage: true });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
