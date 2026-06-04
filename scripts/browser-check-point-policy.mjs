// 브라우저 실측: 포인트 표시 정책(별=check · 방패=net · 번개=−n) 고객 화면 반영 확인.
//   대상: 옥지윤 (rawAdv=3 pen=2 net=1 star=8 — raw≠net 이라 raw 노출 시 즉시 탐지)
//     1) /cluster-4-1 진입 화면 area-4-stats(시즌 누적, Cluster4Content) → 8 / 1 / -2
//     2) /cluster-4   주차 카드 목록(Cluster41Content, 2026-05-18 pen=2) → 단감 1 / 인절미 -2 / 어흥 -2
//     3) /cluster-4-card/{weekId} 상세 헤더 → 동일
//     4) /cluster-3   성장 코어 점수 기록 → 8 / 1 / -2
//   라우트-컴포넌트 교차 주의: /cluster-4-1 = Cluster4Content(진입), /cluster-4 = Cluster41Content(카드 목록).
//   node scripts/browser-check-point-policy.mjs
import { chromium } from "playwright";

const TESTER = "36138fb1-6fea-4b22-b6d2-9c46cba47314"; // T최수빈 (demo 인증 actor)
const TARGET = "abef6e53-53c5-4277-bb70-e031153e533f"; // 옥지윤
const WEEK_0518 = "00000000-0000-0000-0000-202605210002"; // 2026-05-18 (raw adv=0 pen=2 star=1 → 표시 1 / -2 / -2)
const BASE = "http://localhost:3001";
const qs = `demoUserId=${TESTER}&userId=${TARGET}`;

const browser = await chromium.launch();
let failures = 0;
const check = (label, actual, expected) => {
  const ok = String(actual).replace(/\s+/g, "") === String(expected).replace(/\s+/g, "");
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: "${actual}" (기대 "${expected}")`);
};

async function open(path) {
  const page = await browser.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  return page;
}

// 조건 충족까지 폴링 (애니메이션/지연 fetch 안정화)
async function pollUntil(page, fn, timeoutMs = 40000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(fn);
    if (last && last.ready) return last;
    await page.waitForTimeout(1000);
  }
  return last;
}

// 1) 진입 화면 area-4-stats
{
  console.log("\n[1] /cluster-4-1 진입 화면 area-4-stats (시즌 누적 — 기대 8 / 1 / -2)");
  const page = await open(`/cluster-4-1?${qs}`);
  const r = await pollUntil(page, () => {
    const nums = [...document.querySelectorAll(".area-4-stats .stat .number")].map((n) => n.textContent.trim());
    return { ready: nums.length >= 3 && nums.some((n) => n !== "0"), nums };
  });
  check("단감(별)", r?.nums?.[0], "8");
  check("인절미(방패=net)", r?.nums?.[1], "1");
  check("어흥(번개=−n)", r?.nums?.[2], "-2");
  await page.screenshot({ path: "claudedocs/point-policy-cluster4-entry.png" });
  await page.close();
}

// 2) 주차 카드 목록 — 2026-05-18 카드의 metric
{
  console.log("\n[2] /cluster-4 주차 카드 (2026-05-18 — 기대 단감 1 / 인절미 -2 / 어흥 -2)");
  const page = await open(`/cluster-4?${qs}`);
  const r = await pollUntil(page, () => {
    const cards = [...document.querySelectorAll(".weekly-card-content")].map((root) => ({
      date: root.querySelector(".weekly-card-date")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      values: [...root.querySelectorAll(".info-item.with-icon .number-value")].map((x) => x.textContent.trim()),
    }));
    const target = cards.find((c) => /05[.\s/-]*18|5\s*\.\s*18/.test(c.date));
    return { ready: !!target && (target.values?.length ?? 0) >= 3, target, count: cards.length };
  });
  console.log(`  카드 ${r?.count ?? 0}개, 05-18 카드(${r?.target?.date ?? "-"}): ${JSON.stringify(r?.target?.values ?? null)}`);
  check("단감(별)", r?.target?.values?.[0], "1");
  check("인절미(방패=net)", r?.target?.values?.[1], "-2");
  check("어흥(번개=−n)", r?.target?.values?.[2], "-2");
  await page.screenshot({ path: "claudedocs/point-policy-cluster41-list.png", fullPage: true });
  await page.close();
}

// 3) 상세 헤더 (.info-item.with-icon .number-value)
{
  console.log("\n[3] /cluster-4-card/{2026-05-18} 헤더 (기대 단감 1 / 인절미 -2 / 어흥 -2)");
  const page = await open(`/cluster-4-card/${WEEK_0518}?${qs}`);
  const r = await pollUntil(page, () => {
    const vals = [...document.querySelectorAll(".info-item.with-icon .number-value")].map((n) => n.textContent.trim());
    return { ready: vals.length >= 3, vals };
  });
  console.log(`  header number-values: ${JSON.stringify(r?.vals ?? null)}`);
  check("단감(별)", r?.vals?.[0], "1");
  check("인절미(방패=net)", r?.vals?.[1], "-2");
  check("어흥(번개=−n)", r?.vals?.[2], "-2");
  await page.screenshot({ path: "claudedocs/point-policy-cluster4card-header.png" });
  await page.close();
}

// 4) 성장 코어 점수 기록
{
  console.log("\n[4] /cluster-3 성장 코어 점수 기록 (기대 8 / 1 / -2)");
  const page = await open(`/cluster-3?${qs}`);
  const r = await pollUntil(page, () => {
    const rows = [...document.querySelectorAll(".info-row")]
      .map((x) => x.textContent.replace(/\s+/g, " ").trim())
      .filter((t) => /단감|인절미|어흥|별|방패|번개|투구|화살/.test(t));
    // 숫자 애니메이션 중 0 으로 잡히는 것 방지 — 0 이 아닌 수치가 등장할 때까지 대기.
    return { ready: rows.length >= 3 && rows.some((t) => /[1-9]/.test(t)), rows };
  });
  console.log("  rows:", JSON.stringify(r?.rows ?? null));
  const joined = (r?.rows ?? []).join(" | ");
  check("별/단감 8", /(단감|별|투구)\(총합\)\s*8\b/.test(joined), "true");
  check("방패/인절미 1", /(인절미|방패)\(총합\)\s*1\b/.test(joined), "true");
  check("번개/어흥 -2", /(어흥|번개|화살)\(총합\)\s*-2\b/.test(joined), "true");
  await page.screenshot({ path: "claudedocs/point-policy-cluster3-points.png" });
  await page.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "✓ 브라우저 전체 통과" : `✗ 실패 ${failures}건`}`);
process.exit(failures === 0 ? 0 : 1);
