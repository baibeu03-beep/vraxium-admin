// 2026-06-05 정합성 수정 브라우저 검증 (운영 front, demoUserId 읽기 경로)
//   1) /cluster-4-1 (진입): graduated 사용자 성장 뱃지="성장 완료", 시즌 status-badge="시즌 진행 중"
//   2) /cluster-4 (카드목록): "봄 시즌, 24/25주차" 부재, "15/16주차" 존재
// Usage: node scripts/browser-check-status-week-fixes.mjs
import { chromium } from "playwright";

const BASE = process.env.FRONT_BASE || "https://vraxium.vercel.app";
const HONG = "e6574586-6279-41cc-ae36-1c9dc3078bc3"; // T홍지환 graduated
const LIM = "42864260-e4ea-4150-a87f-cff545b02af1"; // T임다인 (24/25주차 오염 케이스)

const browser = await chromium.launch();
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ── 1) 진입 화면 (/cluster-4-1) — T홍지환 ──
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });
  await page.goto(`${BASE}/cluster-4-1?demoUserId=${HONG}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  let badges = [], seasonBadge = "", body = "";
  for (let i = 0; i < 30; i++) {
    badges = await page.evaluate(() => [...document.querySelectorAll(".badge-text")].map((n) => n.textContent?.trim() ?? ""));
    seasonBadge = await page.evaluate(() => document.querySelector(".status-badge")?.textContent?.trim() ?? "");
    if (badges.some((b) => /성장/.test(b)) && seasonBadge) break;
    await page.waitForTimeout(1500);
  }
  body = await page.evaluate(() => document.body.innerText);
  console.log("[1] /cluster-4-1 (진입, T홍지환 graduated)");
  console.log("    (참고) badge-text 전체:", JSON.stringify(badges));
  check("성장 뱃지=성장 완료", badges.includes("성장 완료"), `실제=${JSON.stringify(badges.filter((b) => /성장/.test(b)))}`);
  check("시즌 status-badge=시즌 진행 중", seasonBadge === "시즌 진행 중", `실제="${seasonBadge}"`);
  check("화면에 '시즌 성공' 미노출(진행 중 시즌)", !seasonBadge.includes("시즌 성공"), "");
  const endLine = body.split("\n").find((l) => l.includes("성장 완료") && l.includes("주차")) ?? "";
  console.log(`    (참고) 성장 종료 표기 라인: "${endLine.trim()}"`);
  await page.screenshot({ path: "claudedocs/check-c41-entry-hong.png", fullPage: false });
  await page.close();
}

// ── 2) 카드 목록 (/cluster-4) — T임다인 ──
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 2600 } });
  await page.goto(`${BASE}/cluster-4?demoUserId=${LIM}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  let body = "", titles = [];
  for (let i = 0; i < 40; i++) {
    body = await page.evaluate(() => document.body.innerText);
    titles = body.split("\n").filter((l) => /시즌,\s*\d+주차/.test(l));
    if (titles.length > 2) break;
    await page.waitForTimeout(1500);
  }
  console.log("\n[2] /cluster-4 (카드목록, T임다인)");
  const has24 = /,\s*24주차/.test(body);
  const has25 = /,\s*25주차/.test(body);
  const has15 = /,\s*15주차/.test(body);
  const has16 = /,\s*16주차/.test(body);
  check("'24주차' 미노출", !has24, "");
  check("'25주차' 미노출", !has25, "");
  check("'15주차' 노출", has15, "");
  check("'16주차' 노출", has16, "");
  console.log("    (참고) 카드 제목 전체:", JSON.stringify(titles.slice(0, 20)));
  await page.screenshot({ path: "claudedocs/check-c4-list-lim.png", fullPage: false });
  await page.close();
}

await browser.close();
console.log(`\n결과: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
