/**
 * summerWeeksPublishGuard 검증 (read-only).
 *   A) 실 DB: 현재 상태(복구 완료)에서 가드 통과
 *   B) stub: 위반 시나리오 4종에서 throw (pub=NULL / 행 부재 / 값 상이 / 쓰기 의도)
 *   C) 쓰기 의도 가드: 기대값 쓰기는 허용, NULL/타값은 차단, 비보호 행은 무시
 * Usage: npx tsx --env-file=.env.local scripts/verify-summer-publish-guard.ts
 */
import { createClient } from "@supabase/supabase-js";
import {
  assertProtectedPublishWrite,
  assertSummerW58PublishGuard,
  expectedPublishedAt,
  SummerPublishGuardError,
} from "../lib/summerWeeksPublishGuard";

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// 가드가 기대하는 select 체인만 흉내내는 stub.
function stubSb(rows: Array<{ week_number: number; start_date: string; result_published_at: string | null }>) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => Promise.resolve({ data: rows, error: null }),
        }),
      }),
    }),
  } as never;
}

const OK_ROWS = [
  { week_number: 5, start_date: "2025-07-28", result_published_at: "2025-08-04T00:00:00+00:00" },
  { week_number: 6, start_date: "2025-08-04", result_published_at: "2025-08-11T00:00:00+00:00" },
  { week_number: 7, start_date: "2025-08-11", result_published_at: "2025-08-18T00:00:00+00:00" },
  { week_number: 8, start_date: "2025-08-18", result_published_at: "2025-08-25T00:00:00+00:00" },
];

async function expectThrow(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    check(label, false, "throw 기대였으나 통과함");
  } catch (e) {
    check(label, e instanceof SummerPublishGuardError, (e as Error).name);
  }
}

async function main() {
  console.log("=== A) 실 DB — 현재 상태에서 가드 통과 ===");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  try {
    await assertSummerW58PublishGuard(sb as never);
    check("실 DB 가드 통과 (W5~8 publish = start+7d)", true);
  } catch (e) {
    check("실 DB 가드 통과 (W5~8 publish = start+7d)", false, (e as Error).message.split("\n")[0]);
  }

  console.log("\n=== B) stub — 위반 시나리오에서 중단 ===");
  await expectThrow("pub=NULL (01:03 회귀 재현) → throw", () =>
    assertSummerW58PublishGuard(stubSb(OK_ROWS.map((r) => ({ ...r, result_published_at: null })))));
  await expectThrow("W8 행 부재 → throw", () =>
    assertSummerW58PublishGuard(stubSb(OK_ROWS.slice(0, 3))));
  await expectThrow("W5 값 상이(start+1d) → throw", () =>
    assertSummerW58PublishGuard(
      stubSb([{ ...OK_ROWS[0], result_published_at: "2025-07-29T00:00:00+00:00" }, ...OK_ROWS.slice(1)]),
    ));
  {
    try {
      await assertSummerW58PublishGuard(stubSb(OK_ROWS));
      check("정상 stub → 통과 (오탐 없음)", true);
    } catch (e) {
      check("정상 stub → 통과 (오탐 없음)", false, (e as Error).message.split("\n")[0]);
    }
  }

  console.log("\n=== C) 쓰기 의도 가드 ===");
  await expectThrow("보호 행 pub→NULL 쓰기 → throw", () =>
    assertProtectedPublishWrite({ start: "2025-07-28", col: "result_published_at", value: null }));
  await expectThrow("보호 행 pub→타값 쓰기 → throw", () =>
    assertProtectedPublishWrite({ start: "2025-08-18", col: "result_published_at", value: "2030-01-01T00:00:00+00:00" }));
  try {
    assertProtectedPublishWrite({ start: "2025-07-28", col: "result_published_at", value: expectedPublishedAt("2025-07-28") });
    check("보호 행 기대값 쓰기(복원/롤백) → 허용", true);
  } catch {
    check("보호 행 기대값 쓰기(복원/롤백) → 허용", false);
  }
  try {
    assertProtectedPublishWrite({ start: "2025-07-28", col: "check_threshold", value: 99 });
    assertProtectedPublishWrite({ start: "2026-03-02", col: "result_published_at", value: null });
    check("비보호 컬럼/비보호 주차 쓰기 → 무시(통과)", true);
  } catch {
    check("비보호 컬럼/비보호 주차 쓰기 → 무시(통과)", false);
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
void main();
