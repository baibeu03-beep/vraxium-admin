/**
 * 테스터 과거 fail 주차 라인 개설 보강 — 실행기 (claudedocs/tester-line-open-backfill-20260604.sql 와 동등).
 *
 *   npx tsx --env-file=.env.local scripts/apply-tester-line-open-backfill.ts                  # dry-run(=preview)
 *   npx tsx --env-file=.env.local scripts/apply-tester-line-open-backfill.ts --pilot <userId> # 한 명만 실반영
 *   npx tsx --env-file=.env.local scripts/apply-tester-line-open-backfill.ts --apply          # 전수 실반영
 *
 * - 삽입한 모든 row id 를 claudedocs/tester-backfill-20260604-inserted.json 에 append (원복 키)
 * - 실반영 후 대상 테스터 weekly-cards snapshot 즉시 재계산 (snapshot-only 구조 반영)
 * - 트랜잭션 미지원(supabase-js) 보완: 라인→타깃 순 삽입, 실패 시 해당 run 의 삽입 id 로 즉시 원복 가능
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { buildBackfillPlan } from "./preview-tester-line-open-backfill";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const MARKER = "tester-backfill-20260604";
const LOG_PATH = "claudedocs/tester-backfill-20260604-inserted.json";

const APPLY = process.argv.includes("--apply");
const pilotIdx = process.argv.indexOf("--pilot");
const PILOT_USER = pilotIdx >= 0 ? process.argv[pilotIdx + 1] : null;

const CAL_TITLE =
  "관심있는 산업/직무 분야에서 정보를 얻을 수 있는 어떤 일정들이 있을까? 내 성장을 플래닝하기!";
const CAL_LINKS = [
  { url: "https://cafe.naver.com/oranke/24106", label: "[캘린더] 라인 진행 장소" },
  {
    url: "https://peppermint-geese-bc8.notion.site/ORANKALENDAR-152de44d123881a08538f2e19002da0b?pvs=4",
    label: "[캘린더] 클럽 공식 캘린더",
  },
];

function isoPlus(dateStr: string, days: number, hours: number): string {
  const ms = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  return new Date(ms + days * 86_400_000 + hours * 3_600_000).toISOString();
}

async function main() {
  const mode = PILOT_USER ? `PILOT(${PILOT_USER})` : APPLY ? "APPLY(전수)" : "DRY-RUN";
  console.log(`모드: ${mode}`);

  const plan = await buildBackfillPlan(PILOT_USER ? { onlyUserId: PILOT_USER } : {});
  const weeks = [...plan.byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const targetCount = plan.totalTargetInserts;
  const newLineWeeks = weeks.filter(([, v]) => !v.reuseLineId);
  console.log(
    `계획: 주차 ${weeks.length} | 타깃 INSERT ${targetCount} | 신규 라인 ${newLineWeeks.length} | 중복 제외 ${plan.dedupSkipped.length}`,
  );

  if (!PILOT_USER && !APPLY) {
    console.log("(dry-run — DB 변경 없음. --pilot <userId> 또는 --apply 로 실행)");
    return;
  }

  const insertedLines: { weekStart: string; id: string }[] = [];
  const insertedTargets: string[] = [];

  // 1) 신규 더미 info 라인 (그 주차에 active info 라인이 전혀 없는 경우만)
  for (const [ws, v] of newLineWeeks) {
    const { data, error } = await sb
      .from("cluster4_lines")
      .insert({
        part_type: "info",
        main_title: CAL_TITLE,
        activity_type_id: "calendar",
        // recurring=true 는 excel source 제약(cluster4_lines_recurring_content_source_check)에
        // 걸리므로 더미는 단발성(false)으로 생성한다.
        is_recurring_content: false,
        output_link_1: CAL_LINKS[0].url,
        output_links: CAL_LINKS,
        recognition_mode: "legacy_allowed",
        submission_opens_at: isoPlus(ws, -1, 15),
        submission_closes_at: isoPlus(ws, 2, 13),
        is_active: true,
        week_id: v.weekId,
        source_file_name: MARKER,
        created_by: ADMIN_ID,
        updated_by: ADMIN_ID,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`라인 INSERT 실패 (${ws}): ${error?.message}`);
    insertedLines.push({ weekStart: ws, id: data.id });
    v.reuseLineId = data.id; // 타깃 INSERT 에서 사용
    console.log(`  + line ${ws} → ${data.id}`);
  }

  // 2) 타깃 INSERT (배치 200)
  const rows: any[] = [];
  for (const [, v] of weeks) {
    for (const uid of v.testers) {
      rows.push({
        line_id: v.reuseLineId,
        week_id: v.weekId,
        target_mode: "user",
        target_user_id: uid,
        target_rule: {},
        created_by: ADMIN_ID,
        updated_by: ADMIN_ID,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { data, error } = await sb.from("cluster4_line_targets").insert(batch).select("id");
    if (error) {
      console.error(`타깃 배치 ${i} 실패: ${error.message} — 지금까지 삽입분을 로그에 기록합니다.`);
      break;
    }
    insertedTargets.push(...((data ?? []) as any[]).map((r) => r.id));
    console.log(`  + targets ${i + batch.length}/${rows.length}`);
  }

  // 3) 삽입 로그 append (원복 키)
  const log = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, "utf8")) : { runs: [] };
  log.runs.push({
    runAt: new Date().toISOString(),
    mode,
    lineInserts: insertedLines,
    targetInsertIds: insertedTargets,
    plannedTargets: targetCount,
    insertedTargets: insertedTargets.length,
  });
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  console.log(`로그 기록: ${LOG_PATH} (lines=${insertedLines.length}, targets=${insertedTargets.length})`);

  // 4) snapshot 재계산 (대상 테스터만)
  const affected = [...new Set(weeks.flatMap(([, v]) => v.testers))];
  console.log(`snapshot 재계산: ${affected.length}명 ...`);
  const res = await recomputeWeeklyCardsSnapshotsForUsers(affected, { concurrency: 4 });
  console.log("snapshot 재계산 결과:", JSON.stringify(res));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
