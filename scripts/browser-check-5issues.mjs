// 5이슈 검증 — demoUserId 테스트 모드 브라우저 실측
//   ① w12 카드 헤더가 휴식(공식)이 아닌지 (stale uws 무시)
//   ② w13 연계 동료 미리보기+모달 필드가 "-" 가 아닌지
//   node scripts/browser-check-5issues.mjs
import { chromium } from "playwright";

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현 (w12 stale official_rest 보유)
const W12_ID = "00000000-0000-0000-0000-202605210002"; // 2026-spring W12 (비휴식 주차)
const W13_ID = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13
const BASE = process.env.FRONT_BASE || "http://localhost:3001";

const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage();
const apiLog = [];
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/") && (r.status() >= 400)) apiLog.push(`${r.status()} ${u.replace(BASE, "")}`);
});

// ── ① w12 휴식 오표시 ──
console.log("=== ① W12 카드 (휴식 오표시 점검) ===");
await page.goto(`${BASE}/cluster-4-card/${W12_ID}?demoUserId=${UID}`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(18000);
const w12 = await page.evaluate(() => {
  const text = document.body.innerText;
  const statusEl = document.querySelector('[class*="section1-header"] [class*="status"], .week-status-badge, [class*="header-status"]');
  return {
    headerStatusEl: statusEl ? statusEl.innerText.replace(/\s+/g, " ").trim() : null,
    hasOfficialRestText: text.includes("휴식(공식)") || text.includes("공식(휴식)"),
    hasFailText: text.includes("성장(실패)"),
    title: (text.match(/\d{4}년, .+? 시즌, .+?주차/) || [null])[0],
  };
});
console.log(JSON.stringify(w12, null, 1));
await page.screenshot({ path: "w12-rest-check.png", fullPage: false });

// ── ② w13 연계 동료 (미리보기 + 모달) ──
console.log("\n=== ② W13 연계 동료 (미리보기) ===");
await page.goto(`${BASE}/cluster-4-card/${W13_ID}?demoUserId=${UID}`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(18000);
const colleagues = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('[class*="colleague"]').forEach((el) => {
    const t = el.innerText?.replace(/\s+/g, " ").trim();
    if (t && t.length > 10 && t.length < 400 && !out.some((o) => o.includes(t) || t.includes(o))) out.push(t);
  });
  return out.slice(0, 6);
});
for (const c of colleagues) console.log(" •", c.slice(0, 220));

// 모달: 첫 동료 카드 클릭
console.log("\n=== ② W13 연계 동료 (모달) ===");
try {
  const clicked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[class*="colleague-card"], [class*="colleague"] [class*="card"]')];
    const real = cards.find((c) => c.innerText && !c.innerText.includes("- -") && c.innerText.trim().length > 20);
    if (real) { real.click(); return real.innerText.slice(0, 80); }
    return null;
  });
  console.log("clicked card:", JSON.stringify(clicked));
  await page.waitForTimeout(2500);
  const modal = await page.evaluate(() => {
    const m = document.querySelector('[class*="modal"][class*="open"], [class*="view-modal"], [class*="modal-content"]');
    return m ? m.innerText.replace(/\s+/g, " ").trim().slice(0, 600) : null;
  });
  console.log("modal text:", JSON.stringify(modal));
  await page.screenshot({ path: "w13-colleague-modal.png", fullPage: false });
} catch (e) {
  console.log("모달 열기 실패:", e.message);
}

console.log("\n=== 4xx/5xx API ===");
for (const a of [...new Set(apiLog)]) console.log(" ", a);
await browser.close();
console.log("done");
