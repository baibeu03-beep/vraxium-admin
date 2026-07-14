// 고객 앱 실무 역량 카드: 비대상 synthetic fail 유저의 "강화 실패 + 총 N개 중 M개" 렌더 검증.
//   대상: T이하준(phalanx, 봄 W10 6cc59d70) — 비대상 synthetic fail(enh=fail, den=1).
//   수정(realCompetencyLines=enhancementStatus 기준) 후 기대: 강화 실패 + 총 1개 중 0개 (총 0 아님).
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const frontRoot = resolve(__dirname, "..", "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");

const UID = "7e15f412-65be-481c-8525-460b161244ca";
const WEEK = "6cc59d70-3aa6-4823-8854-5b82691d1a84";
const FRONT = "http://localhost:3001";
const routes = [
  `${FRONT}/cluster-4-card-px/${WEEK}?admin=true&demoUserId=${UID}&org=phalanx`,
  `${FRONT}/cluster-4-card/${WEEK}?admin=true&demoUserId=${UID}&org=phalanx`,
];

const b = await chromium.launch({ channel: "chromium", headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 2200 } });
const p = await ctx.newPage();
p.on("console", (m) => { const t = m.text(); if (/competencyStats|realCompetency/i.test(t)) console.log("  [console]", t.slice(0, 120)); });

try {
  let loaded = null;
  for (const url of routes) {
    console.log(`\n시도: ${url}`);
    const res = await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => ({ status: () => "ERR:" + e.message }));
    console.log(`  HTTP=${typeof res.status === "function" ? res.status() : res}`);
    await p.waitForTimeout(2000);
    // 실무 역량 텍스트가 나타날 때까지 대기
    const hasComp = await p.waitForFunction(
      () => /실무\s*역량/.test(document.body.innerText),
      undefined, { timeout: 25000 },
    ).then(() => true).catch(() => false);
    if (hasComp) { loaded = url; break; }
  }
  if (!loaded) { console.log("실무 역량 섹션 로드 실패(라우트/데모 인증 확인 필요)"); }
  // 데이터 로딩 완료 대기 — "데이터를 열심히 불러오고 있어요" 문구가 사라지고 competency 카드가 확정될 때까지.
  await p.waitForFunction(
    () => !/데이터를 열심히 불러오고/.test(document.body.innerText),
    undefined, { timeout: 40000 },
  ).catch(() => console.log("  (로딩 문구 대기 timeout)"));
  await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(4000);

  // 실무 역량 섹션의 "총 N 개 중 M 개" 추출 — "실무 역량" 뒤에 바로 총/중 이 오는 위치를 찾는다
  //   (사이드바 "실무 역량 성장" 칩과 구분).
  const compBlock = await p.evaluate(() => {
    const body = document.body.innerText.replace(/\s+/g, " ");
    const re = /실무 역량\s*총\s*(\d+|-)\s*개\s*중\s*(\d+|-)\s*개/g;
    const m = re.exec(body);
    if (m) return { around: m[0], total: m[1], done: m[2] };
    // 폴백: "실무 역량" 인근 300자에서 총/중
    const idx = body.indexOf("실무 역량 총");
    const around = idx >= 0 ? body.slice(idx, idx + 60) : "(패턴 없음)";
    const m2 = around.match(/총\s*(\d+|-)\s*개\s*중\s*(\d+|-)\s*개/);
    return { around, total: m2?.[1] ?? null, done: m2?.[2] ?? null };
  });
  // 강화 실패/성공 배지 존재 여부(실무 역량 영역)
  const badge = await p.evaluate(() => {
    const body = document.body.innerText;
    return {
      hasFail: /강화\s*실패/.test(body),
      hasSuccess: /강화\s*성공/.test(body),
      hasNA: /해당\s*없음/.test(body),
    };
  });
  console.log("\n=== 실무 역량 렌더 ===");
  console.log("  강화율 블록:", JSON.stringify(compBlock));
  console.log("  배지:", JSON.stringify(badge));
  await p.screenshot({ path: resolve(__dirname, "..", "claudedocs", "qa-competency-front-aggregate.png"), fullPage: true });
  console.log("\n=== 판정 ===");
  const total = compBlock.total;
  console.log(`  기대: 강화 실패 표시 + 총 >=1 (총 0 금지). 실제 총=${total}`);
  console.log(`  => ${badge.hasFail && total && total !== "0" ? "PASS ✅ (강화실패 + 총>=1, 모순 없음)" : total === "0" ? "FAIL ❌ (여전히 총 0)" : "확인 필요"}`);
} catch (e) {
  console.error("ERROR:", e?.stack ?? e?.message ?? e);
} finally {
  await b.close();
}
