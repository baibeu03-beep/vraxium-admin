// 브라우저 검증 — 봄 시즌(레거시 통합 임시 라인) 주차의 Detail Log 가
//   experienceRate(백엔드 스냅샷) 를 그대로 표시하는지 확인.
//   대상: T윤도현(encre, 테스트 유저) 2026-spring W13(success) — 통합 임시 라인 1개 → total=1.
//   기대: Detail Log 모달에 "오픈된 라인 1개 중 1개" 류 문구가 보인다.
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontRoot = resolve(__dirname, "..", "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");

const FRONT = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const DEMO = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현 (encre)
const WEEK = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13 (success, exp total=1)
const URL = `${FRONT}/cluster-4-card-ec/${WEEK}?demoUserId=${DEMO}`;

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
page.on("console", (m) => { if (m.type() === "error") console.log("    [browser console.error]", m.text()); });

try {
  console.log("URL:", URL);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
  // Detail Log 버튼 노출 대기
  await page.waitForSelector(".detail-log-btn", { timeout: 30000 });
  check("Detail Log 버튼 렌더", true);

  await page.click(".detail-log-btn");
  await page.waitForSelector(".dl-check-text", { timeout: 15000 });

  const texts = await page.$$eval(".dl-check-text", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  console.log("  조건 문구:");
  texts.forEach((t) => console.log("    -", t));

  const expLine = texts.find((t) => t.includes("[실무 경험]"));
  check("experience 조건 문구 존재", !!expLine, expLine ?? "");
  check(
    "오픈된 라인 1개 중 1개 표시(통합 임시 라인 인정)",
    !!expLine && /오픈된 라인\s*1개\s*중\s*1개/.test(expLine),
    expLine ?? "",
  );
  check(
    "'오픈된 라인이 없어요' 아님(레거시 0개 버그 미재현)",
    !!expLine && !expLine.includes("오픈된 라인이 없어요"),
  );

  await page.screenshot({ path: "claudedocs/browser-spring-detail-log.png", fullPage: false });
  console.log("  screenshot: claudedocs/browser-spring-detail-log.png");
} catch (e) {
  console.error("ERROR:", e.message);
  try { await page.screenshot({ path: "claudedocs/browser-spring-detail-log-error.png" }); } catch {}
  fail++;
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
