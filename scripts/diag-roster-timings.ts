// 진단: roster 단계별 소요(견고한 측정 — fs.writeFileSync 로 라인별 즉시 기록, stdout flush race 회피).
//   npx tsx --env-file=.env.local scripts/diag-roster-timings.ts
import { appendFileSync, writeFileSync } from "node:fs";
import { listAdminCrewDtos } from "@/lib/adminCrewData";
import { getGrowthRosterBatchFast } from "@/lib/cluster3GrowthData";
import { getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
import { getScheduleReliabilityRateBatch } from "@/lib/cluster1ResumeData";
import { sumPointsForUsers } from "@/lib/adminMembersData";

const OUT = "C:/Users/vanua/AppData/Local/Temp/roster-timings.txt";
const log = (m: string) => {
  appendFileSync(OUT, m + "\n");
  process.stderr.write(m + "\n");
};

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const s = Date.now();
  const r = await fn();
  log(`${label}: ${Date.now() - s}ms`);
  return r;
};

async function main() {
  writeFileSync(OUT, `roster timings ${new Date().toISOString()}\n`);
  const crews = await timed("1) listAdminCrewDtos(ALL)", () => listAdminCrewDtos(undefined, "operating"));
  const userIds = crews.map((c) => c.userId);
  log(`   users=${userIds.length}`);

  const ID_CHUNK = 200;
  // 4개 배치를 개별 직렬 측정(병렬 아님 — 각 비용 분리).
  await timed("2) getGrowthRosterBatchFast(slim 우선)", async () => {
    for (let i = 0; i < userIds.length; i += ID_CHUNK) {
      await getGrowthRosterBatchFast(userIds.slice(i, i + ID_CHUNK));
    }
  });
  await timed("3) getClubRankGradeBatch(품계 전체 points 스캔)", () => getClubRankGradeBatch(userIds));
  await timed("4) sumPointsForUsers(Po.A/B/C)", () => sumPointsForUsers(userIds));
  await timed("5) getScheduleReliabilityRateBatch(일정신뢰도)", () => getScheduleReliabilityRateBatch(userIds));
  log("DONE");
}

main().then(
  () => process.exit(0),
  (e) => {
    log("ERROR: " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  },
);
