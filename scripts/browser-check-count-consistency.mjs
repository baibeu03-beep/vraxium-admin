// 브라우저 실측: 여러 유저/주차에서 4허브 section-count == 표시 카드 수 == 주차 성장률 분모 합산.
//   node scripts/browser-check-count-consistency.mjs
import { chromium } from "playwright";

const TESTER = "36138fb1-6fea-4b22-b6d2-9c46cba47314"; // T최수빈 (demo 인증 actor)
const CASES = [
  // [라벨, weekId, 대상 userId, demo actor] — 비테스트 유저는 foreign-viewer 모드(demo actor=테스터)
  ["T최수빈 W11", "67e07106-564e-4dab-b180-8f11c909973a", TESTER, TESTER],
  ["T최수빈 W12", "00000000-0000-0000-0000-202605210002", TESTER, TESTER],
  ["T최수빈 W13", "a2112b50-64d2-42d6-a243-faf9fcdc6ffc", TESTER, TESTER],
  ["T박하린 W4", "5eca4fe4-77ff-46bc-9e53-8772a078b651", "0a113e53-b678-40d1-b51c-1278e1c3f0fa", "0a113e53-b678-40d1-b51c-1278e1c3f0fa"],
  ["성채윤(viewer:테스터) W10", "6cc59d70-3aa6-4823-8854-5b82691d1a84", "19cb4129-ba73-4685-9912-7d9d4ed3768b", TESTER],
  ["이유나(viewer:테스터) W13", "a2112b50-64d2-42d6-a243-faf9fcdc6ffc", "247021bc-374b-48f4-8d49-b181d149ee33", TESTER],
];

// "총 3 개 중 0 개" → { total: 3, success: 0 } ("-" → null)
const parseCount = (txt) => {
  const m = (txt ?? "").replace(/\s+/g, " ").match(/총\s*(-|\d+)\s*개 중\s*(-|\d+)\s*개?/);
  if (!m) return { total: null, success: null, raw: txt };
  return { total: m[1] === "-" ? null : Number(m[1]), success: m[2] === "-" ? null : Number(m[2]) };
};

// 해당없음/보이드/잠금 = 표시 카운트 제외 클래스 (faded-card = na fade 신규 클래스명)
const EXCL_INFO = ["empty", "is-empty-card", "not-applicable", "faded-card"];
const EXCL_ABILITY = ["empty", "not-applicable", "faded-card"];
const EXCL_EXP = ["empty", "locked", "not-applicable", "faded-card"];
const EXCL_CAREER = ["empty", "not-applicable", "faded-card"];

