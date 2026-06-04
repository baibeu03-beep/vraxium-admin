/**
 * v11 snapshot 전체 재계산 (2026-06-04).
 *
 *   npx tsx --env-file=.env.local scripts/run-recompute-snapshots-v11.ts
 *
 * 1) 재계산 전 dto_version 분포 출력
 * 2) recomputeStaleOrDueSnapshots (dto_version != 11 후보 포함) 반복 실행 — 전원 v11 수렴까지
 * 3) 재계산 후 dto_version 분포 출력 (v11 외 잔여 행이 있으면 exit 1)
 */
import {
  recomputeStaleOrDueSnapshots,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const TABLE = "cluster4_weekly_card_snapshots";

async function distribution(label: string): Promise<Map<string, number>> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("dto_version,is_stale");
  if (error) throw new Error(`분포 조회 실패: ${error.message}`);
  const cnt = new Map<string, number>();
  for (const r of (data ?? []) as { dto_version: number; is_stale: boolean }[]) {
    const k = `v${r.dto_version}${r.is_stale ? "(stale)" : ""}`;
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  const total = data?.length ?? 0;
  console.log(
    `[${label}] 총 ${total}행 — ${[...cnt.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
  return cnt;
}

async function main() {
  console.log(`목표 DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION}`);
  await distribution("재계산 전");

  // 후보(버전 불일치/stale/due)가 0이 될 때까지 반복. maxUsers=200 이면 117명은 1회로 충분하나
  // 도중 무효화 등 잔여 발생 대비 안전 루프(최대 5회).
  for (let round = 1; round <= 5; round++) {
    const r = await recomputeStaleOrDueSnapshots({
      maxUsers: 200,
      concurrency: 4,
      // due(1시간 경과) 행까지 포함해 전부 신선화.
      dueOlderThanMs: 60 * 60 * 1000,
    });
    console.log(
      `[round ${round}] scanned=${r.scanned} recomputed=${r.recomputed} failed=${r.failed} (${Math.round(r.durationMs / 1000)}s)`,
    );
    if (r.failed > 0) console.log("  실패 유저:", r.failedUserIds.join(", "));
    if (r.scanned === 0) break;
  }

  const after = await distribution("재계산 후");
  const nonV11 = [...after.entries()].filter(
    ([k]) => !k.startsWith(`v${WEEKLY_CARDS_DTO_VERSION}`) || k.includes("stale"),
  );
  if (nonV11.length > 0) {
    console.log(`✗ v${WEEKLY_CARDS_DTO_VERSION} 미수렴 잔여:`, nonV11);
    process.exitCode = 1;
  } else {
    console.log(`✓ 전원 v${WEEKLY_CARDS_DTO_VERSION} (비-stale) 수렴`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
