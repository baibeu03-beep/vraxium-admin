/**
 * cluster3 Growth Indicators 포인트 SoT 전환 검증.
 *   getGrowthIndicators(단건) / getGrowthIndicatorsBatch(배치) 의 point 값이
 *   user_weekly_points 전체기간 직접합산과 일치하는지 + 단건==배치 확인.
 *   참고용으로 user_cumulative_points 캐시값(수정 전 상당)도 나란히 비교.
 *
 *   npx tsx --env-file=.env.local scripts/verify-cluster3-growth-points-sot.ts [N]
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listTestUsers } from "@/lib/testUsers";
import {
  getGrowthIndicators,
  getGrowthIndicatorsBatch,
} from "@/lib/cluster3GrowthData";

async function directSum(userId: string) {
  let from = 0;
  const page = 1000;
  let star = 0,
    adv = 0,
    pen = 0,
    weeks = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("points,advantages,penalty")
      .eq("user_id", userId)
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Array<{
      points: number | null;
      advantages: number | null;
      penalty: number | null;
    }>;
    for (const r of batch) {
      star += r.points ?? 0;
      adv += r.advantages ?? 0;
      pen += r.penalty ?? 0;
    }
    weeks += batch.length;
    if (batch.length < page) break;
    from += page;
  }
  return {
    weeks,
    star, // Σpoints (별)
    rawAdv: adv, // Σadvantages (방패 raw)
    pen: Math.abs(pen), // |Σpenalty| (번개)
    net: adv - Math.abs(pen), // 방패 net
  };
}

// 수정 전 상당 — user_cumulative_points 캐시값.
async function cacheVal(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_cumulative_points")
    .select("total_checks,total_advantages,total_penalties,total_raw_advantages")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  const d = data as {
    total_checks: number | null;
    total_advantages: number | null;
    total_penalties: number | null;
    total_raw_advantages: number | null;
  };
  return {
    star: d.total_checks ?? 0,
    rawAdv: d.total_raw_advantages ?? 0,
    pen: Math.abs(d.total_penalties ?? 0),
    net: d.total_advantages ?? 0,
  };
}

async function main() {
  const limitArg = Number(process.argv[2]);
  const users = await listTestUsers();
  const target = Number.isFinite(limitArg) && limitArg > 0 ? users.slice(0, limitArg) : users;

  // 배치 API 1회 호출.
  const batchDtos = await getGrowthIndicatorsBatch(target.map((u) => u.userId));
  const batchByUser = new Map(batchDtos.map((d) => [d.userId, d]));

  let checked = 0,
    apiMatch = 0,
    apiMismatch = 0,
    batchEqSingle = 0,
    batchNe = 0,
    cacheDiff = 0;
  const apiFails: string[] = [];
  const batchFails: string[] = [];
  const cacheDiffs: string[] = [];

  for (const u of target) {
    const direct = await directSum(u.userId);
    if (direct.weeks === 0) continue;
    checked++;

    const single = await getGrowthIndicators(u.userId);
    const p = single.point;
    // API(단건) vs 직접합산.
    const okApi =
      p.points === direct.star &&
      p.rawAdvantages === direct.rawAdv &&
      p.penalty === direct.pen &&
      p.netAdvantages === direct.net;
    if (okApi) apiMatch++;
    else {
      apiMismatch++;
      apiFails.push(
        `${u.name}: API(별=${p.points} raw=${p.rawAdvantages} 번개=${p.penalty} net=${p.netAdvantages}) ≠ direct(별=${direct.star} raw=${direct.rawAdv} 번개=${direct.pen} net=${direct.net})`,
      );
    }

    // 배치 vs 단건.
    const b = batchByUser.get(u.userId)?.point;
    const okBatch =
      b != null &&
      b.points === p.points &&
      b.rawAdvantages === p.rawAdvantages &&
      b.penalty === p.penalty &&
      b.netAdvantages === p.netAdvantages;
    if (okBatch) batchEqSingle++;
    else {
      batchNe++;
      batchFails.push(`${u.name}: batch≠single`);
    }

    // 수정 전(캐시) vs 수정 후(직접합산) 차이 추적.
    const cache = await cacheVal(u.userId);
    if (
      cache &&
      (cache.star !== direct.star ||
        cache.rawAdv !== direct.rawAdv ||
        cache.pen !== direct.pen ||
        cache.net !== direct.net)
    ) {
      cacheDiff++;
      cacheDiffs.push(
        `${u.name}: cache(별=${cache.star} raw=${cache.rawAdv} 번개=${cache.pen} net=${cache.net}) vs direct(별=${direct.star} raw=${direct.rawAdv} 번개=${direct.pen} net=${direct.net})`,
      );
    }
  }

  console.log("\n──────── cluster3 Growth 포인트 SoT 검증 ────────");
  console.log(`  검사 유저=${checked}`);
  console.log(`  ① API(단건) == user_weekly_points 직접합산: ✅${apiMatch} / ❌${apiMismatch}`);
  console.log(`  ② 배치 API == 단건 API: ✅${batchEqSingle} / ❌${batchNe}`);
  console.log(`  ③ (참고) 수정전 캐시 ≠ 수정후 직접합산 유저 수: ${cacheDiff}`);
  if (apiFails.length) {
    console.log("\n  ❌ API 불일치:");
    for (const f of apiFails.slice(0, 30)) console.log("    " + f);
  }
  if (batchFails.length) {
    console.log("\n  ❌ 배치≠단건:");
    for (const f of batchFails.slice(0, 30)) console.log("    " + f);
  }
  if (cacheDiffs.length) {
    console.log("\n  ⚠ 캐시 stale 였던 유저 (수정으로 교정됨):");
    for (const f of cacheDiffs.slice(0, 30)) console.log("    " + f);
  }

  // 샘플 3명.
  console.log("\n  [샘플 3명]");
  let shown = 0;
  for (const u of target) {
    if (shown >= 3) break;
    const direct = await directSum(u.userId);
    if (direct.weeks === 0) continue;
    const p = (await getGrowthIndicators(u.userId)).point;
    console.log(
      `    ${u.name} [${u.organizationSlug ?? "-"}] weeks=${direct.weeks}  API별/raw/번개/net=${p.points}/${p.rawAdvantages}/${p.penalty}/${p.netAdvantages}  direct=${direct.star}/${direct.rawAdv}/${direct.pen}/${direct.net}`,
    );
    shown++;
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
