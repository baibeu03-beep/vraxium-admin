// 임시 검증(읽기 전용) — 실무 역량 라인 개설 상태 direct 함수가 3개 org 에서 정상 동작하는지.
// 변이(open/cancel) 없음 — getCompetencyOpeningStatus 만 호출.
import { getCompetencyOpeningStatus } from "@/lib/adminCompetencyLineOpening";
import { ORGANIZATIONS } from "@/lib/organizations";

async function main() {
  for (const org of ORGANIZATIONS) {
    try {
      const s = await getCompetencyOpeningStatus(org);
      console.log(
        `[${org}] opened=${s.opened} | current=${s.currentWeek ? `${s.currentWeek.year} ${s.currentWeek.seasonName} W${s.currentWeek.weekNumber}` : "null"} | target=${s.targetWeek ? `${s.targetWeek.year} ${s.targetWeek.seasonName} W${s.targetWeek.weekNumber}` : "null"}`,
      );
    } catch (e) {
      console.error(`[${org}] ERROR`, e instanceof Error ? e.message : e);
    }
  }
  // org=null (비조직 진입) — opened 항상 false.
  const none = await getCompetencyOpeningStatus(null);
  console.log(`[null] opened=${none.opened} (expected false)`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
