/**
 * 봄 시즌(2026-spring) W1~W13 테스트 개설 라인 정리 — 실행기.
 *
 *   npx tsx --env-file=.env.local scripts/apply-test-line-cleanup-spring.ts            # 검증만(기본, DB 변경 없음)
 *   npx tsx --env-file=.env.local scripts/apply-test-line-cleanup-spring.ts --apply    # 실제 삭제
 *
 * 대상 = claudedocs/diag-test-line-cleanup-2026spring-candidates.json 의 81건(불변).
 * 안전장치: 라인별 실유저 타깃 0 재검증 / MIXED 10건 비포함 / 백업 / 삭제 후 카운트·direct 검증.
 * 삭제 순서: evaluations → submissions → targets → lines → snapshot 재계산.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { getCluster4LineDetailForProfileUser } from "@/lib/cluster4LinesData";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const APPLY = process.argv.includes("--apply");
const CANDIDATES_PATH = "claudedocs/diag-test-line-cleanup-2026spring-candidates.json";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP_PATH = `claudedocs/rollback-test-line-cleanup-2026spring-${stamp}.json`;

function die(msg: string): never {
  console.error(`\n❌ 중단: ${msg}`);
  process.exit(1);
}

async function selectIn<T>(table: string, select: string, col: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    if (!chunk.length) continue;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from(table)
        .select(select)
        .in(col, chunk)
        .order(col, { ascending: true })
        .range(from, from + 999);
      if (error) die(`${table}.${col} select: ${error.message}`);
      const batch = (data ?? []) as T[];
      out.push(...batch);
      if (batch.length < 1000) break;
    }
  }
  return out;
}

async function main() {
  console.log(`모드: ${APPLY ? "APPLY(실삭제)" : "DRY-RUN(검증만)"}\n`);

  // ── 후보 로드 ─────────────────────────────────────────────────────────
  const json = JSON.parse(readFileSync(CANDIDATES_PATH, "utf8"));
  const candidateLineIds: string[] = json.candidateLineIds;
  const jsonTargetIds: string[] = json.candidateTargetIds;
  const jsonAffected: string[] = json.affectedUserIds;
  const mixedIds: string[] = json.mixedOperatingLineIds;

  if (candidateLineIds.length !== 81) die(`JSON 후보 라인 ${candidateLineIds.length} ≠ 81`);
  console.log(`[safety#2] JSON 후보: lines=${candidateLineIds.length}, targets=${jsonTargetIds.length}, mixed=${mixedIds.length}`);

  // ── safety#4: 후보 ∩ MIXED = ∅ ────────────────────────────────────────
  const mixedSet = new Set(mixedIds);
  const overlap = candidateLineIds.filter((id) => mixedSet.has(id));
  if (overlap.length) die(`MIXED 운영라인이 후보에 포함됨: ${overlap.join(",")}`);
  console.log(`[safety#4] MIXED 10건 후보 비포함 ✅`);

  // ── 라이브 DB 재조회 ──────────────────────────────────────────────────
  const testIds = await fetchTestUserMarkerIds();
  const lines = await selectIn<{ id: string; part_type: string; is_active: boolean; main_title: string }>(
    "cluster4_lines", "id,part_type,is_active,main_title", "id", candidateLineIds,
  );
  if (lines.length !== 81) die(`라이브 라인 ${lines.length} ≠ 81 (이미 일부 삭제?)`);

  // 후보 라인의 실제 타깃(라이브) — 전수.
  const targets = await selectIn<{ id: string; line_id: string; week_id: string; target_mode: string; target_user_id: string | null }>(
    "cluster4_line_targets", "id,line_id,week_id,target_mode,target_user_id", "line_id", candidateLineIds,
  );
  const userTargets = targets.filter((t) => t.target_mode === "user");
  const liveTargetIds = userTargets.map((t) => t.id);

  // ── safety#3: 실유저 타깃 0 재검증 ────────────────────────────────────
  const realTargets = userTargets.filter((t) => !t.target_user_id || !testIds.has(t.target_user_id));
  if (realTargets.length) {
    die(`실유저 타깃 ${realTargets.length}건 발견 — 삭제 금지. lines=${[...new Set(realTargets.map((t) => t.line_id))].join(",")}`);
  }
  console.log(`[safety#3] 후보 라인 타깃 전수 ${userTargets.length}건 모두 테스트유저 (실유저 0) ✅`);

  // 타깃 집합 JSON 대조.
  const liveSet = new Set(liveTargetIds), jsonSet = new Set(jsonTargetIds);
  const tDiff = [...liveSet].filter((x) => !jsonSet.has(x)).concat([...jsonSet].filter((x) => !liveSet.has(x)));
  if (tDiff.length) console.log(`   ⚠ 타깃 집합 JSON 차이 ${tDiff.length}건(라이브 기준으로 진행): ${tDiff.slice(0, 5).join(",")}`);
  else console.log(`   타깃 ${liveTargetIds.length}건 JSON 일치 ✅`);

  // 자식: 제출 / 평가(전수, line_target_id 기준).
  const submissions = await selectIn<{ id: string; line_target_id: string; user_id: string }>(
    "cluster4_line_submissions", "id,line_target_id,user_id", "line_target_id", liveTargetIds,
  );
  const evaluations = await selectIn<{ id: string; line_target_id: string; user_id: string }>(
    "cluster4_experience_line_evaluations", "id,line_target_id,user_id", "line_target_id", liveTargetIds,
  );
  const subReal = submissions.filter((s) => !testIds.has(s.user_id));
  const evalReal = evaluations.filter((e) => !testIds.has(e.user_id));
  if (subReal.length) die(`제출 중 실유저 ${subReal.length}건 — 삭제 금지`);
  if (evalReal.length) die(`평가 중 실유저 ${evalReal.length}건 — 삭제 금지`);
  console.log(`[safety#3] 제출 ${submissions.length}건·평가 ${evaluations.length}건 모두 테스트유저 (실유저 0) ✅`);

  const affectedUsers = [...new Set(userTargets.map((t) => t.target_user_id).filter(Boolean) as string[])];
  console.log(`\n삭제 계획:`);
  console.log(`  cluster4_experience_line_evaluations : ${evaluations.length}`);
  console.log(`  cluster4_line_submissions            : ${submissions.length}`);
  console.log(`  cluster4_line_targets                : ${userTargets.length}`);
  console.log(`  cluster4_lines                       : ${lines.length}`);
  console.log(`  snapshot 재계산 대상 테스트유저       : ${affectedUsers.length}`);

  if (!APPLY) {
    console.log(`\n(DRY-RUN — DB 변경 없음. --apply 로 실행)`);
    return;
  }

  // ── safety#5: 롤백 백업(삭제 직전, 전체 컬럼) ─────────────────────────
  const [linesFull, targetsFull, subsFull, evalsFull] = await Promise.all([
    selectIn<any>("cluster4_lines", "*", "id", candidateLineIds),
    selectIn<any>("cluster4_line_targets", "*", "id", liveTargetIds),
    selectIn<any>("cluster4_line_submissions", "*", "line_target_id", liveTargetIds),
    selectIn<any>("cluster4_experience_line_evaluations", "*", "line_target_id", liveTargetIds),
  ]);
  writeFileSync(BACKUP_PATH, JSON.stringify({
    createdAt: new Date().toISOString(),
    season: "2026-spring", weekRange: "W1..W13",
    note: "rollback backup — re-insert in reverse order: lines→targets→submissions→evaluations",
    counts: { lines: linesFull.length, targets: targetsFull.length, submissions: subsFull.length, evaluations: evalsFull.length },
    affectedUserIds: affectedUsers,
    cluster4_lines: linesFull,
    cluster4_line_targets: targetsFull,
    cluster4_line_submissions: subsFull,
    cluster4_experience_line_evaluations: evalsFull,
  }, null, 2));
  console.log(`\n[safety#5] 롤백 백업 기록: ${BACKUP_PATH}`);

  // ── 삭제 (자식 → 부모) ───────────────────────────────────────────────
  async function del(table: string, col: string, ids: string[]): Promise<number> {
    let n = 0;
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      if (!chunk.length) continue;
      const { error, count } = await sb.from(table).delete({ count: "exact" }).in(col, chunk);
      if (error) die(`${table} delete: ${error.message}`);
      n += count ?? 0;
    }
    return n;
  }
  const delEval = await del("cluster4_experience_line_evaluations", "line_target_id", liveTargetIds);
  console.log(`  ✓ evaluations 삭제: ${delEval}`);
  const delSub = await del("cluster4_line_submissions", "line_target_id", liveTargetIds);
  console.log(`  ✓ submissions 삭제: ${delSub}`);
  const delTgt = await del("cluster4_line_targets", "id", liveTargetIds);
  console.log(`  ✓ targets 삭제: ${delTgt}`);
  const delLine = await del("cluster4_lines", "id", candidateLineIds);
  console.log(`  ✓ lines 삭제: ${delLine}`);

  // ── safety#6: 삭제 후 카운트 재검증(전부 0) ──────────────────────────
  const [remLines, remTargets, remSubs, remEvals] = await Promise.all([
    selectIn<any>("cluster4_lines", "id", "id", candidateLineIds),
    selectIn<any>("cluster4_line_targets", "id", "id", liveTargetIds),
    selectIn<any>("cluster4_line_submissions", "id", "line_target_id", liveTargetIds),
    selectIn<any>("cluster4_experience_line_evaluations", "id", "line_target_id", liveTargetIds),
  ]);
  const leftover = remLines.length + remTargets.length + remSubs.length + remEvals.length;
  if (leftover) die(`삭제 후 잔존 행 ${leftover} (lines=${remLines.length},targets=${remTargets.length},subs=${remSubs.length},evals=${remEvals.length})`);
  console.log(`\n[safety#6] 삭제 후 잔존 0 (lines/targets/subs/evals 전부 삭제 확인) ✅`);

  // ── safety#11: MIXED 10건 보존 확인 ──────────────────────────────────
  const mixedAfter = await selectIn<{ id: string; is_active: boolean }>("cluster4_lines", "id,is_active", "id", mixedIds);
  if (mixedAfter.length !== 10) die(`MIXED 보존 실패: ${mixedAfter.length}/10`);
  console.log(`[safety#11] MIXED 운영라인 10건 전부 보존(is_active 불변) ✅`);

  // ── safety#10: snapshot 재계산 ───────────────────────────────────────
  console.log(`\n[safety#10] snapshot 재계산: ${affectedUsers.length}명 ...`);
  const snapRes = await recomputeWeeklyCardsSnapshotsForUsers(affectedUsers, { concurrency: 3 });
  console.log(`  결과: requested=${snapRes.requested} recomputed=${snapRes.recomputed} failed=${snapRes.failed}`);
  if (snapRes.failed) console.log(`  ⚠ 실패 유저(stale 잔존, lazy 보정): ${snapRes.failedUserIds.join(",")}`);

  // ── safety#7: 삭제 후 direct function 검증(샘플) ─────────────────────
  console.log(`\n[safety#7] direct function 재조회(삭제된 (user,week,part) → void 기대):`);
  const probes = targetsFull.slice(0, 6).map((t: any) => {
    const line = linesFull.find((l: any) => l.id === t.line_id);
    return { user: t.target_user_id, week: t.week_id, part: line?.part_type };
  }).filter((p: any) => p.user && p.week && p.part);
  let voidOk = 0;
  for (const p of probes) {
    const detail = await getCluster4LineDetailForProfileUser(p.user, p.week, p.part);
    const isVoid = detail.status === "void" && detail.line === null;
    if (isVoid) voidOk++;
    console.log(`   user=${String(p.user).slice(0, 8)} week=${String(p.week).slice(0, 8)} ${p.part}: status=${detail.status} ${isVoid ? "✅void" : "❌"}`);
  }
  console.log(`   void 확인 ${voidOk}/${probes.length}`);

  // 결과 요약 + 파일 기록.
  const summary = {
    appliedAt: new Date().toISOString(),
    deleted: { cluster4_lines: delLine, cluster4_line_targets: delTgt, cluster4_line_submissions: delSub, cluster4_experience_line_evaluations: delEval },
    snapshotRecomputed: snapRes,
    mixedPreserved: mixedAfter.length,
    realUserImpact: 0,
    backupPath: BACKUP_PATH,
    affectedUserIds: affectedUsers,
  };
  writeFileSync(`claudedocs/apply-test-line-cleanup-2026spring-result.json`, JSON.stringify(summary, null, 2));
  console.log(`\n✅ 완료. 요약: claudedocs/apply-test-line-cleanup-2026spring-result.json`);
  console.log(JSON.stringify(summary.deleted, null, 2));
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
