/**
 * line_code UN→EN rename 후 — 전체 snapshot 일괄 재계산 (2026-06-07 승인).
 *
 *   npx tsx --env-file=.env.local scripts/recompute-all-snapshots-post-rename.ts --apply
 *
 * 목적: snapshot cards[].lines[].lineCode 의 구값(EXBS-UN…) stale 해소.
 * 범위: cluster4_weekly_card_snapshots 보유 전 사용자 — uws/uwp/실무경험 write 0
 *   (recomputeAndStoreWeeklyCardsSnapshot = 캐시 재생성만).
 * 부수효과(의도): 기존 자연 stale(B7 이전 계산본의 checkGate.required 구값 — phalanx 28명 등)도
 *   현행 정합값으로 함께 갱신된다.
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const OUT = "claudedocs/snapshot-recompute-post-rename-20260607.json";
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

async function main() {
  const users: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    users.push(...((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
    if ((data ?? []).length < 1000) break;
  }
  console.log(`대상 snapshot 사용자: ${users.length}`);
  if (!APPLY) {
    console.log("dry-run — --apply 로 실행");
    return;
  }
  let ok = 0, fail = 0;
  const failures: string[] = [];
  for (const uid of users) {
    try {
      await recomputeAndStoreWeeklyCardsSnapshot(uid);
      ok++;
    } catch (e) {
      fail++;
      failures.push(`${uid}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ((ok + fail) % 20 === 0) console.log(`  …${ok + fail}/${users.length}`);
  }
  writeFileSync(OUT, JSON.stringify({ total: users.length, ok, fail, failures }, null, 1));
  console.log(`완료: ok ${ok} / fail ${fail} → ${OUT}`);
  if (fail) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
