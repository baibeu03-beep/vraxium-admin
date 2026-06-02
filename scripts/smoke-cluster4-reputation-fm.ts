/**
 * 받은 평판 cap/FM 산출 단위 스모크 (DB 불필요, 순수 함수).
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-reputation-fm.ts
 *
 * summarizeReceivedReputations 의 방어적 cap(최대 4건) + FM(반영 rating 합)을 검증한다.
 * 검증 기준(요구):
 *   1. 받은 평판 1개 rating=9 → receivedCount=1, fm=9
 *   2. 받은 평판 4개 합계 36 → receivedCount=4, fm=36
 *   3. DB 에 5개 이상 있어도 반영 최대 4개 (5번째 이후 fm 미반영)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import {
  summarizeReceivedReputations,
  REPUTATION_RECEIVED_LIMIT,
} from "@/lib/cluster4WeeklyPeopleData";

let failed = false;
function assert(label: string, cond: boolean) {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failed = true;
    process.exitCode = 1;
  }
}

function main() {
  console.log("받은 평판 cap/FM 스모크\n");

  assert("limit 상수 = 4", REPUTATION_RECEIVED_LIMIT === 4);

  // 1) 1개 rating=9 → count=1, fm=9
  {
    const s = summarizeReceivedReputations([9]);
    assert("1개 rating=9 → receivedCount=1", s.reflectedCount === 1);
    assert("1개 rating=9 → fm=9", s.fm === 9);
  }

  // 2) 4개 합계 36 → count=4, fm=36
  {
    const s = summarizeReceivedReputations([9, 9, 9, 9]);
    assert("4개 → receivedCount=4", s.reflectedCount === 4);
    assert("4개 합계 36 → fm=36", s.fm === 36);
  }

  // 3) 5개 이상 → 반영 최대 4개 (created_at 선착 4건만)
  {
    const s = summarizeReceivedReputations([10, 8, 6, 4, 9, 7]); // 6건
    assert("6건 → receivedCount=4 (cap)", s.reflectedCount === 4);
    assert("6건 → fm=28 (선착 4건 10+8+6+4)", s.fm === 28);
  }

  // 4) 0개 → count=0, fm=0
  {
    const s = summarizeReceivedReputations([]);
    assert("0개 → receivedCount=0", s.reflectedCount === 0);
    assert("0개 → fm=0", s.fm === 0);
  }

  // 5) 반정수(0.5 step) rating 합 보존
  {
    const s = summarizeReceivedReputations([9.5, 0.5]);
    assert("반정수 합 보존 → fm=10", s.fm === 10);
  }

  console.log(`\n${failed ? "❌ 일부 실패" : "✅ 전체 통과"}`);
}

main();
