/**
 * rollback-kwonsoyul-info-targets-existing.ts
 * apply-kwonsoyul-info-targets-existing.ts 가 만든 T권소율 target 만 삭제. **기존 라인은 절대 삭제 안 함**.
 *
 *   npx tsx --env-file=.env.local scripts/rollback-kwonsoyul-info-targets-existing.ts            # DRY-RUN
 *   npx tsx --env-file=.env.local scripts/rollback-kwonsoyul-info-targets-existing.ts --apply    # 삭제 + snapshot 재계산
 *
 * 대상 = 최신 claudedocs/rollback-kwonsoyul-info-targets-existing-*.json 의 createdTargetIds.
 * 안전: 삭제 대상 target 이 전부 target_user_id=T권소율 인지 재검증. cluster4_lines 무접촉.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "fs";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const APPLY = process.argv.includes("--apply");
function die(m: string): never { console.error(`\n❌ 중단: ${m}`); process.exit(1); }

async function main() {
  console.log(`모드: ${APPLY ? "APPLY(실삭제)" : "DRY-RUN"}\n`);
  const files = readdirSync("claudedocs").filter((f) => f.startsWith("rollback-kwonsoyul-info-targets-existing-")).sort();
  if (!files.length) die("백업 파일 없음 (rollback-kwonsoyul-info-targets-existing-*.json)");
  const backup = JSON.parse(readFileSync(`claudedocs/${files[files.length - 1]}`, "utf8"));
  const u = backup.targetUserId as string;
  const targetIds = (backup.createdTargetIds ?? []) as string[];
  console.log(`백업: ${files[files.length - 1]} | target ${targetIds.length}개 | user ${u}`);
  if (!targetIds.length) { console.log("삭제할 target 없음."); return; }

  // 라이브 재검증: 전부 T권소율 target 인지 + 테스트 유저인지
  const { data: live } = await sb.from("cluster4_line_targets").select("id,target_user_id,line_id").in("id", targetIds);
  const testIds = await fetchTestUserMarkerIds();
  const offenders = (live ?? []).filter((t: any) => t.target_user_id !== u || !testIds.has(t.target_user_id));
  if (offenders.length) die(`대상 외 target ${offenders.length}건 — 삭제 금지`);
  console.log(`재검증: 라이브 ${(live ?? []).length}건 전부 T권소율(test) ✅ (라인은 무접촉)`);

  if (!APPLY) { console.log(`\n(DRY-RUN — DB 변경 없음)`); return; }

  const { error, count } = await sb.from("cluster4_line_targets").delete({ count: "exact" }).in("id", targetIds);
  if (error) die(`삭제 실패: ${error.message}`);
  console.log(`  ✓ target 삭제: ${count}`);

  const snap = await recomputeWeeklyCardsSnapshotsForUsers([u], { concurrency: 1 });
  console.log(`[snapshot] T권소율 재계산: recomputed=${snap.recomputed} failed=${snap.failed}`);
  console.log(`\n✅ 롤백 완료 (기존 라인 ${(backup.usedExistingLineIds ?? []).length}개는 무변경).`);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
