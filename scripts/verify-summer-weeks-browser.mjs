// 파일럿 브라우저 검증 (운영, read-only): T윤도현 — 고객 앱 3화면 실측.
//   /cluster-1: 시즌 기록에 "정상 졸업" + "25 여름" 행이 8/8 로 표시
//   /cluster-4-1: 시즌 상태 배지 "시즌 중 졸업"
//   /cluster-4: 역대 시즌에 "2025 여름 시즌" 주차 카드 존재(성장 표시)
//   node scripts/verify-summer-weeks-browser.mjs <userId>
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const requireFront = createRequire(resolve(frontRoot, "package.json"));
const { chromium } = requireFront("playwright");

const userId = process.argv[2];
if (!userId) throw new Error("usage: node ... <userId>");
const FRONT = "https://vraxium.vercel.app";

const browser = await chromium.launch({ channel: "chromium", headless: true });
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const probe = (text, keyword, span = 100) => {
  const i = text.indexOf(keyword);
  return i < 0 ? null : text.slice(Math.max(0, i - span), i + keyword.length + span).replace(/\n/g, " | ");
};

try {
  // ── 1) /cluster-1 이력서 ──────────────────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 1366, height: 2400 } });
    await page.goto(`${FRONT}/cluster-1?userId=${userId}`, { waitUntil: "domcontentloaded" });
    await page
      .waitForFunction(`document.body.innerText.includes("정상 졸업")`, undefined, { timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(4000);
    // 시즌 기록 테이블이 지연 로드/스크롤 하단일 수 있어 전체 스크롤
    for (let i = 0; i < 10; i++) {
      await page.evaluate("window.scrollBy(0, 1500)");
      await page.waitForTimeout(300);
    }
    const text = await page.evaluate("document.body.innerText");
    check("cluster-1 '정상 졸업' 표시", text.includes("정상 졸업"), probe(text, "정상 졸업") ?? "(미발견)");
    const summerIdx = text.indexOf("여름");
    const summerCtx = summerIdx >= 0 ? text.slice(Math.max(0, summerIdx - 120), summerIdx + 200) : "";
    const has48 = /4\s*\/\s*8/.test(summerCtx) || /4\s*주\s*\/\s*8\s*주/.test(summerCtx);
    check("cluster-1 25 여름 시즌 4/8 (8/8 아님)", summerIdx >= 0 && has48 && !/8\s*주\s*\/\s*8\s*주/.test(summerCtx), summerCtx.replace(/\n/g, " | ").slice(0, 220) || "(여름 행 미발견)");
    check("cluster-1 '정상 완료' 표시", text.includes("정상 완료"), probe(text, "정상 완료") ?? "(미발견)");
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-summer-pilot-cluster1.png"), fullPage: true });
    await page.close();
  }

  // ── 2) /cluster-4-1 진입 화면 ────────────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 1366, height: 2200 } });
    await page.goto(`${FRONT}/cluster-4-1?userId=${userId}`, { waitUntil: "domcontentloaded" });
    await page
      .waitForFunction(`document.body.innerText.includes("시즌")`, undefined, { timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(6000);
    const text = await page.evaluate("document.body.innerText");
    check("cluster-4-1 '시즌 중 졸업' 배지", text.includes("시즌 중 졸업"), probe(text, "시즌 중 졸업") ?? "(미발견)");
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-summer-pilot-cluster41.png"), fullPage: false });
    await page.close();
  }

  // ── 3) /cluster-4 카드 목록 — 여름 시즌 카드 ─────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 1366, height: 2200 } });
    await page.goto(`${FRONT}/cluster-4?userId=${userId}`, { waitUntil: "domcontentloaded" });
    await page
      .waitForFunction(`document.body.innerText.includes("역대 시즌")`, undefined, { timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(3000);
    // 드롭다운에서 "2025 여름 시즌"(또는 '여름 시즌' 항목) 선택 시도
    let clicked = null;
    for (let i = 0; i < 20 && !clicked; i++) {
      clicked = await page.evaluate(`(() => {
        const opts = [...document.querySelectorAll('div,button,li,span')]
          .filter(e => e.innerText && /여름 시즌$/.test(e.innerText.trim()) && e.innerText.trim().length < 20 && e.querySelectorAll('*').length < 4);
        if (opts.length) { opts[opts.length - 1].click(); return opts[opts.length - 1].innerText.trim(); }
        const openers = [...document.querySelectorAll('div,button,span')]
          .filter(e => e.innerText && e.innerText.trim().replace(/\\s+/g, ' ') === '역대 시즌 ▼');
        if (openers.length) openers[openers.length - 1].click();
        return null;
      })()`);
      await page.waitForTimeout(700);
    }
    console.log("[cluster-4] 시즌 필터 선택:", clicked);
    await page.waitForTimeout(1500);
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      await page.evaluate("window.scrollBy(0, 1400)");
      await page.waitForTimeout(300);
      found = await page.evaluate(
        `document.body.innerText.includes('여름 시즌, 1주차') || document.body.innerText.includes('여름 시즌, 4주차')`,
      );
    }
    const text = await page.evaluate("document.body.innerText");
    check("cluster-4 여름 시즌 주차 카드 존재", found, probe(text, "여름 시즌,") ?? "(미발견)");
    const w1 = probe(text, "여름 시즌, 1주차");
    const w4 = probe(text, "여름 시즌, 4주차");
    if (w1) console.log("   W1 부근:", w1.slice(0, 200));
    if (w4) console.log("   W4 부근:", w4.slice(0, 200));
    const successShown = [w1, w4].filter(Boolean).every((s) => s.includes("성장") && !s.includes("휴식(공식)"));
    check("cluster-4 여름 카드 성장(성공) 표시", Boolean(w1 || w4) && successShown);
    check(
      "cluster-4 여름 W5~W8 카드 소멸",
      !text.includes("여름 시즌, 5주차") && !text.includes("여름 시즌, 8주차"),
    );
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-summer-pilot-cluster4.png"), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n❌ 실패 ${failures}건` : "\n✅ 브라우저 검증 전부 통과");
process.exit(failures ? 1 : 0);
