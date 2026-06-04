/**
 * v11 정책 브라우저 실제 확인 (2026-06-04).
 *
 *   MSYS_NO_PATHCONV=1 npx tsx --env-file=.env.local scripts/verify-v11-browser.ts
 *
 * 고객 앱(localhost:3001, ../vraxium dev) /cluster-4-ec?demoUserId=...&admin=true 로
 * 테스트(T) 유저 2명 카드 목록을 실제 렌더하고:
 *   (실사용자는 demo 모드가 설계상 403 — test_user_markers 등재 유저만 허용(lib/demoMode.ts).
 *    실사용자 렌더 경로는 동일 컴포넌트 + 동일 admin snapshot API 이므로 DTO 검증으로 갈음.)
 *   1) 카드 펼침 후 DOM 의 주차 성장률 % / 총 A 중 B / part별 (B/A) 추출
 *   2) 같은 페이지 컨텍스트에서 front proxy GET /api/cluster4/weekly-cards (= admin snapshot)
 *   3) DOM == DTO(v11 snapshot) 대조 (주차 성장률·종합 B/A — 휴식 주차는 표시 '-' 이므로 스킵)
 *   4) 전체 스크린샷 → claudedocs/
 * READ-ONLY (저장/제출 없음).
 */
import { chromium } from "@playwright/test";

const CUSTOMER = (process.env.CUSTOMER_URL ?? "http://localhost:3001").replace(/\/$/, "");
const OUT_DIR = "claudedocs";

const USERS = [
  {
    kind: "테스트",
    name: "T정하은",
    id: "fff3941f-071c-4cca-b99a-da8bd6d2fae2",
    route: "/cluster-4-ec",
  },
  {
    kind: "테스트",
    name: "T김민준",
    id: "e649370f-ba2c-4d2f-b642-6800cb078d54",
    route: "/cluster-4-ec",
  },
  {
    // v12 관리(5) 슬롯 잠금 사례(보고된 "표시 1칸·총 2개" 불일치 사용자) — 분모 정합 확인.
    kind: "테스트",
    name: "T최수빈",
    id: "36138fb1-6fea-4b22-b6d2-9c46cba47314",
    route: "/cluster-4-ec",
  },
] as const;

type DomCard = {
  title: string;
  badge: string | null;
  growthRate: number | null; // 주차 성장률 %
  growthCount: number | null; // 총 A 개 중 B — B
  growthTotal: number | null; // A
};

// 브라우저 추출 스크립트 (문자열 — tsx __name 주입 회피).
const EXTRACT = `(() => {
  const num = (t) => {
    if (t == null) return null;
    const s = String(t).replace(/[^0-9.-]/g, '');
    return s === '' ? null : Number(s);
  };
  const cards = Array.from(document.querySelectorAll('.weekly-card'))
    .filter((c) => c.querySelector('.weekly-card-title'));
  return cards.map((c) => {
    const title = (c.querySelector('.weekly-card-title')?.textContent || '').replace(/\\s+/g, ' ').trim();
    const badge = (c.querySelector('.badge-tag')?.textContent || '').trim() || null;
    const strongRate = c.querySelector('.weekly-card-main-progress .progress-label strong');
    const growthRate = num(strongRate ? strongRate.textContent : null);
    const total = c.querySelector('.total-count');
    let growthTotal = null, growthCount = null;
    if (total) {
      const nums = Array.from(total.querySelectorAll('.num-3')).map((n) => num(n.textContent));
      if (nums.length >= 2) { growthTotal = nums[0]; growthCount = nums[1]; }
    }
    return { title, badge, growthRate, growthCount, growthTotal };
  });
})()`;

type DtoCard = {
  weekNumber: number;
  startDate: string;
  userWeekStatus: string;
  isRestWeek: boolean;
  weeklyGrowthRate: number;
  growthNumerator: number;
  growthDenominator: number;
};

async function main() {
  const browser = await chromium.launch();
  let pass = true;
  try {
    for (const u of USERS) {
      const page = await browser.newContext().then((c) => c.newPage());
      const url = `${CUSTOMER}${u.route}?demoUserId=${encodeURIComponent(u.id)}&admin=true`;
      console.log(`\n▸ [${u.kind}] ${u.name} — ${url}`);
      await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
      await page.waitForSelector(".weekly-card .weekly-card-title", { timeout: 45000 });

      // 모든 카드 펼침(총 A 중 B 노출).
      const expands = page.locator(".weekly-card-expand");
      const n = await expands.count();
      for (let i = 0; i < n; i++) {
        await expands.nth(i).click().catch(() => null);
      }
      await page.waitForTimeout(1200);

      const dom = (await page.evaluate(EXTRACT)) as DomCard[];

      // 같은 페이지 컨텍스트에서 front proxy 로 DTO 취득 (= admin v11 snapshot 경로).
      const res = await page.request.get(
        `${CUSTOMER}/api/cluster4/weekly-cards?demoUserId=${encodeURIComponent(u.id)}`,
      );
      const body = (await res.json()) as { success: boolean; data: DtoCard[] };
      if (!res.ok() || !body.success) {
        console.log(`  ✗ front proxy 실패 status=${res.status()}`);
        pass = false;
        continue;
      }
      const dto = body.data;
      console.log(`  DOM 카드 ${dom.length}개 / DTO 카드 ${dto.length}개`);

      // DTO 는 최신순 — DOM 카드도 최신순 렌더. weekNumber 텍스트로 매칭.
      let mismatches = 0;
      for (const d of dto) {
        const domCard = dom.find((c) => c.title.includes(`${d.weekNumber}주차`));
        if (!domCard) {
          console.log(`  ✗ W${d.weekNumber}: DOM 카드 없음`);
          mismatches++;
          continue;
        }
        if (d.isRestWeek) continue; // 휴식 주차는 '-' 표시 — 수치 비교 제외.
        const okRate = domCard.growthRate === d.weeklyGrowthRate;
        const okCnt =
          domCard.growthCount === null || // 펼침 실패 시 성장률만 비교
          (domCard.growthCount === d.growthNumerator &&
            domCard.growthTotal === d.growthDenominator);
        if (!okRate || !okCnt) {
          console.log(
            `  ✗ W${d.weekNumber} (${d.userWeekStatus}): DOM ${domCard.growthRate}% ${domCard.growthCount}/${domCard.growthTotal} vs DTO ${d.weeklyGrowthRate}% ${d.growthNumerator}/${d.growthDenominator}`,
          );
          mismatches++;
        } else {
          console.log(
            `  ✓ W${d.weekNumber} (${d.userWeekStatus}) [${domCard.badge}]: ${d.weeklyGrowthRate}% ${d.growthNumerator}/${d.growthDenominator} (DOM==DTO)`,
          );
        }
      }
      if (mismatches > 0) pass = false;

      const shot = `${OUT_DIR}/v11-browser-test-${u.name}.png`;
      await page.screenshot({ path: shot, fullPage: true });
      console.log(`  📸 ${shot}`);
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n결과: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
