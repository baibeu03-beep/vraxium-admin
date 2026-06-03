/**
 * cluster-4 주차 카드 "주차별 방패" 브라우저 DOM 검증.
 *   주차별 칸의 방패 표시값이 per-week points.shield 인지(누적 cumulativeInjeolmi 가 아닌지) 확인.
 *
 *   USER_ID=<uuid> CUSTOMER_URL=http://localhost:3001 \
 *     npx tsx --env-file=.env.local scripts/verify-cluster4-card-shield-browser.ts
 *   (Git Bash 면 앞에 MSYS_NO_PATHCONV=1 권장)
 *
 * 기대: 각 주차 카드 방패 = 해당 주차 points.shield(0~10), 200+ 누적값 미표시.
 * 카드 목록 DOM(.info-group.items 의 투구/방패/화살 = star/shield/lightning, phalanx 라벨).
 * star/lightning 쌍으로 DTO 카드를 매칭해 방패가 points.shield 인지 대조.
 * READ-ONLY. 스크린샷은 claudedocs/.
 */
import { chromium } from "@playwright/test";

function resolveUserId(): string {
  const id = (process.env.USER_ID ?? "").trim() || (process.argv[2] ?? "").trim();
  if (!id) throw new Error("USER_ID 미지정.");
  return id;
}

type Card = {
  weekId: string | null;
  weekNumber: number;
  points?: { star: number | null; shield: number | null; lightning: number | null };
  cumulativeInjeolmi: number | null;
};

// 브라우저에서 실행할 추출 스크립트(문자열 — tsx __name 주입 회피).
// 카드별 투구(star)/방패(shield)/화살(lightning) 숫자를 .info-group.items 에서 읽는다.
const EXTRACT = `(() => {
  const num = (el) => {
    if (!el) return null;
    const t = (el.textContent || '').replace(/[^0-9.-]/g, '');
    return t === '' ? null : Number(t);
  };
  const groups = Array.from(document.querySelectorAll('.info-group.items'));
  return groups.map((g) => {
    const items = Array.from(g.querySelectorAll('.info-item'));
    let star = null, shield = null, lightning = null;
    for (const it of items) {
      const label = (it.textContent || '');
      const v = num(it.querySelector('.number-value'));
      if (label.indexOf('투구') >= 0 || label.indexOf('별') >= 0 || label.indexOf('단감') >= 0) star = v;
      else if (label.indexOf('방패') >= 0 || label.indexOf('인절미') >= 0) shield = v;
      else if (label.indexOf('화살') >= 0 || label.indexOf('번개') >= 0 || label.indexOf('어흥') >= 0) lightning = v;
    }
    return { star, shield, lightning };
  });
})()`;

async function main() {
  const userId = resolveUserId();
  const customer = (process.env.CUSTOMER_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const route = "/cluster-4-px"; // phalanx 카드 목록(Cluster41Content)
  const url = `${customer}${route}?demoUserId=${encodeURIComponent(userId)}&admin=true`;
  const outDir = "claudedocs";

  const browser = await chromium.launch();
  try {
    const page = await browser.newContext().then((c) => c.newPage());
    console.log(`[goto] ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForSelector(".info-group.items .info-item", { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2500);

    const dom = (await page.evaluate(EXTRACT)) as { star: number | null; shield: number | null; lightning: number | null }[];

    // DTO 직접 취득(동일 demo).
    const dtoRes = await page.request.get(
      `${customer}/api/cluster4/weekly-cards?demoUserId=${encodeURIComponent(userId)}`,
    );
    const dtoJson = (await dtoRes.json()) as { success: boolean; data: Card[] };
    const cards = Array.isArray(dtoJson.data) ? dtoJson.data : [];

    await page.screenshot({ path: `${outDir}/cluster4-card-shield-perweek.png`, fullPage: true });

    const pointsShieldSet = new Set(
      cards.map((c) => c.points?.shield).filter((v): v is number => typeof v === "number"),
    );
    const cumulativeSet = new Set(
      cards.map((c) => c.cumulativeInjeolmi).filter((v): v is number => typeof v === "number"),
    );

    // star/lightning 쌍으로 DTO 카드 매칭 → 그 주차의 points.shield 와 cumulativeInjeolmi 대조.
    const rows: Record<string, unknown>[] = [];
    let anyOver100 = false;
    let shieldEqPoints = 0;
    let shieldEqCumulative = 0;
    let checkable = 0;

    for (let i = 0; i < dom.length; i++) {
      const d = dom[i];
      const matches = cards.filter(
        (c) => (c.points?.star ?? null) === d.star && (c.points?.lightning ?? null) === d.lightning,
      );
      const matched = matches.length === 1 ? matches[0] : null;
      const pShield = matched?.points?.shield ?? null;
      const cum = matched?.cumulativeInjeolmi ?? null;
      const over100 = typeof d.shield === "number" && d.shield >= 100;
      if (over100) anyOver100 = true;

      let verdict = "?";
      if (matched && typeof d.shield === "number") {
        checkable++;
        if (d.shield === pShield) {
          shieldEqPoints++;
          verdict = "✅ points.shield";
        } else if (d.shield === cum) {
          shieldEqCumulative++;
          verdict = "❌ cumulativeInjeolmi";
        } else {
          verdict = "⚠ neither";
        }
      } else if (typeof d.shield === "number" && pointsShieldSet.has(d.shield) && !cumulativeSet.has(d.shield)) {
        verdict = "✅ ∈points.shield";
      }

      rows.push({
        "DOM 투구": d.star,
        "DOM 방패": d.shield,
        "DOM 화살": d.lightning,
        week: matched?.weekNumber ?? "(매칭모호)",
        "DTO points.shield": pShield,
        "DTO cumInjeolmi": cum,
        verdict,
        "≥100": over100 ? "⚠️" : "",
      });
    }

    console.log(`\n════════ 주차별 방패 DOM ↔ DTO 검증 (userId=${userId}) ════════`);
    console.log(`route=${route} | DOM 카드=${dom.length} | DTO 카드=${cards.length}`);
    console.table(rows);

    const renderedShields = dom.map((d) => d.shield).filter((v): v is number => typeof v === "number");
    const maxShield = renderedShields.length ? Math.max(...renderedShields) : 0;

    console.log("\n──────── 요약 ────────");
    console.table([
      {
        "DOM 카드": dom.length,
        "방패=points.shield": shieldEqPoints,
        "방패=cumulativeInjeolmi(실패)": shieldEqCumulative,
        "max DOM 방패": maxShield,
        "200+ 누적 반복?": anyOver100 ? "❌ 있음" : "✅ 없음",
        "DTO points.shield 범위": `${Math.min(...pointsShieldSet)}~${Math.max(...pointsShieldSet)}`,
        "DTO cumInjeolmi 범위": `${Math.min(...cumulativeSet)}~${Math.max(...cumulativeSet)}`,
      },
    ]);

    const pass =
      dom.length > 0 &&
      !anyOver100 &&
      shieldEqCumulative === 0 &&
      maxShield < 100;
    console.log(
      pass
        ? "\n✅ 통과: 주차별 방패 = per-week points.shield (누적/200+ 미표시)."
        : "\n❌ 실패: 위 표의 ❌/⚠️ 확인.",
    );
    console.log(`스크린샷: ${outDir}/cluster4-card-shield-perweek.png`);

    process.exitCode = pass ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
