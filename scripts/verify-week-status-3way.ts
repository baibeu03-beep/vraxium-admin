/**
 * 3-way 검증: DIRECT(재계산) vs SNAPSHOT(저장) vs HTTP(/api/cluster4/weekly-cards).
 *   npx tsx --env-file=.env.local scripts/verify-week-status-3way.ts <testUserId> [port]
 *
 * - DIRECT  : getCluster4WeeklyCardsForProfileUser (실시간)
 * - SNAPSHOT: readWeeklyCardsSnapshot (DB 저장값)
 * - HTTP    : demoUserId 모드로 실제 라우트 응답 (운영 고객 경로와 동일 DTO)
 * 셋의 주차별 userWeekStatus/statusLabel/statusTone 이 모두 같아야 한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

function fmt(c: Cluster4WeeklyCardDto): string {
  return `${c.userWeekStatus}/${c.statusLabel}/${c.statusTone}`;
}
function keyOf(c: Cluster4WeeklyCardDto): string {
  return `${c.seasonKey ?? "?"}#${c.weekNumber}`;
}

async function main() {
  const uid = process.argv[2];
  const port = process.argv[3] ?? "3000";
  if (!uid) throw new Error("usage: verify-week-status-3way.ts <testUserId> [port]");

  const direct = await getCluster4WeeklyCardsForProfileUser(uid);
  const snap = await readWeeklyCardsSnapshot(uid);
  const snapCards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];

  const res = await fetch(
    `http://localhost:${port}/api/cluster4/weekly-cards?demoUserId=${uid}`,
  );
  const body = (await res.json()) as { success: boolean; data: Cluster4WeeklyCardDto[] };
  const http = Array.isArray(body.data) ? body.data : [];

  console.log(
    `user=${uid}\n` +
      `snap.status=${snap.status}${
        snap.status === "hit" || snap.status === "stale" ? ` computed=${snap.computedAt}` : ""
      }\n` +
      `counts: direct=${direct.length} snapshot=${snapCards.length} http=${http.length}\n`,
  );

  const dMap = new Map(direct.map((c) => [keyOf(c), c]));
  const sMap = new Map(snapCards.map((c) => [keyOf(c), c]));
  const hMap = new Map(http.map((c) => [keyOf(c), c]));
  const keys = Array.from(new Set([...dMap.keys(), ...sMap.keys(), ...hMap.keys()])).sort();

  let diffs = 0;
  for (const k of keys) {
    const d = dMap.get(k);
    const s = sMap.get(k);
    const h = hMap.get(k);
    const ds = d ? fmt(d) : "<absent>";
    const ss = s ? fmt(s) : "<absent>";
    const hs = h ? fmt(h) : "<absent>";
    const same = ds === ss && ss === hs;
    if (!same) diffs++;
    console.log(
      `${same ? "  ✓" : "  ⚠"} ${k.padEnd(16)} DIRECT=${ds.padEnd(28)} SNAP=${ss.padEnd(28)} HTTP=${hs}`,
    );
  }
  console.log(`\nmismatched weeks: ${diffs} / ${keys.length}`);
  console.log(
    diffs === 0
      ? "RESULT: DIRECT == SNAPSHOT == HTTP (현재 시점 일관)"
      : "RESULT: 불일치 — stale snapshot 재계산 필요",
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
