/**
 * 브라우저(Playwright)에서 일반 모드 ↔ 데모 모드가 수신하는 주차 카드 페이로드 동일성 확인.
 * 실제 카드 UI 는 인접 vraxium(고객) repo 소관 — 본 admin repo 는 JSON API 만 제공하므로
 * "브라우저가 실제로 받는 DTO payload" 기준으로 두 모드를 비교하고 스크린샷을 저장한다.
 *
 *   USER_ID=<uuid> BASE_URL=http://localhost:3000 \
 *     npx tsx --env-file=.env.local scripts/diag-cluster4-card-browser-normal-vs-demo.ts
 *
 * READ-ONLY. 스크린샷은 claudedocs/ 에 저장.
 */
import { chromium } from "@playwright/test";

function resolveUserId(): string {
  const id = (process.env.USER_ID ?? "").trim() || (process.argv[2] ?? "").trim();
  if (!id) throw new Error("USER_ID 미지정.");
  return id;
}

type Card = { weekId: string | null; points?: { shield: number | null; lightning: number | null }; cumulativeInjeolmi: number | null; fameScore: number | null };

function summarize(cards: Card[]) {
  let s = 0,
    l = 0;
  for (const c of cards) {
    s += c.points?.shield ?? 0;
    l += c.points?.lightning ?? 0;
  }
  return {
    weekCount: cards.length,
    cumulativeInjeolmi: cards[0]?.cumulativeInjeolmi ?? null,
    netShield: s - Math.abs(l),
    fameScore: cards[0]?.fameScore ?? null,
  };
}

async function main() {
  const userId = resolveUserId();
  const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const internalKey = process.env.INTERNAL_API_KEY ?? "";
  const outDir = "claudedocs";

  const browser = await chromium.launch();
  try {
    // 일반 모드: 브라우저 컨텍스트에 internal key 헤더 부여(세션 normal 과 downstream 동일).
    const normalCtx = await browser.newContext({
      extraHTTPHeaders: internalKey ? { "x-internal-api-key": internalKey } : {},
    });
    const normalPage = await normalCtx.newPage();
    const normalUrl = `${baseUrl}/api/cluster4/weekly-cards?userId=${encodeURIComponent(userId)}`;
    await normalPage.goto(normalUrl, { waitUntil: "networkidle" });
    const normalText = await normalPage.evaluate(() => document.body.innerText);
    await normalPage.screenshot({ path: `${outDir}/cluster4-card-normal.png`, fullPage: true });

    // 데모 모드: 인증 헤더 없음, ?demoUserId= 로 접근(브라우저 직접 로드 가능).
    const demoCtx = await browser.newContext();
    const demoPage = await demoCtx.newPage();
    const demoUrl = `${baseUrl}/api/cluster4/weekly-cards?demoUserId=${encodeURIComponent(userId)}`;
    await demoPage.goto(demoUrl, { waitUntil: "networkidle" });
    const demoText = await demoPage.evaluate(() => document.body.innerText);
    await demoPage.screenshot({ path: `${outDir}/cluster4-card-demo.png`, fullPage: true });

    const normalJson = JSON.parse(normalText) as { success: boolean; data: Card[] };
    const demoJson = JSON.parse(demoText) as { success: boolean; data: Card[] };

    const normalCards = Array.isArray(normalJson.data) ? normalJson.data : [];
    const demoCards = Array.isArray(demoJson.data) ? demoJson.data : [];

    const equal = JSON.stringify(normalCards) === JSON.stringify(demoCards);

    console.log(`\n════════ 브라우저 수신 payload 비교 (userId=${userId}) ════════`);
    console.table([
      { mode: "normal(브라우저)", success: normalJson.success, ...summarize(normalCards) },
      { mode: "demo(브라우저)", success: demoJson.success, ...summarize(demoCards) },
    ]);
    console.log(`  normal == demo (브라우저 수신 DTO): ${equal ? "✅ 완전 일치" : "❌ 불일치"}`);
    console.log(`  스크린샷: ${outDir}/cluster4-card-normal.png , ${outDir}/cluster4-card-demo.png`);
    console.log("\n  ※ 실제 카드 렌더 UI 는 인접 vraxium(고객) repo 소관 — 본 repo 는 JSON API 만 제공.");
    console.log("     따라서 DOM 카드 렌더가 아닌 '브라우저가 받는 DTO payload' 기준으로 동일성을 확인.\n");

    process.exitCode = equal && normalJson.success && demoJson.success ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
