/**
 * 부분 원복: 실유저 카드 범위(2026-05-04~)와 겹치는 주차(05-04, 05-11)의 백필 제거.
 * info 라인은 org='common'이라 실유저 분모/표시에 노출되므로 이 두 주차는 보강 불가.
 *   npx tsx --env-file=.env.local scripts/partial-revert-w10-w11-backfill.ts --apply
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const APPLY = process.argv.includes("--apply");
const LOG_PATH = "claudedocs/tester-backfill-20260604-inserted.json";
// apply 로그상 2026-05-04 / 2026-05-11 더미 라인
const LINE_IDS = ["bd21da98-d132-4891-86f0-d13296858e18", "3bcaf211-f97e-485e-9964-f615879071e9"];

async function main() {
  const { data: targets } = await sb.from("cluster4_line_targets")
    .select("id, target_user_id, week_id").in("line_id", LINE_IDS);
  const affected = [...new Set((targets ?? []).map((t: any) => t.target_user_id).filter(Boolean))];
  console.log(`삭제 대상: targets ${targets?.length} / lines ${LINE_IDS.length} / 영향 테스터 ${affected.length} | ${APPLY ? "APPLY" : "조회만"}`);
  if (!APPLY) return;
  const { error: tErr } = await sb.from("cluster4_line_targets").delete().in("line_id", LINE_IDS);
  if (tErr) throw new Error(tErr.message);
  const { error: lErr } = await sb.from("cluster4_lines").delete().in("id", LINE_IDS);
  if (lErr) throw new Error(lErr.message);
  const log = JSON.parse(readFileSync(LOG_PATH, "utf8"));
  log.runs.push({
    runAt: new Date().toISOString(),
    mode: "PARTIAL-REVERT(w 2026-05-04, 2026-05-11)",
    reason: "info 라인 org=common → 실유저 카드 범위(2026-05-04~) 겹침 오염. 두 주차 백필 철회.",
    deletedLineIds: LINE_IDS,
    deletedTargets: targets?.length ?? 0,
  });
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  console.log("snapshot 재계산:", affected.length, "명");
  const res = await recomputeWeeklyCardsSnapshotsForUsers(affected as string[], { concurrency: 4 });
  console.log("결과:", JSON.stringify(res));
}
main().catch((e) => { console.error(e); process.exit(1); });
