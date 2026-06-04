// 이력서 카드(sidebar .resume-badges) 포인트 표시 정책 브라우저 확인 — 기대 8 / 1 / -2 (옥지윤)
import { chromium } from "playwright";
const TESTER = "36138fb1-6fea-4b22-b6d2-9c46cba47314";
const TARGET = "abef6e53-53c5-4277-bb70-e031153e533f";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:3001/cluster-4?demoUserId=${TESTER}&userId=${TARGET}`, { waitUntil: "domcontentloaded", timeout: 90000 });
// 숫자 카운트업 애니메이션 종료까지 대기 — 두 번 연속 동일 샘플일 때 확정.
let vals = null;
let prev = "";
for (let i = 0; i < 60; i++) {
  vals = await page.evaluate(() =>
    [...document.querySelectorAll(".resume-badges .badge-num")].map((n) => n.textContent.trim()),
  );
  const cur = JSON.stringify(vals);
  if (vals.length >= 3 && vals.some((v) => /[1-9]/.test(v)) && cur === prev) break;
  prev = cur;
  await page.waitForTimeout(1500);
}
console.log("resume-badges (sidebar = 페이지 주인 옥지윤 카드):", JSON.stringify(vals));
// demo foreign-viewer 모드에서 sidebar 는 페이지 주인(userId=옥지윤) 기준 — 기대 8 / 1(net) / -2(−pen)
const ok = vals?.[0] === "8" && vals?.[1] === "1" && vals?.[2] === "-2";
console.log(ok ? "✓ 이력서 카드 8 / 1 / -2 (별/방패net/번개−n)" : "✗ 기대 8 / 1 / -2 불일치");
const card = await page.locator(".resume-card").first();
await card.screenshot({ path: "claudedocs/point-policy-resume-card.png" }).catch(async () => {
  await page.screenshot({ path: "claudedocs/point-policy-resume-card.png" });
});
await browser.close();
process.exit(ok ? 0 : 1);