const browser = await chromium.launch();
let failures = 0;
for (const [label, weekId, userId, actor] of CASES) {
  const page = await browser.newPage();
  const url = `http://localhost:3001/cluster-4-card/${weekId}?demoUserId=${actor}&userId=${userId}`;
  try {
    // dev 서버 cold-compile 404/지연 대비: 최대 3회 재시도 + weekly-cards 응답 수신 대기.
    let loaded = false;
    for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
      const respWait = page
        .waitForResponse((r) => r.url().includes("/api/cluster4/weekly-cards"), { timeout: 45000 })
        .catch(() => null);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      try {
        await page.waitForSelector(".work-exp-section", { timeout: 20000 });
        await respWait;
        loaded = true;
      } catch {
        await page.waitForTimeout(2000); // 404/컴파일 중 → 재시도
      }
    }
    if (!loaded) throw new Error("페이지 로드 실패(3회 재시도)");
    // DOM 안정화 폴링: 뱃지/fade 클래스는 DTO + legacy 데이터가 모두 도착해야 최종 상태.
    const snapshotOnce = () =>
      page.evaluate(
        ([exclInfo, exclAbility, exclExp, exclCareer]) => {
          const text = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
          const cards = (sel, excl) =>
            [...document.querySelectorAll(sel)].filter((c) => !excl.some((k) => c.className.includes(k))).length;
          return {
            growth: text(".growth-rate-header .growth-count"),
            info: text(".work-info-section .section-count"),
            infoCards: cards(".work-info-section .work-info-card", exclInfo),
            ability: text(".work-ability-section .section-count"),
            abilityCards: cards(".work-ability-section .work-ability-card", exclAbility),
            abilityCardCountAll: document.querySelectorAll(".work-ability-section .work-ability-card").length,
            abilityBadges: [...document.querySelectorAll(".work-ability-section .work-ability-card .status-badge img")].map((i) =>
              i.getAttribute("alt"),
            ),
            exp: text(".work-exp-section .section-count"),
            expCards: cards(".work-exp-section .work-exp-card", exclExp),
            career: text(".work-career-section .section-count"),
            careerCards: cards(".work-career-section .work-career-card", exclCareer),
          };
        },
        [EXCL_INFO, EXCL_ABILITY, EXCL_EXP, EXCL_CAREER],
      );
    await page.waitForTimeout(4000);
    let r = await snapshotOnce();
    let stableTicks = 0;
    for (let tick = 0; tick < 20 && stableTicks < 2; tick++) {
      await page.waitForTimeout(1500);
      const next = await snapshotOnce();
      stableTicks = JSON.stringify(next) === JSON.stringify(r) ? stableTicks + 1 : 0;
      r = next;
    }
    const g = parseCount(r.growth);
    const info = parseCount(r.info);
    const abil = parseCount(r.ability);
    const exp = parseCount(r.exp);
    const car = parseCount(r.career);
    const sum = (info.total ?? 0) + (abil.total ?? 0) + (exp.total ?? 0) + (car.total ?? 0);
    const issues = [];
    if (info.total !== null && info.total !== r.infoCards) issues.push(`info 총${info.total}≠카드${r.infoCards}`);
    if (abil.total !== null && abil.total !== r.abilityCards) issues.push(`ability 총${abil.total}≠카드${r.abilityCards}`);
    // v14 역량 단일 정규화: 활동 주차(총!=null)는 총=1·렌더 1장·해당없음 금지.
    if (abil.total !== null) {
      if (abil.total !== 1) issues.push(`ability 총${abil.total}≠1 (v14 단일 정규화 위반)`);
      if (r.abilityCardCountAll !== 1) issues.push(`ability 렌더 ${r.abilityCardCountAll}장≠1장`);
      if (r.abilityBadges.some((b) => String(b).includes("not_applicable") || String(b).includes("해당")))
        issues.push(`ability 해당없음 뱃지 노출 금지 위반(${r.abilityBadges.join(",")})`);
    }
    if (exp.total !== null && exp.total !== r.expCards) issues.push(`exp 총${exp.total}≠카드${r.expCards}`);
    if (car.total !== null && car.total !== r.careerCards) issues.push(`career 총${car.total}≠카드${r.careerCards}`);
    if (g.total !== null && g.total !== sum) issues.push(`성장률총${g.total}≠허브합산${sum}`);
    if (issues.length) failures++;
    console.log(
      `${issues.length ? "✗" : "✓"} ${label} | 성장률 ${g.total ?? "-"} | info ${info.total ?? "-"}/${r.infoCards} | ability ${abil.total ?? "-"}/${r.abilityCards}[${r.abilityBadges.join(",") || "뱃지없음"}] | exp ${exp.total ?? "-"}/${r.expCards} | career ${car.total ?? "-"}/${r.careerCards}` +
        (issues.length ? `  ← ${issues.join(", ")}` : ""),
    );
  } catch (e) {
    failures++;
    console.log(`✗ ${label} 로드 실패: ${e.message}`);
  } finally {
    await page.close();
  }
}
await browser.close();
console.log(failures ? `\nFAIL (${failures}건)` : "\nPASS");
process.exit(failures ? 1 : 0);
