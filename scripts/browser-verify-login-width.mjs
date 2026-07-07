// 폰트 확대 후 로그인 계열 화면 폭/높이 보정 검증.
//   · /login, /forgot-password 를 데스크톱(1440)·좁은 화면(420) 순회.
//   · 측정: 로그인 카드 실측 폭, input/button 실측 높이, 안내 박스 줄바꿈(2줄 이상 가능),
//     페이지 가로 오버플로, main 밖 삐져나온 요소.
//   · 스크린샷: claudedocs/qa-login-*.png
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

async function visit(url) {
  try { await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 30000 }); }
  catch { await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 30000 }); }
  await page.waitForTimeout(800);
}

function measure() {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const card = q('[data-slot="card"]');
    const input = q('[data-slot="input"]');
    const submit = Array.from(document.querySelectorAll('button[type="submit"]')).pop();
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const cr = r(card), ir = r(input), br = r(submit);
    const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
    const vw = window.innerWidth;
    const bleeders = Array.from(document.querySelectorAll("main *")).filter((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return rect.right > vw + 2;
    }).length;
    return {
      cardW: cr ? Math.round(cr.width) : null,
      inputH: ir ? Math.round(ir.height) : null,
      buttonH: br ? Math.round(br.height) : null,
      docOverflow, bleeders,
    };
  });
}

try {
  for (const [w] of [[1440], [420]]) {
    console.log(`\n=== viewport ${w} ===`);
    await page.setViewportSize({ width: w, height: 900 });

    await visit("/login");
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `qa-login-${w}.png`) });
    const m = await measure();
    console.log(`  [login] card=${m.cardW}px input=${m.inputH}px button=${m.buttonH}px docOverflow=${m.docOverflow} bleeders=${m.bleeders}`);
    if (w === 1440) {
      check("[1440] 로그인 카드 폭 >= 440px (기존 max-w-sm=384 대비 확장)", m.cardW >= 440, `${m.cardW}px`);
      check("[1440] input 높이 >= 40px", m.inputH >= 40, `${m.inputH}px`);
      check("[1440] 로그인 버튼 높이 >= 40px", m.buttonH >= 40, `${m.buttonH}px`);
    }
    check(`[${w}] 페이지 가로 오버플로 없음`, m.docOverflow <= 2, `docOverflow=${m.docOverflow}px`);
    check(`[${w}] main 밖 삐져나온 요소 없음`, m.bleeders === 0, `bleeders=${m.bleeders}`);

    await visit("/forgot-password");
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `qa-forgot-${w}.png`) });
    const f = await measure();
    console.log(`  [forgot] card=${f.cardW}px docOverflow=${f.docOverflow} bleeders=${f.bleeders}`);
    check(`[${w}] forgot 가로 오버플로 없음`, f.docOverflow <= 2, `docOverflow=${f.docOverflow}px`);
  }
  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
