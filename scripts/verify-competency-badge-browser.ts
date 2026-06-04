/**
 * 공표 주차 카드의 역량(competency) 배지 브라우저 확인 — "강화 대기" 0건 / "강화 실패" 전환 검증.
 *   USER_ID=<uuid> ROUTE=/cluster-4 npx tsx --env-file=.env.local scripts/verify-competency-badge-browser.ts
 */
import { chromium } from "@playwright/test";

const EXTRACT = `(() => {
  // 주차 카드 컨테이너 후보: "N주차" 텍스트를 가진 카드 단위로 강화 배지 텍스트 수집
  const all = Array.from(document.querySelectorAll('*'));
  const out = [];
  const seen = new Set();
  for (const el of all) {
    const t = (el.textContent || '');
    const m = t.match(/(\\d+)주차/);
    if (!m) continue;
    // 카드 루트 추정: 자기 자신 텍스트가 너무 길면(페이지 전체) skip — 카드 크기 텍스트만
    if (t.length > 3000 || t.length < 100) continue;
    const waiting = (t.match(/강화 대기/g) || []).length;
    const failed = (t.match(/강화 실패/g) || []).length;
    const key = m[1] + '|' + t.length;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ week: m[1], len: t.length, waiting, failed });
  }
  // 주차별 최소 len(가장 안쪽 카드) 만
  const best = new Map();
  for (const o of out) {
    const cur = best.get(o.week);
    if (!cur || o.len < cur.len) best.set(o.week, o);
  }
  return [...best.values()].sort((a, b) => Number(b.week) - Number(a.week));
})()`;

async function main() {
  const userId = (process.env.USER_ID ?? "").trim();
  const customer = (process.env.CUSTOMER_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const route = process.env.ROUTE ?? "/cluster-4";
  const url = `${customer}${route}?demoUserId=${encodeURIComponent(userId)}&admin=true`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1400 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(12000);
    const res = await page.evaluate(EXTRACT);
    console.log("주차별 카드 내 배지 텍스트 카운트 (waiting=강화 대기 / failed=강화 실패):");
    for (const r of res as any[]) console.log(`  ${r.week}주차: 강화대기=${r.waiting} 강화실패=${r.failed}`);
    await page.screenshot({ path: "claudedocs/competency-badge-verify.png", fullPage: false });
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
