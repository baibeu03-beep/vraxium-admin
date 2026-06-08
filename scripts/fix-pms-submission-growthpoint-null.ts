/**
 * PMS 이관 [통합] 제출 growth_point → NULL 보정 (2026-06-07 정책).
 *   npx tsx --env-file=.env.local scripts/fix-pms-submission-growthpoint-null.ts            # preview
 *   npx tsx --env-file=.env.local scripts/fix-pms-submission-growthpoint-null.ts --apply
 *   npx tsx --env-file=.env.local scripts/fix-pms-submission-growthpoint-null.ts --rollback <runlog>
 *
 * 정책: PMS 이관 제출은 growth_point 미저장. 기존 수동/네이티브 제출은 미접촉.
 * 식별(이관 제출): user.source_system 보유 ∧ 제출이 [통합] 마스터 라인 타깃 ∧
 *   growth_point != null. (이관 스크립트가 growth_point=subtitle 로 넣었던 분)
 *   ⚠ 안전: source_system 사용자의 [통합] 제출만 — Vraxium-native 제출은 source_system
 *   사용자라도 [통합] 라인이면 이관분이므로 동일 정책 적용 대상(이관 계약상 [통합]=PMS 이관).
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK_FILE = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK_FILE ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/fix-growthpoint-null-${MODE}-${STAMP}.json`;
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

async function fetchAll<T>(table: string, select: string, order: string, filt?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = sb.from(table).select(select).order(order, { ascending: true }).range(from, from + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const issues: string[] = [];
  for (const r of log.targets ?? []) {
    const { error } = await sb.from("cluster4_line_submissions")
      .update({ growth_point: r.prior }).eq("id", r.id).is("growth_point", null);
    if (error) issues.push(`${r.id}: ${error.message}`);
  }
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", restored: (log.targets ?? []).length, issues }, null, 1));
  console.log(issues.length ? issues.join("\n") : `rollback 완료 (${(log.targets ?? []).length}행 prior 복원)`);
  process.exit(issues.length ? 1 : 0);
}

async function main() {
  if (ROLLBACK_FILE) return rollback(ROLLBACK_FILE);
  // source_system 보유 사용자 (이관 사용자)
  const sourced = new Set(
    (await fetchAll<{ id: string; source_system: string | null }>("users", "id,source_system", "id"))
      .filter((u) => u.source_system != null).map((u) => u.id),
  );
  // [통합] 마스터 라인 → 타깃 → 제출 (growth_point != null)
  const { data: master } = await sb.from("cluster4_experience_line_masters").select("id").eq("line_name", "[통합] 주차 활동 내역").maybeSingle();
  const lines = await fetchAll<{ id: string }>("cluster4_lines", "id", "id", (q) => q.eq("experience_line_master_id", (master as any).id));
  const lineIds = new Set(lines.map((l) => l.id));
  const targets = await fetchAll<{ id: string; line_id: string; target_user_id: string | null }>(
    "cluster4_line_targets", "id,line_id,target_user_id", "id");
  const unifiedTargetIds = new Set(targets.filter((t) => lineIds.has(t.line_id) && t.target_user_id && sourced.has(t.target_user_id)).map((t) => t.id));

  const subs = await fetchAll<{ id: string; line_target_id: string; user_id: string; growth_point: string | null; subtitle: string | null }>(
    "cluster4_line_submissions", "id,line_target_id,user_id,growth_point,subtitle", "id");
  const targetsToFix = subs.filter((s) => unifiedTargetIds.has(s.line_target_id) && s.growth_point != null);

  console.log(`이관 사용자 ${sourced.size} | [통합] 이관 타깃 ${unifiedTargetIds.size} | growth_point 비NULL 제출 ${targetsToFix.length}`);
  const log: any = { mode: MODE, total: targetsToFix.length, targets: targetsToFix.map((s) => ({ id: s.id, user_id: s.user_id, prior: s.growth_point })), applied: 0, errors: [] };

  if (APPLY) {
    for (let i = 0; i < targetsToFix.length; i += 100) {
      const ids = targetsToFix.slice(i, i + 100).map((s) => s.id);
      const { data, error } = await sb.from("cluster4_line_submissions")
        .update({ growth_point: null }).in("id", ids).not("growth_point", "is", null).select("id");
      if (error) log.errors.push(`chunk ${i}: ${error.message}`);
      else log.applied += (data ?? []).length;
    }
    // 영향 사용자 snapshot 재계산
    const affected = [...new Set(targetsToFix.map((s) => s.user_id))];
    const { recomputeAndStoreWeeklyCardsSnapshot } = await import("@/lib/cluster4WeeklyCardsSnapshot");
    let snap = 0;
    for (const u of affected) { try { await recomputeAndStoreWeeklyCardsSnapshot(u); snap++; } catch (e) { log.errors.push(`snapshot ${u}: ${e}`); } }
    log.snapshotRecomputed = snap;
    log.affectedUsers = affected.length;
  }
  writeFileSync(OUT, JSON.stringify(log, null, 1));
  console.log(`mode=${MODE} | 대상 ${targetsToFix.length}${APPLY ? ` | applied ${log.applied} | snapshot ${log.snapshotRecomputed} | errors ${log.errors.length}` : ""}`);
  console.log("→", OUT);
  if (log.errors.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
