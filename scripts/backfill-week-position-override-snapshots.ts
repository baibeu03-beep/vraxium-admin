/**
 * 2단계 백필 — 기존 override 보유 크루의 weekly-cards snapshot 재계산.
 *
 * 1단계(2026-07-21)에는 override 저장 시 snapshot invalidate 를 호출하지 않았다(설계상 유예).
 * 2단계(2026-07-22)에서 카드 빌더가 effective(override ?? UPH)를 소비하도록 바뀌었으므로,
 * **그 전에 저장된 override** 를 가진 크루의 snapshot 은 아직 UPH-only 값으로 굳어 있다.
 * 이 스크립트가 그 유저들만 정확히 골라 재계산한다(전역 dto_version bump 불필요 — 영향 유저가
 * override 테이블로 열거 가능하므로 전량 재계산 storm 을 피한다).
 *
 * --users 로 명시 대상을 줄 수도 있다. override 를 **삭제**한 뒤(= effective 가 base 로 돌아간 뒤)에는
 * override 테이블 열거로 그 유저를 찾을 수 없으므로, 삭제 경로(정리 스크립트 등)가 이 형태로 호출한다.
 *
 *   Usage: npx tsx --env-file=.env.local scripts/backfill-week-position-override-snapshots.ts [--apply]
 *          npx tsx --env-file=.env.local scripts/backfill-week-position-override-snapshots.ts --apply --users=<uuid>,<uuid>
 *          (--apply 없으면 dry-run: 대상만 출력)
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const EXPLICIT = (process.argv.find((a) => a.startsWith("--users=")) ?? "")
  .slice("--users=".length)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  if (EXPLICIT.length > 0) {
    console.log(`명시 대상: ${EXPLICIT.length}명`);
    if (!APPLY) {
      console.log(EXPLICIT.join("\n"));
      console.log("\n(dry-run) --apply 로 실제 재계산.");
      return;
    }
    const r = await recomputeWeeklyCardsSnapshotsForUsers(EXPLICIT, { concurrency: 3 });
    console.log(
      `재계산 완료 — requested=${r.requested} recomputed=${r.recomputed} failed=${r.failed}`,
    );
    if (r.failed > 0) process.exit(1);
    return;
  }

  const userIds = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_team_week_position_overrides")
      .select("user_id,organization,week_start_date,raw_team")
      .order("week_start_date", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error("❌ override 조회 실패:", error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{ user_id: string }>;
    for (const r of rows) userIds.add(r.user_id);
    if (rows.length < 1000) break;
  }

  const ids = [...userIds];
  console.log(`override 보유 크루: ${ids.length}명`);
  if (ids.length === 0) {
    console.log("대상 없음 — 종료.");
    return;
  }
  if (!APPLY) {
    console.log(ids.slice(0, 20).join("\n"));
    if (ids.length > 20) console.log(`… 외 ${ids.length - 20}명`);
    console.log("\n(dry-run) --apply 로 실제 재계산.");
    return;
  }

  const result = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 3 });
  console.log(
    `재계산 완료 — requested=${result.requested} recomputed=${result.recomputed} failed=${result.failed}`,
  );
  if (result.failed > 0) {
    console.log(`실패(cron 이 보정): ${result.failedUserIds.join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
