/**
 * 테스터 실무경험 success 백필 v13 실행기 — preview-tester-exp-success-backfill.ts 플랜 실행.
 * 식별자: tester-experience-success-backfill-v13-20260604
 *
 *   npx tsx --env-file=.env.local scripts/apply-tester-exp-success-backfill.ts                  # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-tester-exp-success-backfill.ts --pilot <userId> # 1명 실반영
 *   npx tsx --env-file=.env.local scripts/apply-tester-exp-success-backfill.ts --apply          # 전수 실반영
 *
 * 안전장치:
 *   - 전체 플랜 상한(라인 189 / 타깃 1824 / uws 608) 초과 시 즉시 중단
 *   - 라인 dedup: 마커 라인 (master_id, week_id) 기존 존재 시 재사용(파일럿→전수 멱등)
 *   - 타깃 dedup: (tester, week) 기존 experience 타깃 / 동일 (line,week,user) 존재 시 skip
 *   - uws: status='fail' 행만 success 로 (가드 .eq), 변경 (user,week) 전량 로그
 *   - 삽입/변경 전량 claudedocs/tester-experience-success-backfill-v13-20260604-inserted.json
 *   - snapshot 재계산: 영향 테스터만 (실유저 재계산 금지)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { buildExpPlan, MARKER } from "./preview-tester-exp-success-backfill";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const LOG_PATH = "claudedocs/tester-experience-success-backfill-v13-20260604-inserted.json";
const CAPS = { lines: 189, targets: 1824, uws: 608 };

const APPLY = process.argv.includes("--apply");
const pilotIdx = process.argv.indexOf("--pilot");
const PILOT_USER = pilotIdx >= 0 ? process.argv[pilotIdx + 1] : null;

function isoPlus(dateStr: string, days: number, hours: number): string {
  const ms = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  return new Date(ms + days * 86_400_000 + hours * 3_600_000).toISOString();
}

async function main() {
  const mode = PILOT_USER ? `PILOT(${PILOT_USER})` : APPLY ? "APPLY(전수)" : "DRY-RUN";
  console.log("모드:", mode, "| 마커:", MARKER);

  // 전체 플랜으로 상한 검증 (파일럿이어도 전체 플랜이 상한 내인지 확인)
  const fullPlan = await buildExpPlan();
  if (
    fullPlan.totalLines > CAPS.lines ||
    fullPlan.totalTargets > CAPS.targets ||
    fullPlan.totalUwsUpdates > CAPS.uws
  ) {
    console.error(
      `상한 초과 — 중단. plan(lines=${fullPlan.totalLines}, targets=${fullPlan.totalTargets}, uws=${fullPlan.totalUwsUpdates}) caps=${JSON.stringify(CAPS)}`,
    );
    process.exit(2);
  }
  console.log(
    `전체 플랜: lines=${fullPlan.totalLines} targets=${fullPlan.totalTargets} uws=${fullPlan.totalUwsUpdates} (상한 내 ✓)`,
  );

  const plan = PILOT_USER ? await buildExpPlan({ onlyUserId: PILOT_USER }) : fullPlan;
  if (PILOT_USER) {
    console.log(
      `파일럿 플랜: 주차 ${plan.selection.get(PILOT_USER)?.length ?? 0} | lines≤${plan.totalLines} targets=${plan.totalTargets} uws=${plan.totalUwsUpdates}`,
    );
  }
  if (!PILOT_USER && !APPLY) {
    console.log("(dry-run — DB 변경 없음)");
    return;
  }

  // ── 1) 라인 인스턴스 생성 (dedup: 마커 라인 (master,week) 재사용) ──
  const { data: existingMarkerLines } = await sb
    .from("cluster4_lines")
    .select("id, experience_line_master_id, week_id")
    .eq("source_file_name", MARKER);
  const lineIdByMasterWeek = new Map<string, string>();
  for (const l of (existingMarkerLines ?? []) as any[]) {
    lineIdByMasterWeek.set(`${l.experience_line_master_id}|${l.week_id}`, l.id);
  }

  const insertedLines: { org: string; weekStart: string; slot: number; id: string }[] = [];
  // (org|weekStart) → slot → line_id
  const lineIdByOrgWeekSlot = new Map<string, string>();
  for (const [, lp] of plan.linePlan) {
    for (const slot of lp.slots) {
      const master = plan.masterByOrgSlot.get(`${lp.org}:${slot}`);
      if (!master) throw new Error(`마스터 없음: ${lp.org}:${slot}`);
      const dedupKey = `${master.id}|${lp.weekId}`;
      let lineId: string | undefined = lineIdByMasterWeek.get(dedupKey);
      if (lineId === undefined) {
        const { data, error } = await sb
          .from("cluster4_lines")
          .insert({
            part_type: "experience",
            experience_line_master_id: master.id,
            line_code: master.line_code,
            main_title: master.title,
            submission_opens_at: isoPlus(lp.weekStart, -1, 15),
            submission_closes_at: isoPlus(lp.weekStart, 2, 13),
            is_active: true,
            week_id: lp.weekId,
            source_file_name: MARKER,
            created_by: ADMIN_ID,
            updated_by: ADMIN_ID,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(`라인 INSERT 실패 (${lp.org} ${lp.weekStart} s${slot}): ${error?.message}`);
        lineId = data.id as string;
        lineIdByMasterWeek.set(dedupKey, lineId);
        insertedLines.push({ org: lp.org, weekStart: lp.weekStart, slot, id: lineId });
      }
      lineIdByOrgWeekSlot.set(`${lp.org}|${lp.weekStart}|${slot}`, lineId);
    }
  }
  console.log(`라인: 신규 ${insertedLines.length} / 재사용 ${lineIdByOrgWeekSlot.size - insertedLines.length}`);

  // ── 2) 타깃 INSERT (배치, NOT EXISTS 동등 가드: 사전 존재쌍 재조회) ──
  const weekIdByStart = new Map(plan.candidateWeeks.map((w) => [w.start, w.weekId]));
  const rows: any[] = [];
  for (const [uid, weeksSel] of plan.selection) {
    const org = plan.testers.get(uid)!.org;
    for (const wsd of weeksSel) {
      for (const slot of [1, 2, 3]) {
        rows.push({
          line_id: lineIdByOrgWeekSlot.get(`${org}|${wsd}|${slot}`),
          week_id: weekIdByStart.get(wsd),
          target_mode: "user",
          target_user_id: uid,
          target_rule: {},
          created_by: ADMIN_ID,
          updated_by: ADMIN_ID,
        });
      }
    }
  }
  // 동일 (line,week,user) 기존 행 제거 (파일럿→전수 멱등)
  const lineIds = [...new Set(rows.map((r) => r.line_id))];
  const existingTriples = new Set<string>();
  for (let i = 0; i < lineIds.length; i += 50) {
    const { data } = await sb
      .from("cluster4_line_targets")
      .select("line_id, week_id, target_user_id")
      .in("line_id", lineIds.slice(i, i + 50));
    for (const t of (data ?? []) as any[]) {
      existingTriples.add(`${t.line_id}|${t.week_id}|${t.target_user_id}`);
    }
  }
  const newRows = rows.filter((r) => !existingTriples.has(`${r.line_id}|${r.week_id}|${r.target_user_id}`));

  const insertedTargets: string[] = [];
  for (let i = 0; i < newRows.length; i += 200) {
    const batch = newRows.slice(i, i + 200);
    const { data, error } = await sb.from("cluster4_line_targets").insert(batch).select("id");
    if (error) throw new Error(`타깃 배치 ${i} 실패: ${error.message}`);
    insertedTargets.push(...((data ?? []) as any[]).map((r) => r.id));
    console.log(`  + targets ${i + batch.length}/${newRows.length}`);
  }

  // ── 3) uws fail → success 보정 (선택 쌍만, status='fail' 가드) ──
  const uwsFlipped: { userId: string; weekStart: string }[] = [];
  for (const [uid, weeksSel] of plan.selection) {
    for (const wsd of weeksSel) {
      const { data, error } = await sb
        .from("user_week_statuses")
        .update({ status: "success", updated_at: new Date().toISOString() })
        .eq("user_id", uid)
        .eq("week_start_date", wsd)
        .eq("status", "fail") // 가드: fail 행만. rest/success 불변
        .select("user_id");
      if (error) throw new Error(`uws 보정 실패 (${uid} ${wsd}): ${error.message}`);
      if (data && data.length > 0) uwsFlipped.push({ userId: uid, weekStart: wsd });
    }
  }
  console.log(`uws success 보정: ${uwsFlipped.length} row`);

  // ── 4) 로그 ──
  const log = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, "utf8")) : { marker: MARKER, runs: [] };
  log.runs.push({
    runAt: new Date().toISOString(),
    mode,
    lineInserts: insertedLines,
    targetInsertIds: insertedTargets,
    uwsFlipped,
  });
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  console.log(`로그: ${LOG_PATH} (lines=${insertedLines.length}, targets=${insertedTargets.length}, uws=${uwsFlipped.length})`);

  // ── 5) snapshot 재계산 (영향 테스터만) ──
  const affected = [...plan.selection.keys()];
  console.log(`snapshot 재계산: ${affected.length}명 ...`);
  const res = await recomputeWeeklyCardsSnapshotsForUsers(affected, { concurrency: 4 });
  console.log("snapshot 결과:", JSON.stringify(res));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
