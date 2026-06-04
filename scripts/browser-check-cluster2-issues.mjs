// 이슈1(quote-author 이미지) + 이슈2(클럽 리뷰 모달 순서 게이트) 브라우저 실측
//   node scripts/browser-check-cluster2-issues.mjs [base]
import { chromium } from "playwright";

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현
const BASE = process.argv[2] || "http://localhost:3001";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/cluster-2?demoUserId=${UID}`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(15000);

// ── 이슈1: quote-author 이미지 src ──
const quotes = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".quote-card .quote-author").forEach((qa) => {
    const img = qa.querySelector("img");
    out.push({
      name: qa.querySelector(".author-name")?.textContent?.trim(),
      role: qa.querySelector(".author-role")?.textContent?.trim(),
      imgSrc: img ? img.getAttribute("src") : null,
    });
  });
  return out;
});
console.log("=== 이슈1: quote-author ===");
for (const q of quotes) console.log(JSON.stringify(q));

// ── 이슈2: 클럽 리뷰 모달 입력 게이트 ──
// 섹션4(클럽 리뷰) edit-icon 클릭 → 모달의 각 입력 disabled/placeholder 상태 추출
const clicked = await page.evaluate(() => {
  // 클럽 리뷰 섹션의 edit-icon — section4 모달을 여는 아이콘을 찾기 위해
  // 모든 edit-icon 을 순회하며 클릭 후 모달이 열리는지 본다 (link-edit-item 존재 여부).
  const icons = Array.from(document.querySelectorAll(".edit-icon"));
  return icons.length;
});
console.log("\nedit-icon 개수:", clicked);

// 클럽 리뷰 섹션 근처의 edit-icon 클릭 시도: 섹션 텍스트 "Club Review" 또는 메달 그리드 부근
let modalOpened = false;
const icons = await page.locator(".edit-icon").all();
for (let i = 0; i < icons.length && !modalOpened; i++) {
  try {
    await icons[i].click({ timeout: 2000 });
    await page.waitForTimeout(700);
    modalOpened = (await page.locator(".link-edit-item").count()) > 0;
    if (!modalOpened) {
      // 다른 모달이 열렸으면 닫기 (취소 버튼/오버레이 esc)
      await page.keyboard.press("Escape").catch(() => {});
      const cancel = page.locator(".modal-cancel-btn");
      if (await cancel.count()) await cancel.first().click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  } catch { /* next */ }
}
console.log("클럽 리뷰 모달 열림:", modalOpened);
if (modalOpened) {
  const slots = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".link-edit-item").forEach((item) => {
      const input = item.querySelector("input");
      out.push({
        label: item.querySelector(".link-label")?.textContent?.trim(),
        value: input?.value?.slice(0, 30) || "",
        disabled: input?.disabled ?? null,
        placeholder: input?.placeholder?.slice(0, 30) || "",
      });
    });
    return out;
  });
  console.log("=== 이슈2: 모달 슬롯 상태 ===");
  for (const s of slots) console.log(JSON.stringify(s));
}

await page.screenshot({ path: "cluster2-issues-check.png", fullPage: false });
await browser.close();
console.log("done");
