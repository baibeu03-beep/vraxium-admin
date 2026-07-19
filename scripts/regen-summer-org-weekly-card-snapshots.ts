// 2026-summer 3개 조직(phalanx/oranke/encre) 참여자 전원의 weekly-card snapshot 재생성.
//   scope 이관(migrate-week-org-result-states-scope --apply) 후 실행한다. 각 사용자의 카드는
//   그 사용자 scope(test-marker 여부)에 맞는 조직 검수 상태를 읽어 재계산된다.
//     · 운영 사용자 → operating scope(전부 aggregating) → W2 '집계 중' 카드(제거 안 됨)
//     · 테스트 사용자 → test scope → 검수 완료 주차는 success/fail, 그 외 집계 중
//   ⚠ scope 컬럼 마이그레이션 선행 필요. Usage: tsx --env-file=.env.local scripts/regen-summer-org-weekly-card-snapshots.ts [--apply]
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const ORGS = ["phalanx", "oranke", "encre"] as const;
const CONCURRENCY = 6;

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  const { data: uss } = await supabaseAdmin
    .from("user_season_statuses").select("user_id").eq("season_key", "2026-summer");
  const userIds = [...new Set(((uss ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))];

  // org 필터 + scope 분류
  const orgByUser = new Map<string, string | null>();
  for (let i = 0; i < userIds.length; i += 300) {
    const { data } = await supabaseAdmin
      .from("user_profiles").select("user_id,organization_slug").in("user_id", userIds.slice(i, i + 300));
    for (const p of (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>) orgByUser.set(p.user_id, p.organization_slug);
  }
  const targets = userIds.filter((id) => {
    const org = orgByUser.get(id);
    return org != null && (ORGS as readonly string[]).includes(org);
  });
  const byBucket: Record<string, number> = {};
  for (const id of targets) {
    const org = orgByUser.get(id)!;
    const scope = testIds.has(id) ? "test" : "operating";
    byBucket[`${org}:${scope}`] = (byBucket[`${org}:${scope}`] ?? 0) + 1;
  }
  console.log(`재생성 대상 ${targets.length}명`);
  for (const k of Object.keys(byBucket).sort()) console.log(`   ${k.padEnd(20)} ${byBucket[k]}`);

  if (!APPLY) {
    console.log("\n[DRY-RUN] --apply 없이 실행 — 재계산하지 않았습니다.");
    return;
  }

  let done = 0, failed = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const id = targets[cursor++];
      try { await recomputeAndStoreWeeklyCardsSnapshot(id); done++; }
      catch (e) { failed++; console.warn(`✗ ${id}:`, e instanceof Error ? e.message : e); }
      if ((done + failed) % 25 === 0) console.log(`   ...${done + failed}/${targets.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));
  console.log(`\n✓ 재생성 완료 — 성공 ${done} · 실패 ${failed}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
