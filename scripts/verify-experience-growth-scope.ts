/**
 * 테스트/운영 sync 대상 분리 검증 (2026-05-30).
 *
 *   npx tsx --env-file=.env.local scripts/verify-experience-growth-scope.ts
 *
 * 1. syncTestExperienceGrowthWeekStatuses() 는 테스트 사용자만 대상 (실사용자 미변경).
 * 2. 멱등성: 재실행 시 추가 flip 0.
 * 3. 원복된 실사용자(2026/21)는 test sync 후에도 success 유지.
 * ※ 운영 전체(syncAll)는 실사용자도 flip 하므로 여기서는 호출하지 않는다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import {
  syncTestExperienceGrowthWeekStatuses,
} from "@/lib/cluster4WeeklyGrowthData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const isTest = (n: string | null) => !!n && n.toLowerCase().includes("t");

async function realFailCount(): Promise<number> {
  // 오늘 sync 로 생긴 실사용자 fail 수 (updated_at>=오늘). seed/과거 정상 fail 은 제외.
  const cutoff = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const { data } = await sb
    .from("user_week_statuses")
    .select("user_id,status")
    .eq("status", "fail")
    .gte("updated_at", cutoff);
  const ids = ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  if (ids.length === 0) return 0;
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,display_name")
    .in("user_id", ids);
  const nameById = new Map(
    ((profs ?? []) as { user_id: string; display_name: string | null }[]).map(
      (p) => [p.user_id, p.display_name],
    ),
  );
  return ids.filter((id) => !isTest(nameById.get(id) ?? null)).length;
}

async function main() {
  const realFailBefore = await realFailCount();
  console.log(`test sync 전 실사용자 fail(2026/21) = ${realFailBefore}`);

  const run1 = await syncTestExperienceGrowthWeekStatuses();
  const run2 = await syncTestExperienceGrowthWeekStatuses();
  console.log(`run1 = ${JSON.stringify({ scope: run1.scope, scanned: run1.usersScanned, flipped: run1.totalFlippedToFail })}`);
  console.log(`run2 = ${JSON.stringify({ scope: run2.scope, scanned: run2.usersScanned, flipped: run2.totalFlippedToFail })}`);

  const realFailAfter = await realFailCount();
  console.log(`test sync 후 실사용자 fail(2026/21) = ${realFailAfter}`);

  const ok1 = run1.scope === "test";
  const ok2 = run2.totalFlippedToFail === 0; // 멱등
  const ok3 = realFailAfter === 0 && realFailBefore === 0; // 실사용자 불가침

  console.log(`\n✅ scope=test 적용: ${ok1}`);
  console.log(`${ok2 ? "✅" : "❌"} 재실행 멱등(flip 0): ${run2.totalFlippedToFail}`);
  console.log(`${ok3 ? "✅" : "❌"} 실사용자 미변경(fail 0 유지): before=${realFailBefore} after=${realFailAfter}`);
  if (!ok1 || !ok2 || !ok3) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
