/**
 * v41→v42 실무 경험 강화율(유형 슬롯 폴딩) snapshot 재생성.
 *   dry-run:  npx tsx --env-file=.env.local scripts/backfill-experience-slot-fold-v42.ts
 *   apply:    npx tsx --env-file=.env.local scripts/backfill-experience-slot-fold-v42.ts --apply
 *
 * 목적: breakdownFromLines 의 experience 산식이 "유형 슬롯"(오픈+비대상=실패 분모 포함)으로 바뀌어
 *   기존 snapshot 의 experienceRate/weeklyGrowthRate 가 stale(구 100% 등)이다. 영향 (사용자,주차)를
 *   결정적으로 산출하고(--apply 시) 해당 사용자 snapshot 을 재생성한다.
 *
 * 판정: 저장된 card.experienceRate(구) vs breakdownFromLines(card.lines).experience(신 코드) 비교.
 *   lines 자체는 불변(슬롯/대상/enh) — 산식만 바뀌므로 이 비교가 곧 "이 변경으로 값이 달라지는가".
 *   READ-ONLY(dry-run) / --apply 만 recomputeAndStoreWeeklyCardsSnapshot 로 재생성한다.
 */
import { createClient } from "@supabase/supabase-js";
import { breakdownFromLines } from "@/lib/cluster4WeeklyCardsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const TABLE = "cluster4_weekly_card_snapshots";
const APPLY = process.argv.includes("--apply");

type SnapRow = { user_id: string; cards: Cluster4WeeklyCardDto[]; dto_version: number };

async function* iterateSnapshots(): AsyncGenerator<SnapRow> {
  const PAGE = 40; // fat cards jsonb → 페이지 작게
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from(TABLE)
      .select("user_id,cards,dto_version")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as SnapRow[];
    for (const r of rows) yield r;
    if (rows.length < PAGE) break;
    from += PAGE;
  }
}

async function main() {
  console.log(`════════ v42 experience 강화율 재생성 (${APPLY ? "APPLY" : "DRY-RUN"}) ════════`);
  const affectedUsers = new Set<string>();
  let scannedUsers = 0;
  let scannedCards = 0;
  let changedCards = 0;
  const examples: string[] = [];

  for await (const row of iterateSnapshots()) {
    scannedUsers++;
    for (const card of row.cards ?? []) {
      if (!card.weekId || card.isRestWeek) continue;
      scannedCards++;
      const stored = card.experienceRate; // 구 저장값 { count, total, rate }
      const nw = breakdownFromLines(card.lines ?? []).experience; // 신 산식
      const storedTotal = stored?.total ?? 0;
      const storedCount = stored?.count ?? 0;
      if (storedTotal !== nw.available || storedCount !== nw.completed) {
        changedCards++;
        affectedUsers.add(row.user_id);
        if (examples.length < 15) {
          examples.push(
            `${row.user_id.slice(0, 8)}… ${card.weekLabel ?? card.weekId}: ` +
              `경험 ${storedCount}/${storedTotal} → ${nw.completed}/${nw.available}`,
          );
        }
      }
    }
    if (scannedUsers % 500 === 0) {
      console.log(`  ...scanned ${scannedUsers} users, changed cards ${changedCards}`);
    }
  }

  console.log(`\n스캔: 사용자 ${scannedUsers} · 비휴식 카드 ${scannedCards}`);
  console.log(`값 변경 카드: ${changedCards} · 영향 사용자: ${affectedUsers.size}`);
  console.log("예시(구→신):");
  for (const e of examples) console.log("  · " + e);

  if (!APPLY) {
    console.log(`\n(DRY-RUN) 재생성하려면 --apply. 대상 사용자 ${affectedUsers.size}명 재계산 예정.`);
    return;
  }

  // ── APPLY: 영향 사용자 snapshot 결정적 재생성 ──
  const ids = [...affectedUsers];
  console.log(`\n[APPLY] ${ids.length}명 재생성 시작(동시성 3)...`);
  let done = 0;
  let ok = 0;
  const failed: string[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const uid = ids[cursor++];
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(uid);
        ok++;
      } catch (e) {
        failed.push(uid);
        console.warn(`  FAILED ${uid}:`, e instanceof Error ? e.message : e);
      } finally {
        done++;
        if (done % 25 === 0) console.log(`  progress ${done}/${ids.length} (ok=${ok})`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  console.log(`\n[APPLY] 완료 — ok=${ok} failed=${failed.length}`);
  if (failed.length) console.log("실패:", failed.slice(0, 20));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
