// 레거시 통합 라인 브라우저 검증 — front(3001) 주차 카드 상세 3건
//   1) 테스터(졸업 트랙) 성공 주차  2) 테스터 실패 주차  3) 실유저(foreign-viewer) 주차
import { chromium } from "playwright-core";

const BASE = "http://localhost:3001";
const GRAD = "4a81b6d1-e488-4f14-8530-0cad60fe4f0d"; // T장유준 (encre, graduate)
const LOW = "36138fb1-6fea-4b22-b6d2-9c46cba47314"; // T최수빈 (low — fail 주차)
const REAL = "974ba08b-7411-4fc8-ab22-178977de73a8"; // 실유저 (success 3)
const W12 = "00000000-0000-0000-0000-202605210002"; // 2026-05-18
const W11 = "67e07106-564e-4dab-b180-8f11c909973a"; // 2026-05-11
const W10 = "6cc59d70-3aa6-4823-8854-5b82691d1a84"; // 2026-05-04

const CASES = [
  ["tester-grad-W12", `${BASE}/cluster-4-card/${W12}?demoUserId=${GRAD}`],
  ["tester-low-W11", `${BASE}/cluster-4-card/${W11}?demoUserId=${LOW}`],
  ["real-W10-foreign", `${BASE}/cluster-4-card/${W10}?demoUserId=${GRAD}&userId=${REAL}`],
];

const browser = await chromium.launch({ channel: "chromium" });
for (const [label, url] of CASES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 2600 } });
  console.log(`\n===== ${label} =====\n${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(15000);
  const text = await page.evaluate(() => document.body.innerText);
  const has = (s) => text.includes(s);
  console.log("통합 라인명 노출:", has("[통합] 주차 활동 내역") ? "✅" : "❌");
  console.log("통합 메인타이틀:", has("아우르는 통합 기록입니다. (26년 6월 이전)") ? "✅" : "❌");
  console.log("서브타이틀(기존 주차 활동 내역):", has("기존 주차 활동 내역") ? "✅" : "❌");
  // 구 허브 라인명 잔존 여부
  const oldNames = ["엔터테인먼트/미디어 콘텐츠 제작", "마케팅 실무_기획/제작", "니즈의 파악", "레퍼런스 분석"];
  const leaked = oldNames.filter((n) => has(n));
  console.log("구 라인명 잔존:", leaked.length ? `❌ ${leaked.join("|")}` : "✅ 없음");
  const idx = text.indexOf("라인별 강화 결과");
  if (idx >= 0) {
    console.log("--- 라인별 강화 결과 섹션 ---");
    console.log(text.slice(idx, idx + 1400));
  } else {
    console.log("(라인별 강화 결과 섹션 미발견 — 페이지 전체 앞부분)");
    console.log(text.slice(0, 800));
  }
  await page.screenshot({ path: `claudedocs/legacy-unified-${label}.png`, fullPage: true });
  console.log(`screenshot: claudedocs/legacy-unified-${label}.png`);
  await page.close();
}
await browser.close();
