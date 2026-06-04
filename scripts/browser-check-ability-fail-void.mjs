// 역량 실패=보이드 정책 행동 검증:
//  - 역량 성공: 내용 표시 + 클릭 시 모달 오픈
//  - 역량 실패: 내용 "-"(차폐) + 클릭해도 모달 미오픈 (+ 실패 뱃지/오버레이 유지)
//  - 정보/경험 실패: 기존(내용 표시 + 모달 오픈) 유지
//   node scripts/browser-check-ability-fail-void.mjs
import { chromium } from "playwright";

const TESTER = "36138fb1-6fea-4b22-b6d2-9c46cba47314";
const CASES = [
  // [라벨, weekId, userId, actor, abilityExpect("fail"|"success")]
  ["T최수빈 W12 (역량 실패)", "00000000-0000-0000-0000-202605210002", TESTER, TESTER, "fail"],
  ["이유나 W13 (역량 성공)", "a2112b50-64d2-42d6-a243-faf9fcdc6ffc", "247021bc-374b-48f4-8d49-b181d149ee33", TESTER, "success"],
];

const browser = await chromium.launch();
let failures = 0;

for (const [label, weekId, userId, actor, abilityExpect] of CASES) {
  const page = await browser.newPage();
  const url = `http://localhost:3001/cluster-4-card/${weekId}?demoUserId=${actor}&userId=${userId}`;
  try {
    let loaded = false;
    for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      try {
        await page.waitForSelector(".work-ability-section .work-ability-card", { timeout: 20000 });
        loaded = true;
      } catch { await page.waitForTimeout(2000); }
    }
    if (!loaded) throw new Error("로드 실패");
    await page.waitForTimeout(6000);

    const issues = [];
    // ── 역량 카드 내용/뱃지 상태 ──
    const ability = await page.evaluate(() => {
      const c = document.querySelector(".work-ability-section .work-ability-card");
      return {
        codeTag: c?.querySelector(".code-tag")?.textContent?.trim() ?? null,
        infoTag: c?.querySelector(".info-tag")?.textContent?.trim() ?? null,
        mainDesc: c?.querySelector(".main-desc")?.textContent?.trim() ?? null,
        subDesc: c?.querySelector(".sub-desc")?.textContent?.trim() ?? null,
        badge: c?.querySelector(".status-badge img")?.getAttribute("alt") ?? null,
        hasFailedOverlay: !!c?.querySelector(".failed-overlay"),
        cls: c?.className ?? "",
      };
    });
    if (abilityExpect === "fail") {
      if (!(ability.badge === "fail" || ability.badge === "failed")) issues.push(`역량 실패 뱃지 아님(${ability.badge})`);
      const blank = (v) => v === null || v === "-" || v === "";
      if (!blank(ability.codeTag) || !blank(ability.infoTag) || !blank(ability.mainDesc) || !blank(ability.subDesc))
        issues.push(`역량 실패인데 내용 노출: code=${ability.codeTag} name=${ability.infoTag} main=${ability.mainDesc} sub=${ability.subDesc}`);
    } else {
      if (ability.badge !== "success") issues.push(`역량 성공 뱃지 아님(${ability.badge})`);
      if ((ability.codeTag ?? "-") === "-" && (ability.mainDesc ?? "-") === "-") issues.push(`역량 성공인데 내용 비어 있음`);
    }
    // ── 역량 카드 클릭 → 모달 ──
    await page.click(".work-ability-section .work-ability-card");
    await page.waitForTimeout(1200);
    const abilityModalOpen = await page.evaluate(() => !!document.querySelector(".workability-view-modal"));
    if (abilityExpect === "fail" && abilityModalOpen) issues.push("역량 실패인데 모달 오픈");
    if (abilityExpect === "success" && !abilityModalOpen) issues.push("역량 성공인데 모달 미오픈");
    if (abilityModalOpen) { await page.keyboard.press("Escape"); await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector(".work-info-section .work-info-card", { timeout: 30000 }); await page.waitForTimeout(5000); }

    // ── 정보 허브 실패 카드: 내용 표시 + 모달 오픈 유지 ──
    const infoFail = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".work-info-section .work-info-card")];
      const i = cards.findIndex((c) => c.querySelector(".status-badge img")?.getAttribute("alt") === "fail");
      const c = cards[i];
      return i < 0 ? null : { index: i, desc: c.querySelector(".card-desc")?.textContent?.trim() ?? null };
    });
    if (infoFail) {
      if (!infoFail.desc || infoFail.desc === "-") issues.push("정보 실패 카드 내용 미표시(회귀)");
      await page.evaluate((i) => [...document.querySelectorAll(".work-info-section .work-info-card")][i]?.dispatchEvent(new MouseEvent("click", { bubbles: true })), infoFail.index);
      await page.waitForTimeout(1200);
      const infoModal = await page.evaluate(() => !!document.querySelector(".section-modal-overlay"));
      if (!infoModal) issues.push("정보 실패 카드 모달 미오픈(회귀)");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".work-exp-section .work-exp-card", { timeout: 30000 });
      await page.waitForTimeout(5000);
    }

    // ── 경험 허브 실패 카드(내용 보유 슬롯): 모달 오픈 유지 ──
    const expFail = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".work-exp-section .work-exp-card")];
      const i = cards.findIndex((c) => {
        const alt = c.querySelector(".status-badge img")?.getAttribute("alt");
        return (alt === "fail" || alt === "failed") && !c.className.includes("locked");
      });
      return i;
    });
    if (expFail >= 0) {
      await page.evaluate((i) => [...document.querySelectorAll(".work-exp-section .work-exp-card")][i]?.dispatchEvent(new MouseEvent("click", { bubbles: true })), expFail);
      await page.waitForTimeout(1200);
      const expModal = await page.evaluate(() => !!document.querySelector(".section-modal-overlay"));
      if (!expModal) issues.push("경험 실패 카드 모달 미오픈(회귀)");
    }

    if (issues.length) failures++;
    console.log(`${issues.length ? "✗" : "✓"} ${label}${issues.length ? ` ← ${issues.join(" / ")}` : ""}`);
    console.log(`   ability: badge=${ability.badge} code=${ability.codeTag} name=${ability.infoTag} main=${(ability.mainDesc ?? "").slice(0, 20)} overlay=${ability.hasFailedOverlay} modal=${abilityModalOpen}`);
  } catch (e) {
    failures++;
    console.log(`✗ ${label} 실패: ${e.message}`);
  } finally {
    await page.close();
  }
}
await browser.close();
console.log(failures ? `\nFAIL (${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
