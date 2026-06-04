/**
 * v11 적용 시점 분리 — 주차 verdict sync 실행기 (2026-06-04).
 *
 *   npx tsx --env-file=.env.local scripts/run-experience-sync-effective-from.ts            # 전수 dry-run
 *   npx tsx --env-file=.env.local scripts/run-experience-sync-effective-from.ts --write-test  # 테스트 사용자만 실반영
 *
 * 정책:
 *   - 실사용자: CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM(2026-06-08) 이전 주차는 update 금지
 *     (protectedWeekKeys 로만 집계). 이후 주차만 신정책 verdict 로 write 가능.
 *   - 테스트 사용자(display_name ILIKE '%T%'): 시점 제한 없음 — 과거 주차도 write 허용.
 */
import {
  syncAllExperienceGrowthWeekStatuses,
  syncTestExperienceGrowthWeekStatuses,
} from "@/lib/cluster4WeeklyGrowthData";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const writeTest = process.argv.includes("--write-test");

function printResults(label: string, r: {
  scope: string;
  dryRun: boolean;
  usersScanned: number;
  usersFlipped: number;
  totalFlippedToFail: number;
  totalProtected: number;
  results: {
    userId: string;
    isTestUser: boolean;
    scannedSuccessWeeks: number;
    flippedToFail: number;
    flippedWeekKeys: string[];
    protectedWeekKeys: string[];
  }[];
}) {
  console.log(`\n══════ ${label} ══════`);
  console.log(
    `scope=${r.scope} dryRun=${r.dryRun} | 대상 ${r.usersScanned}명 | flip(예정/실행) ${r.usersFlipped}명 / ${r.totalFlippedToFail}주차 | 과거 보호(update 차단) ${r.totalProtected}주차`,
  );
  for (const u of r.results) {
    console.log(
      `  ${u.userId.slice(0, 8)} test=${u.isTestUser} success주차=${u.scannedSuccessWeeks}` +
        ` flip=${u.flippedToFail}[${u.flippedWeekKeys.join(",")}]` +
        ` protected=${u.protectedWeekKeys.length}[${u.protectedWeekKeys.join(",")}]`,
    );
  }
}

async function main() {
  console.log(`EFFECTIVE_FROM=${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}`);

  // 1) 전수 dry-run (실사용자 포함 — write 없음). flip 예정 + 과거 보호(protected) 관찰.
  //    실사용자: effectiveFrom 이전 fail 후보는 protectedWeekKeys 로만 나타나야 정상(flip 0).
  const dry = await syncAllExperienceGrowthWeekStatuses({ dryRun: true });
  printResults("1) 전수 dry-run (write 없음)", dry);

  // 2) 테스트 사용자 실반영 (--write-test 일 때만).
  if (writeTest) {
    const wr = await syncTestExperienceGrowthWeekStatuses({ dryRun: false });
    printResults("2) 테스트 사용자 실반영(write)", wr);
  } else {
    console.log("\n(--write-test 미지정 — 테스트 사용자 실반영 생략)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
