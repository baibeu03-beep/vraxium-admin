// weekly-cards 본인 identity 캐시 byte-identical 회귀 검증 (같은 프로세스 A/B).
//   READ-ONLY — 순수 계산(쓰기 없음).
//   실행: npm run verify:weekly-cards-parity   (선택: PARITY_LIMIT=30)
//
// 방식(drift-immune): 유저마다 캐시 ON(운영 경로) vs OFF(__disableSelfIdentityCache) 를
//   같은 프로세스에서 back-to-back 계산해 deep-compare 한다. 동일 DB·동일 시각이므로 시간/데이터
//   변동이 끼어들 여지가 없어, 오직 "캐시 도입으로 인한 차이"만 검출한다.
//
// 비교 대상(캐시가 실제로 영향 주는 전부):
//   · cards 전체(= snapshot 저장 payload 소스)          — getCluster4WeeklyCardsForProfileUser
//   · growthSummary · seasonActivityStatuses           — getWeeklyGrowth (스코프 on/off)
// 제외: seasonGrowthRates.totalAvailable 는 기존 코드 자체가 시간 의존(제출창 open 수)이라 캐시와
//   무관하게 실행 시각별로 달라진다(별도 선행 이슈) → 이 회귀 검증 대상에서 제외.
//
// 하나라도 불일치하면 exit 1(+ 어떤 유저/필드인지 출력).
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import { runWithSelfIdentityCache } from "@/lib/weeklyCardsIdentityCache";

const S = (v: unknown) => JSON.stringify(v);

async function main() {
  let ids = Array.from(await fetchTestUserMarkerIds()).sort();
  const limit = process.env.PARITY_LIMIT ? Number(process.env.PARITY_LIMIT) : 0;
  if (limit > 0) ids = ids.slice(0, limit);
  console.log(`[parity] same-process A/B over ${ids.length} test users`);

  let cards = 0, growthSummary = 0, seasonActivityStatuses = 0, i = 0;
  for (const uid of ids) {
    const cOn = await getCluster4WeeklyCardsForProfileUser(uid).catch((e) => ({ __e: (e as Error).message }));
    const cOff = await getCluster4WeeklyCardsForProfileUser(uid, { __disableSelfIdentityCache: true }).catch((e) => ({ __e: (e as Error).message }));
    if (S(cOn) !== S(cOff)) { cards++; console.log(`  DIFF cards user=${uid.slice(0, 8)}`); }

    const gOn = (await runWithSelfIdentityCache(uid, () => getWeeklyGrowth(uid)).catch(() => null)) as Record<string, unknown> | null;
    const gOff = (await getWeeklyGrowth(uid).catch(() => null)) as Record<string, unknown> | null;
    if (S(gOn?.growthSummary) !== S(gOff?.growthSummary)) { growthSummary++; console.log(`  DIFF growthSummary user=${uid.slice(0, 8)}`); }
    if (S(gOn?.seasonActivityStatuses) !== S(gOff?.seasonActivityStatuses)) { seasonActivityStatuses++; console.log(`  DIFF seasonActivityStatuses user=${uid.slice(0, 8)}`); }

    if (++i % 20 === 0) console.log(`  ${i}/${ids.length}`);
  }

  const total = cards + growthSummary + seasonActivityStatuses;
  console.log(`\n[parity] cards=${cards} growthSummary=${growthSummary} seasonActivityStatuses=${seasonActivityStatuses} (all 0 = byte-identical)`);
  if (total > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
