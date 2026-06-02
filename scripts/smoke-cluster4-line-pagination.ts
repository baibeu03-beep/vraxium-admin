/**
 * collectAllRows 페이지네이션 단위 스모크 (DB 불필요, fake fetcher).
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-line-pagination.ts
 *
 * fetchLineDetailsByWeek 의 1000행 cap 회피 루프를 가상 데이터로 검증한다:
 *   - 1000행을 초과하는 데이터에서 전수 수집(누락 0)
 *   - 페이지 경계(.range from/to) 정확성 + 빈 페이지 종료
 *   - 에러 전파
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { collectAllRows } from "@/lib/cluster4WeeklyCardsData";

let failed = false;
function assert(label: string, cond: boolean) {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failed = true;
    process.exitCode = 1;
  }
}

// total 개의 행을 .range 경계대로 잘라 돌려주는 fake fetcher. 요청 범위를 ranges 에 기록.
function makeFetcher(total: number, ranges: Array<[number, number]>) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  return async (from: number, to: number) => {
    ranges.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null as { message: string } | null };
  };
}

async function main() {
  console.log("collectAllRows 페이지네이션 스모크\n");

  // 1) 2500행 (pageSize 1000) → 3페이지(1000/1000/500), 전수 2500.
  {
    const ranges: Array<[number, number]> = [];
    const out = await collectAllRows(makeFetcher(2500, ranges), 1000);
    assert("2500행 > 1000cap 전수 수집(누락 0)", out.length === 2500);
    assert("2500행: 3페이지 요청", ranges.length === 3);
    assert(
      "2500행: 페이지 경계 0/1000/2000",
      ranges[0][0] === 0 && ranges[1][0] === 1000 && ranges[2][0] === 2000,
    );
    assert("2500행: 순서/유실 없음", out.every((r, i) => (r as { id: number }).id === i));
  }

  // 2) 정확히 1000행 → 첫 페이지 1000(==pageSize) → 빈 둘째 페이지 후 종료. 전수 1000.
  {
    const ranges: Array<[number, number]> = [];
    const out = await collectAllRows(makeFetcher(1000, ranges), 1000);
    assert("정확히 1000행(경계) 전수", out.length === 1000);
    assert("1000행: 빈 페이지로 종료(2요청)", ranges.length === 2);
  }

  // 3) 0행 → 1요청, 빈 결과.
  {
    const ranges: Array<[number, number]> = [];
    const out = await collectAllRows(makeFetcher(0, ranges), 1000);
    assert("0행 안전(1요청)", out.length === 0 && ranges.length === 1);
  }

  // 4) 1500행, pageSize 500 → 4페이지(500/500/500/0). 전수 1500.
  {
    const ranges: Array<[number, number]> = [];
    const out = await collectAllRows(makeFetcher(1500, ranges), 500);
    assert("pageSize 500 / 1500행 전수", out.length === 1500);
    assert("pageSize 500: 4요청(빈 페이지 종료)", ranges.length === 4);
  }

  // 5) 에러 전파.
  {
    let threw = false;
    try {
      await collectAllRows(async () => ({ data: null, error: { message: "boom" } }), 1000);
    } catch (e) {
      threw = e instanceof Error && /boom/.test(e.message);
    }
    assert("error 전파", threw);
  }

  console.log(`\n════ 페이지네이션 스모크 ${failed ? "실패 ❌" : "완료 ✅"} ════`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
