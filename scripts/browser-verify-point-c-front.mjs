// 브라우저 실측(고객 앱 :3001): Point C(어흥/번개) 양수 + 빨강 표기.
//   진입화면 area-4-stats(시즌 누적) 3값 = 단감(별)/인절미(방패=net)/어흥(포인트C).
//   어흥은 마이너스 없이 양수, 빨강. 단감/인절미는 연두. (값은 admin proxy + pointC fallback.)
//   대상: 옥지윤(pen 이력 존재). 사전조건: front dev :3001 + admin :3000.
//   node scripts/browser-verify-point-c-front.mjs
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const frontRoot = resolve(__dirname, "..", "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");

const TESTER = "36138fb1-6fea-4b22-b6d2-9c46cba47314"; // demo 인증 actor
const TARGET = "abef6e53-53c5-4277-bb70-e031153e533f"; // 옥지윤
const BASE = "http://localhost:3001";
const qs = `demoUserId=${TESTER}&userId=${TARGET}`;
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const parse = (s) => {
  const rgb = String(s).match(/rgba?\(([^)]+)\)/); if (rgb) { const [r, g, b] = rgb[1].split(/[,\s/]+/).map(Number); return { r, g, b }; }
  const lab = String(s).match(/lab\(([^)]+)\)/); if (lab) { const [, a] = lab[1].split(/[\s/]+/).map(Number); return { lab: true, a }; }
  return null;
};
const isRed = (c) => c && (c.lab ? c.a > 40 : c.r > 120 && c.r > c.g + 40 && c.r > c.b + 40);
const isGreen = (c) => c && (c.lab ? c.a < -20 : c.g > 90 && c.g > c.r + 20 && c.g > c.b + 20);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
await page.goto(`${BASE}/cluster-4-1?${qs}`, { waitUntil: "domcontentloaded", timeout: 90000 });

const t0 = Date.now();
let r = null;
while (Date.now() - t0 < 45000) {
  r = await page.evaluate(() => {
    const stats = [...document.querySelectorAll(".area-4-stats .stat")].map((s) => {
      const n = s.querySelector(".number");
      return n ? { text: n.textContent.trim(), color: getComputedStyle(n).color } : null;
    }).filter(Boolean);
    return { ready: stats.length >= 3 && stats.some((x) => x.text !== "0"), stats };
  });
  if (r?.ready) break;
  await page.waitForTimeout(1500);
}
console.log(`  area-4-stats: ${JSON.stringify(r?.stats ?? null)}`);
const stats = r?.stats ?? [];
ck("3개 지표(단감/인절미/어흥) 렌더", stats.length >= 3);
if (stats.length >= 3) {
  const [dangam, injeolmi, eoheung] = stats;
  ck("단감(Point A) 연두", isGreen(parse(dangam.color)), `${dangam.text}=${dangam.color}`);
  ck("인절미(최종 Point B) 연두", isGreen(parse(injeolmi.color)), `${injeolmi.text}=${injeolmi.color}`);
  ck("어흥(Point C) 빨강", isRed(parse(eoheung.color)), `${eoheung.text}=${eoheung.color}`);
  ck("어흥(Point C) 마이너스 부호 없음", !/^-/.test(eoheung.text), `값="${eoheung.text}"`);
}
await page.screenshot({ path: "claudedocs/point-c-front-entry.png" });
console.log("  📸 claudedocs/point-c-front-entry.png");
console.log(`\n결과: ${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
await browser.close();
process.exit(fail ? 1 : 0);
