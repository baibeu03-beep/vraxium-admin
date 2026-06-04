/**
 * 테스터 라인 개설 보강 원복 — 삽입 ID 로그 기반 정밀 삭제.
 *
 *   npx tsx --env-file=.env.local scripts/revert-tester-line-open-backfill.ts          # 조회만
 *   npx tsx --env-file=.env.local scripts/revert-tester-line-open-backfill.ts --apply  # 삭제 실행
 *
 * claudedocs/tester-backfill-20260604-inserted.json 의 모든 run 삽입분(타깃 → 라인 순)을 삭제하고
 * 영향 테스터 snapshot 을 재계산한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const LOG_PATH = "claudedocs/tester-backfill-20260604-inserted.json";
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!existsSync(LOG_PATH)) {
    console.log("로그 없음 — 원복할 삽입분이 없습니다.");
    return;
  }
  const log = JSON.parse(readFileSync(LOG_PATH, "utf8"));
  const targetIds: string[] = log.runs.flatMap((r: any) => r.targetInsertIds ?? []);
  const lineIds: string[] = log.runs.flatMap((r: any) => (r.lineInserts ?? []).map((l: any) => l.id));
  console.log(`원복 대상: targets ${targetIds.length} / lines ${lineIds.length} | 모드: ${APPLY ? "APPLY" : "조회만"}`);
  if (!APPLY) return;

  // 영향 테스터 수집 (삭제 전)
  const affected = new Set<string>();
  for (let i = 0; i < targetIds.length; i += 100) {
    const { data } = await sb
      .from("cluster4_line_targets")
      .select("target_user_id")
      .in("id", targetIds.slice(i, i + 100));
    for (const r of (data ?? []) as any[]) if (r.target_user_id) affected.add(r.target_user_id);
  }

  for (let i = 0; i < targetIds.length; i += 100) {
    const { error } = await sb.from("cluster4_line_targets").delete().in("id", targetIds.slice(i, i + 100));
    if (error) throw new Error("타깃 삭제 실패: " + error.message);
  }
  if (lineIds.length > 0) {
    const { error } = await sb.from("cluster4_lines").delete().in("id", lineIds);
    if (error) throw new Error("라인 삭제 실패: " + error.message);
  }
  console.log("삭제 완료. snapshot 재계산:", affected.size, "명");
  const res = await recomputeWeeklyCardsSnapshotsForUsers([...affected], { concurrency: 4 });
  console.log("snapshot 재계산 결과:", JSON.stringify(res));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
