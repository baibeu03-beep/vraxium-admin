// 레거시 통합 — 목록/성장상태 화면 검증
import { chromium } from "playwright-core";

const BASE = "http://localhost:3001";
const GRAD = "4a81b6d1-e488-4f14-8530-0cad60fe4f0d"; // T장유준 (graduate, 26 success)
const LOW = "36138fb1-6fea-4b22-b6d2-9c46cba47314"; // T최수빈 (low)

const browser = await chromium.launch({ channel: "chromium" });

// 1) /cluster-4 카드 목록 (demo) — 성장 성공 주차 수
for (const [label, uid] of [["GRAD", GRAD], ["LOW", LOW]]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 2400 } });
  await page.goto(`${BASE}/cluster-4?demoUserId=${uid}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(15000);
  const text = await page.evaluate(() => document.body.innerText);
  const succ = text.match(/성장 성공 주차\n(\d+) 개 주차/);
  const statuses = [...text.matchAll(/성장 (성공|실패)\b/g)].length;
  console.log(`[${label}] /cluster-4 성장 성공 주차: ${succ?.[1] ?? "(미발견)"} | 성공/실패 배지 수: ${statuses}`);
  console.log(`  스냅샷 일부: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  await page.screenshot({ path: `claudedocs/legacy-unified-list-${label}.png`, fullPage: false });
  await page.close();
}

// 2) /cluster-3 성장 상태 (일반 모드 경로) — 졸업 표시
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/cluster-3?userId=${GRAD}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(12000);
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(/성장 상태\n([^\n]+)/);
  console.log(`[GRAD] /cluster-3 성장 상태: ${m?.[1] ?? "(미발견)"}`);
  const weeks = text.match(/성장\(성공\) 주차[^\d]*(\d+)/);
  console.log(`[GRAD] 성장(성공) 주차: ${weeks?.[1] ?? "(미발견)"}`);
  await page.close();
}

await browser.close();
