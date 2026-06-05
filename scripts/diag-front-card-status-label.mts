/**
 * front 카드 주차 상태 라벨 정밀 확인 — "성장(성공)"/"성장(실패)" 등 정확 문자열 추출.
 *   npx tsx --env-file=.env.local scripts/diag-front-card-status-label.mts
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const requireFromFront = createRequire(
  new URL("../../vraxium/package.json", import.meta.url),
);
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const seedLog = JSON.parse(
    readFileSync("claudedocs/legacy-check-case-seed-20260605.json", "utf-8"),
  );
  const { data: pubWeeks } = await sb
    .from("weeks")
    .select("id,start_date")
    .not("result_published_at", "is", null);
  const weekIdByStart = new Map(
    ((pubWeeks ?? []) as any[]).map((w) => [w.start_date, w.id]),
  );
  const sampleA = seedLog.plans.find(
    (p: any) => p.case === "A" && weekIdByStart.has(p.weekStart),
  );
  const sampleB = seedLog.plans.find(
    (p: any) => p.case === "B" && weekIdByStart.has(p.weekStart),
  );

  const browser = await chromium.launch({ channel: "chromium" });
  for (const [label, p] of [
    ["A", sampleA],
    ["B", sampleB],
  ] as const) {
    const weekId = weekIdByStart.get(p.weekStart);
    const page = await browser.newPage({ viewport: { width: 1440, height: 2600 } });
    await page.goto(
      `http://localhost:3001/cluster-4-card/${weekId}?demoUserId=${p.userId}`,
      { waitUntil: "domcontentloaded", timeout: 90_000 },
    );
    await page.waitForTimeout(12_000);
    const text = await page.evaluate(() => document.body.innerText);
    const statusMatches = text.match(/성장\s*\((성공|실패|진행 중|집계 중)\)/g) ?? [];
    const altMatches = text.match(/주차\s*(성공|실패)/g) ?? [];
    console.log(
      `[${label}] ${p.userId.slice(0, 8)} ${p.weekStart} | 성장(...) 라벨: ${JSON.stringify(statusMatches)} | 주차 라벨: ${JSON.stringify(altMatches)}`,
    );
    await page.close();
  }
  await browser.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
