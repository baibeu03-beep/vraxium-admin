// 검증(READ-ONLY, dry-run) — Phase 2: 성장 동기화 테스트 판정 = test_user_markers SoT.
//   npx tsx --env-file=.env.local scripts/verify-phase2-growth-marker.ts
// 모든 sync 호출 dryRun=true (DB write 0·snapshot 재계산 0). %T% 휴리스틱 제거 확인.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import {
  fetchIsTestUser,
  syncAllExperienceGrowthWeekStatuses,
  syncTestExperienceGrowthWeekStatuses,
} from "@/lib/cluster4WeeklyGrowthData";

let pass = 0;
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  const testSet = await fetchTestUserMarkerIds();
  const markerIds = [...testSet];
  console.log(`test_user_markers: ${markerIds.length}`);

  // ── 단건 판정 = marker 기준 ──
  const aMarker = markerIds[0];
  ck("[판정] marker 유저 fetchIsTestUser=true", aMarker ? await fetchIsTestUser(aMarker) : false);

  // 실사용자(마커 비등재) 1명.
  const { data: realProf } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name")
    .not("user_id", "in", `(${markerIds.slice(0, 1).join(",") || "00000000-0000-0000-0000-000000000000"})`)
    .limit(500);
  const real = ((realProf ?? []) as { user_id: string; display_name: string | null }[]).find(
    (p) => !testSet.has(p.user_id),
  );
  ck("[판정] 실사용자 fetchIsTestUser=false", real ? (await fetchIsTestUser(real.user_id)) === false : false, real?.display_name ?? "");

  // ── 핵심: 이름에 't/T' 포함하지만 marker 비등재인 실사용자 → false (휴리스틱 제거 증명) ──
  const { data: tNamed } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name")
    .ilike("display_name", "%t%")
    .limit(2000);
  const tNamedReal = ((tNamed ?? []) as { user_id: string; display_name: string | null }[]).filter(
    (p) => !testSet.has(p.user_id),
  );
  if (tNamedReal.length > 0) {
    const sample = tNamedReal[0];
    const judged = await fetchIsTestUser(sample.user_id);
    ck(
      "[휴리스틱제거] 이름에 't' 포함 실사용자 → fetchIsTestUser=false",
      judged === false,
      `${sample.display_name} (구 %T% 매칭=${tNamedReal.length}명, 신 marker 판정=false)`,
    );
  } else {
    ck("[휴리스틱제거] (이름 't' 포함 실사용자 표본 없음 — 영향 0)", true, "스킵");
  }

  // ── 성장 success 보유 유저 distinct ──
  const { data: succ } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id")
    .eq("status", "success");
  const successIds = new Set(((succ ?? []) as { user_id: string }[]).map((r) => r.user_id));
  const expectedTestScan = [...successIds].filter((id) => testSet.has(id)).length;
  const oldHeuristicScan = (() => {
    // 구 휴리스틱(이름 't' 포함)으로 잡혔을 success 유저 수(대조용).
    const tIds = new Set(((tNamed ?? []) as { user_id: string }[]).map((r) => r.user_id));
    return [...successIds].filter((id) => tIds.has(id)).length;
  })();

  // ── snapshot/uws 불변 가드 (dry-run 전후) ──
  const snapCount = async () =>
    (await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true })).count ?? 0;
  const succCount = async () =>
    (await supabaseAdmin.from("user_week_statuses").select("*", { count: "exact", head: true }).eq("status", "success")).count ?? 0;
  const snapBefore = await snapCount();
  const succBefore = await succCount();

  // ── dry-run: operating(all) 불변 ──
  const allDry = await syncAllExperienceGrowthWeekStatuses({ dryRun: true });
  ck(
    "[operating] all scope 스캔=success 보유 전원(테스트 필터 없음)",
    allDry.usersScanned === successIds.size,
    `scanned=${allDry.usersScanned} successUsers=${successIds.size}`,
  );
  ck("[operating] all scope dryRun=true (DB 미반영)", allDry.dryRun === true);

  // ── dry-run: test scope 모집단 = marker ∩ success ──
  const testDry = await syncTestExperienceGrowthWeekStatuses({ dryRun: true });
  ck(
    "[test] test scope 모집단 = test_user_markers ∩ success",
    testDry.usersScanned === expectedTestScan,
    `scanned=${testDry.usersScanned} expected(marker∩success)=${expectedTestScan} / 구휴리스틱=${oldHeuristicScan}`,
  );
  ck("[test] test scope dryRun=true (DB 미반영)", testDry.dryRun === true);

  // ── snapshot/uws 불변 확인 ──
  const snapAfter = await snapCount();
  const succAfter = await succCount();
  ck("[격리] dry-run 후 snapshot count 불변", snapAfter === snapBefore, `${snapBefore}→${snapAfter}`);
  ck("[격리] dry-run 후 uws success count 불변", succAfter === succBefore, `${succBefore}→${succAfter}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
