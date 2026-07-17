// 회귀 검증: 라인 org audience 요청 단위 캐시(runWithLineOrgAudienceCache)가
//   collectLineOrgAudience 결과를 바꾸지 않는지(byte-identical) + 실제 supabase 쿼리 절감량을 확인한다.
//
//   READ-ONLY — collectLineOrgAudience 는 순수 read(무효화/쓰기 없음). 실 데이터 무변경.
//   실행: npm run verify:line-audience-cache
//
//   캐시 미적용(단건 호출 경로) vs 캐시 적용(일괄 개설/취소 경로) 두 방식으로 동일 라인 집합의
//   audience 를 산정해, 라인별 audience 가 완전히 같은지 비교한다. 하나라도 다르면 exit 1.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  collectLineOrgAudience,
  runWithLineOrgAudienceCache,
} from "@/lib/adminCluster4LinesData";
import { runWithQueryMeter } from "@/lib/supabaseQueryMeter";

async function main() {
  const { data } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type")
    .in("part_type", ["experience", "competency", "info"])
    .limit(20);
  const lineIds = ((data ?? []) as { id: string }[]).map((r) => r.id);
  if (lineIds.length === 0) {
    console.log("[verify] no lines under test — skip");
    return;
  }

  const before: Record<string, string> = {};
  const q1 = await runWithQueryMeter("[no-cache]", async (m) => {
    for (const id of lineIds) before[id] = (await collectLineOrgAudience(id)).slice().sort().join(",");
    return m.count;
  });

  const after: Record<string, string> = {};
  const q2 = await runWithQueryMeter("[cached]", async (m) =>
    runWithLineOrgAudienceCache(async () => {
      for (const id of lineIds) after[id] = (await collectLineOrgAudience(id)).slice().sort().join(",");
      return m.count;
    }),
  );

  let mismatches = 0;
  for (const id of lineIds) if (before[id] !== after[id]) mismatches++;

  console.log(`[verify] lines=${lineIds.length} queries: no-cache=${q1} cached=${q2} saved=${q1 - q2}`);
  console.log(`[verify] audience byte-identical: ${mismatches === 0 ? "YES" : `NO (${mismatches})`}`);
  if (mismatches > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
