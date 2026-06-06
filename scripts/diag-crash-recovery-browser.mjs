// 진단(read-only, 운영): 강등 6명 — 고객 앱 3화면 실측 표시 상태.
//   /cluster-1 (이력서 카드) · /cluster-4 (주차 카드 목록) · /cluster-4-1 (진입/시즌 요약)
//   추출: 졸업/시즌 상태 관련 텍스트 프로브 (DB 변경·저장 없음)
//   node scripts/diag-crash-recovery-browser.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const requireFront = createRequire(resolve(frontRoot, "package.json"));
const { chromium } = requireFront("playwright");

const FRONT = "https://vraxium.vercel.app";
const SIX = [
  ["T윤도현", "bf3b4305-751a-49e3-88ad-95a20e5c4dad", "encre"],
  ["T임다인", "42864260-e4ea-4150-a87f-cff545b02af1", "encre"],
  ["T장유준", "4a81b6d1-e488-4f14-8530-0cad60fe4f0d", "encre"],
  ["T윤태현", "05ff6b96-b3e7-4050-97f1-080633f183d3", "phalanx"],
  ["T임건우", "e4dcb97e-a515-4ec5-a91e-32ca4e629dae", "phalanx"],
  ["T장시현", "cc1b58e6-b14d-45a0-b389-2df3c27a0b25", "phalanx"],
];
// 스크린샷은 대표 2명만 (encre 1·phalanx 1)
const SHOT_UIDS = new Set([SIX[0][1], SIX[5][1]]);

const PROBE_RE = /(정상 졸업|시즌 중 졸업|성장 완료|졸업|시즌 진행 중|시즌 성공|시즌 중단|시즌 휴식|활동 중단|진행 중)/g;

const probeAround = (text, keyword, span = 90) => {
  const out = [];
  let i = -1;
  while ((i = text.indexOf(keyword, i + 1)) >= 0 && out.length < 5) {
    out.push(text.slice(Math.max(0, i - span), i + keyword.length + span).replace(/\n/g, " | "));
  }
  return out;
};

const browser = await chromium.launch({ channel: "chromium", headless: true });
const report = [];
try {
  for (const [name, uid, org] of SIX) {
    const entry = { name, uid, org, pages: {} };
    for (const [route, waitText, label] of [
      ["cluster-1", "이력서", "resume"],
      ["cluster-4", "역대 시즌", "cards"],
      ["cluster-4-1", "시즌", "entry"],
    ]) {
      const page = await browser.newPage({ viewport: { width: 1366, height: 2200 } });
      try {
        await page.goto(`${FRONT}/${route}?userId=${uid}`, { waitUntil: "domcontentloaded" });
        await page
          .waitForFunction(`document.body.innerText.includes(${JSON.stringify(waitText)})`, undefined, {
            timeout: 45000,
          })
          .catch(() => {});
        await page.waitForTimeout(5000); // 데이터 fetch 마감 여유
        const text = await page.evaluate("document.body.innerText");
        const hits = [...new Set((text.match(PROBE_RE) ?? []))];
        entry.pages[label] = {
          route,
          loaded: text.length > 200,
          statusKeywords: hits,
          gradProbe: probeAround(text, "졸업"),
          seasonStatusProbe: probeAround(text, "시즌 진행 중").concat(
            probeAround(text, "시즌 성공").slice(0, 2),
          ),
        };
        if (SHOT_UIDS.has(uid)) {
          const shot = resolve(adminRoot, "claudedocs", `browser-crash-recovery-${label}-${name}.png`);
          await page.screenshot({ path: shot, fullPage: route !== "cluster-4" });
          entry.pages[label].screenshot = shot.split("\\").pop();
        }
        console.log(`[${name}] /${route} keywords=${hits.join(",") || "(없음)"}`);
        for (const p of entry.pages[label].gradProbe.slice(0, 2)) console.log(`    졸업 부근: ${p}`);
      } catch (e) {
        entry.pages[label] = { route, error: String(e).slice(0, 200) };
        console.log(`[${name}] /${route} 실패: ${String(e).slice(0, 120)}`);
      } finally {
        await page.close();
      }
    }
    report.push(entry);
  }
} finally {
  await browser.close();
}
const OUT = resolve(adminRoot, "claudedocs", "diag-crash-recovery-browser-20260606.json");
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\n리포트 저장: claudedocs/diag-crash-recovery-browser-20260606.json`);
