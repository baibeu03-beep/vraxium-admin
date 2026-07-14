// 고객 앱 주차 카드 목록(cluster-4-1-px) 실무 역량 요약 (N/M) 검증.
//   대상: T이하준(phalanx) — 봄 W10 등에 비대상 synthetic fail 존재. 수정 후 competency 분모>=1 기대.
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const frontRoot = resolve(__dirname, "..", "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");

const UID = "7e15f412-65be-481c-8525-460b161244ca";
const FRONT = "http://localhost:3001";
const url = `${FRONT}/cluster-4-1-px?admin=true&demoUserId=${UID}&org=phalanx`;

const b = await chromium.launch({ channel: "chromium", headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 3000 } });
const p = await ctx.newPage();
try {
  console.log("로드:", url);
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await p.waitForFunction(() => /실무\s*역량/.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
  await p.waitForFunction(() => !/데이터를 열심히 불러오고/.test(document.body.innerText), undefined, { timeout: 40000 }).catch(() => {});
  await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(4000);

  // 데모 템플릿 SHOPPING BAG 오버레이 DOM 제거(우측 총/중 값 가림 해제).
  await p.evaluate(() => {
    for (const e of [...document.querySelectorAll("*")]) {
      const t = (e.textContent || "");
      const style = getComputedStyle(e);
      if ((style.position === "fixed" || style.position === "absolute") &&
          /SHOPPING BAG|CHECKOUT|Add Products/.test(t) && t.length < 400) {
        e.remove();
      }
    }
  });
  await p.waitForTimeout(500);
  // 봄 시즌으로 이동 — 사이드바 "봄시즌"/"봄 시즌" 행 클릭.
  const clicked = await p.evaluate(() => {
    const cand = [...document.querySelectorAll("*")].filter((e) => /봄\s*시즌/.test(e.textContent || "") && e.children.length <= 4);
    const el = cand[cand.length - 1];
    if (el) { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }
    return false;
  });
  console.log("봄 시즌 클릭:", clicked);
  await p.waitForTimeout(4000);
  await p.evaluate(() => { for (const e of [...document.querySelectorAll("*")]) { const t = e.textContent || ""; const s = getComputedStyle(e); if ((s.position === "fixed" || s.position === "absolute") && /SHOPPING BAG|CHECKOUT/.test(t) && t.length < 400) e.remove(); } });
  await p.waitForTimeout(500);

  // 각 주차 행에서 4허브 (N/M) 추출 — "실무 역량 ... (K/N)" 또는 "역량 (K/N)" 패턴
  const rows = await p.evaluate(() => {
    const text = document.body.innerText.replace(/\r/g, "");
    // "실무 역량" 뒤 괄호 (K/N) 또는 "K / N" 패턴을 모두 수집
    const out = [];
    // "실무 역량 강화율 N% ... 총 M 개 중 K 개" 또는 "실무 역량 ... (K/M)"
    const re1 = /실무 (정보|경험|역량|경력)[\s\S]{0,80}?총\s*(\d+)\s*개\s*중\s*(\d+)\s*개/g;
    let m;
    while ((m = re1.exec(text)) !== null) out.push({ hub: m[1], total: +m[2], done: +m[3] });
    if (out.length === 0) {
      const re2 = /(정보|경험|역량|경력)[^()\n]{0,20}?\(?\s*(\d+)\s*\/\s*(\d+)\s*\)?/g;
      while ((m = re2.exec(text)) !== null) out.push({ hub: m[1], done: +m[2], total: +m[3] });
    }
    return out;
  });
  const comp = rows.filter((r) => r.hub === "역량");
  console.log("\n=== 실무 역량 (완료/총) 값들 ===");
  console.log(JSON.stringify(comp));
  const anyNonZeroTotal = comp.some((r) => r.total >= 1);
  const anyZeroZeroButFailExists = comp.some((r) => r.total === 0); // 정보 부족 — 참고만
  console.log("\n=== 배지 존재 ===", JSON.stringify(await p.evaluate(() => ({ fail: /강화\s*실패/.test(document.body.innerText) }))));
  await p.screenshot({ path: resolve(__dirname, "..", "claudedocs", "qa-competency-weeklist-summary.png"), fullPage: true });
  console.log("\n=== 판정 ===");
  console.log(`  역량 분모>=1 인 주차 존재 = ${anyNonZeroTotal} (수정 후 synthetic fail 주차는 총>=1 이어야)`);
  console.log(`  => ${anyNonZeroTotal ? "PASS 후보 ✅ (역량 총>=1 확인)" : "확인 필요 (전부 0)"}`);
} catch (e) {
  console.error("ERROR:", e?.stack ?? e?.message ?? e);
} finally {
  await b.close();
}
