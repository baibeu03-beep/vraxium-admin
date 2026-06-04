/**
 * 테스터 실무경험 success 백필 v13 원복 — 로그 기반 정밀 원복.
 *
 *   npx tsx --env-file=.env.local scripts/revert-tester-exp-success-backfill.ts          # 조회만
 *   npx tsx --env-file=.env.local scripts/revert-tester-exp-success-backfill.ts --apply  # 원복 실행
 *
 * 순서: 타깃 삭제(로그 id) → 라인 삭제(마커) → uws success→fail 원복(로그 쌍, success 가드)
 *       → 영향 테스터 snapshot 재계산.
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
const MARKER = "tester-experience-success-backfill-v13-20260604";
const LOG_PATH = `claudedocs/${MARKER}-inserted.json`;
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!existsSync(LOG_PATH)) {
    console.log("로그 없음 — 원복 대상 없음");
    return;
  }
  const log = JSON.parse(readFileSync(LOG_PATH, "utf8"));
  const targetIds: string[] = log.runs.flatMap((r: any) => r.targetInsertIds ?? []);
  const uwsPairs: { userId: string; weekStart: string }[] = log.runs.flatMap((r: any) => r.uwsFlipped ?? []);
  const { data: markerLines } = await sb.from("cluster4_lines").select("id").eq("source_file_name", MARKER);
  const lineIds = ((markerLines ?? []) as any[]).map((l) => l.id);
  console.log(`원복 대상: targets ${targetIds.length} / lines(마커) ${lineIds.length} / uws ${uwsPairs.length} | ${APPLY ? "APPLY" : "조회만"}`);
  if (!APPLY) return;

  for (let i = 0; i < targetIds.length; i += 100) {
    const { error } = await sb.from("cluster4_line_targets").delete().in("id", targetIds.slice(i, i + 100));
    if (error) throw new Error("타깃 삭제 실패: " + error.message);
  }
  // 마커 라인에 남은 잔여 타깃(혹시 모를 외부 생성분) 확인 후 라인 삭제
  if (lineIds.length > 0) {
    const { count } = await sb.from("cluster4_line_targets").select("*", { count: "exact", head: true }).in("line_id", lineIds);
    if ((count ?? 0) > 0) {
      console.warn(`마커 라인에 잔여 타깃 ${count}건 — 함께 삭제`);
      const { error } = await sb.from("cluster4_line_targets").delete().in("line_id", lineIds);
      if (error) throw new Error("잔여 타깃 삭제 실패: " + error.message);
    }
    const { error } = await sb.from("cluster4_lines").delete().in("id", lineIds);
    if (error) throw new Error("라인 삭제 실패: " + error.message);
  }
  let uwsReverted = 0;
  for (const p of uwsPairs) {
    const { data, error } = await sb
      .from("user_week_statuses")
      .update({ status: "fail", updated_at: new Date().toISOString() })
      .eq("user_id", p.userId)
      .eq("week_start_date", p.weekStart)
      .eq("status", "success") // 우리가 올린 success 만 원복
      .select("user_id");
    if (error) throw new Error("uws 원복 실패: " + error.message);
    if (data && data.length > 0) uwsReverted++;
  }
  console.log(`uws 원복: ${uwsReverted} row`);
  const affected = [...new Set(uwsPairs.map((p) => p.userId))];
  const res = await recomputeWeeklyCardsSnapshotsForUsers(affected, { concurrency: 4 });
  console.log("snapshot 재계산:", JSON.stringify(res));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
