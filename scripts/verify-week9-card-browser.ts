/**
 * 주차 카드(9주차=2026-04-27) 백필 info 라인 브라우저 노출 확인.
 *   USER_ID=<uuid> ROUTE=/cluster-4-ec npx tsx --env-file=.env.local scripts/verify-week9-card-browser.ts
 */
import { chromium } from "@playwright/test";

async function main() {
  const userId = (process.env.USER_ID ?? process.argv[2] ?? "").trim();
  if (!userId) throw new Error("USER_ID 미지정");
  const customer = (process.env.CUSTOMER_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const route = process.env.ROUTE ?? "/cluster-4";
  const url = `${customer}${route}?demoUserId=${encodeURIComponent(userId)}&admin=true`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1400 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(12000);
    // lazy 카드 로드를 위해 점진 스크롤 (window + 내부 스크롤 컨테이너 모두)
    for (let i = 0; i < 14; i++) {
      await page.evaluate(`(() => {
        window.scrollBy(0, 1200);
        for (const el of document.querySelectorAll('*')) {
          if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300) {
            el.scrollTop += 1200;
          }
        }
      })()`);
      await page.waitForTimeout(700);
    }
    // "9주차" 텍스트를 포함한 요소로 스크롤
    const found = await page.evaluate(`(() => {
      const els = Array.from(document.querySelectorAll('*')).filter((e) =>
        e.children.length === 0 && (e.textContent || '').includes('9주차'));
      if (els.length === 0) return false;
      const target = els[els.length - 1]; // 카드 리스트의 9주차(마지막 매치)
      target.scrollIntoView({ block: 'start' });
      return els.map((e) => (e.textContent || '').trim());
    })()`);
    console.log("9주차 요소:", JSON.stringify(found));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "claudedocs/week9-card-backfill-verify.png", fullPage: false });
    console.log("screenshot: claudedocs/week9-card-backfill-verify.png");
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
