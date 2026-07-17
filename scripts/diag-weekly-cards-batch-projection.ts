/**
 * batch API 효과 예측 근거 — 읽기 전용 실측(쓰기 없음, 계산 없음).
 *
 * 조회 경로(snapshot HIT)가 유저당 발행하는 5개 쿼리를, 같은 필터를 .in(user_id, [30명]) 으로
 * 묶었을 때 실제로 몇 ms 가 드는지 측정한다. batch API 를 만들기 전에 "정말 빨라지는가"를
 * 수치로 확인하기 위한 계측이다(정책·DTO·snapshot 무변경).
 *
 * 사용: tsx --env-file=.env.local scripts/diag-weekly-cards-batch-projection.ts [--users=30]
 */
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const N = Number(arg("users", "30"));

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function timed<T>(label: string, fn: () => Promise<{ data: T | null; error: unknown }>) {
  const t = performance.now();
  const { data, error } = await fn();
  const ms = performance.now() - t;
  const bytes = Buffer.byteLength(JSON.stringify(data ?? []), "utf8");
  console.log(
    `  ${label.padEnd(46)} ${ms.toFixed(0).padStart(6)}ms  ${(bytes / 1024).toFixed(0).padStart(7)}KB` +
      (error ? `  ⚠ ${(error as { message: string }).message}` : ""),
  );
  return { ms, bytes };
}

async function main() {
  const { data: snap } = await db
    .from("cluster4_weekly_card_snapshots")
    .select("user_id")
    .order("computed_at", { ascending: false })
    .limit(N);
  const ids = (snap ?? []).map((r) => (r as { user_id: string }).user_id);
  console.log("═".repeat(78));
  console.log(`batch 투영 실측 — ${ids.length}명을 .in(user_id) 단일 쿼리로 묶었을 때`);
  console.log("═".repeat(78));

  console.log("\n[A] 현재 조회 경로가 유저당 1번씩 도는 5개 쿼리를 .in() 으로 1번에:");
  const a1 = await timed("test_user_markers (전역·유저무관)", () =>
    db.from("test_user_markers").select("*") as never,
  );
  const a2 = await timed("cluster4_weekly_card_snapshots (cards 전문)", () =>
    db
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,cards,dto_version,is_stale,computed_at")
      .in("user_id", ids) as never,
  );
  const a3 = await timed("cluster4_line_enhancement_overrides", () =>
    db.from("cluster4_line_enhancement_overrides").select("*").in("user_id", ids) as never,
  );
  const a4 = await timed("cluster4_line_second_entry_overrides", () =>
    db.from("cluster4_line_second_entry_overrides").select("*").in("user_id", ids) as never,
  );
  const a5 = await timed("user_profiles (growth stop)", () =>
    db.from("user_profiles").select("user_id,status,growth_status").in("user_id", ids) as never,
  );

  const seqSum = a1.ms + a2.ms + a3.ms + a4.ms + a5.ms;
  const parMax = Math.max(a1.ms, a2.ms, a3.ms, a4.ms, a5.ms);
  const totalBytes = a1.bytes + a2.bytes + a3.bytes + a4.bytes + a5.bytes;

  console.log(`\n  → 5쿼리 순차 합계   : ${seqSum.toFixed(0)}ms`);
  console.log(`  → 5쿼리 병렬(=max) : ${parMax.toFixed(0)}ms`);
  console.log(`  → 전송량           : ${(totalBytes / 1024 / 1024).toFixed(2)}MB`);

  console.log("\n[B] 참고 — cards 전문을 빼면(슬림 응답) 얼마나 줄어드는가:");
  await timed("snapshot: card_count/computed_at 만", () =>
    db
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,card_count,dto_version,is_stale,computed_at")
      .in("user_id", ids) as never,
  );
  await timed("cluster4_roster_card_stats (기존 slim 캐시)", () =>
    db.from("cluster4_roster_card_stats").select("*").in("user_id", ids) as never,
  );

  console.log(`\n${"═".repeat(78)}`);
  console.log("현재 구조 그대로 batch 를 만들 때의 예상 하한");
  console.log("═".repeat(78));
  console.log(`  쿼리 수      : 5 × ${ids.length}명 = ${5 * ids.length} → 5 (${ids.length}배 감소)`);
  console.log(`  HTTP         : ${ids.length}콜 → 1콜`);
  console.log(`  예상 latency : ${seqSum.toFixed(0)}ms (현 구조=순차 유지 시)`);
  console.log(`               : ${parMax.toFixed(0)}ms (5쿼리 병렬화까지 할 경우)`);
  console.log(`  전송량       : ${(totalBytes / 1024 / 1024).toFixed(2)}MB (cards 전문 유지 시 — 감소 없음)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
