// front 카드 상세(/cluster-4-card/{weekId}) 브라우저 검증 — raw weeks.is_official_rest 직독 표면.
//   W5 상세 = 휴식(공식) 아님 / W8 상세 = 휴식(공식).
//     node scripts/verify-winter-rest-card-detail.mjs <userId>
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");

const userId = process.argv[2];
if (!userId) throw new Error("usage: node ... <userId>");
const FRONT = "https://vraxium.vercel.app";
const W5 = "8bd20da1-dca3-4618-879e-5008c6020bf5";
const W8 = "97a6523b-0e0e-4de7-93c5-bb8404ac9ac2";

const browser = await chromium.launch({ channel: "chromium", headless: true });
let failures = 0;
for (const [label, weekId, expectRest] of [["W5", W5, false], ["W8", W8, true]]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });
  await page.goto(`${FRONT}/cluster-4-card/${weekId}?userId=${userId}`, { waitUntil: "domcontentloaded" });
  // 주차 라벨 또는 상태 텍스트 렌더 대기
  await page.waitForFunction(
    "document.body.innerText.includes('주차') && document.body.innerText.length > 800",
    undefined,
    { timeout: 60000 },
  );
  await page.waitForTimeout(4000); // weekly-cards DTO/uws fetch 반영 여유
  const text = await page.evaluate("document.body.innerText");
  const hasOfficialRest = text.includes("휴식(공식)") || text.includes("휴식 (공식)") || text.includes("공식 휴식주");
  const head = text.slice(0, 60).replace(/\n/g, " | ");
  console.log(`[${label}] head="${head}" 휴식(공식) 표기=${hasOfficialRest} (기대 ${expectRest})`);
  const ok = hasOfficialRest === expectRest;
  console.log(`[${label}] ${ok ? "✅" : "❌"}`);
  if (!ok) {
    failures++;
    const i = text.indexOf("휴식");
    console.log(`  [debug] '휴식' 부근: ${i >= 0 ? text.slice(Math.max(0, i - 120), i + 120).replace(/\n/g, " | ") : "(없음)"}`);
  }
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", `browser-front-card-detail-${label}.png`), fullPage: true });
  await page.close();
}
await browser.close();
console.log(failures ? `\n❌ 실패 ${failures}건` : "\n✅ 카드 상세 검증 통과");
process.exit(failures ? 1 : 0);
