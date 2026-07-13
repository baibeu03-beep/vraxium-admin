// Point C 비대상자 소급 지급(1회성 backfill) — 과거 버그로 누락된 C 만 보완(additive).
//   run(dry-run·기본): npx tsx --env-file=.env.local scripts/backfill-point-c-unselected.ts [--org=..] [--mode=operating|test] [--ids=uuid,..] [--limit=500]
//   apply           : ... scripts/backfill-point-c-unselected.ts --apply
//   rollback        : ... scripts/backfill-point-c-unselected.ts --rollback
//
//   ⚠ 순수 additive — 기존 A/B 원장 무변경 · 삭제 없음 · 이미 지급(원장 존재)분 dedup 스킵.
//   판정 로직 = 전방 적립과 동일(computeRegularUnselectedCBackfill=computeDesiredAwards). operating/test 공통.
//   apply 시 백업(claudedocs/backfill-point-c-unselected-backup.json) → rollback 복원 가능.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  computeRegularUnselectedCBackfill,
  applyRegularUnselectedCBackfill,
  recomputeWeeklyPointsForUsers,
  type RegularUnselectedCBackfill,
} from "@/lib/processPointAccrual";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const BACKUP = "claudedocs/backfill-point-c-unselected-backup.json";
const J = (o: unknown) => JSON.stringify(o);

const arg = (n: string): string | null => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const flag = (n: string) => process.argv.includes(`--${n}`);

type BackupEntry = { statusId: string; weekId: string; org: string | null; mode: string; hub: string | null; year: number; week_number: number; pointPenalty: number; userIds: string[] };

async function collectStatusIds(): Promise<string[]> {
  const ids = arg("ids");
  if (ids) return ids.split(",").map((s) => s.trim()).filter(Boolean);
  let q = sb.from("process_check_statuses").select("id,organization_slug,scope_mode").eq("status", "completed").limit(Math.min(Number(arg("limit") ?? "1000"), 5000));
  const org = arg("org"), mode = arg("mode");
  if (org) q = q.eq("organization_slug", org);
  if (mode) q = q.eq("scope_mode", mode);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

async function dryRun() {
  const statusIds = await collectStatusIds();
  console.log(`\nPoint C backfill — DRY-RUN · 완료 정규 체크 ${statusIds.length}건 스캔${arg("org") ? ` · org=${arg("org")}` : ""}${arg("mode") ? ` · mode=${arg("mode")}` : ""}\n`);
  console.log(["statusId".padEnd(38), "org".padEnd(9), "mode".padEnd(10), "hub".padEnd(11), "Cval", "roster", "perf", "unsel", "이미C", "신규C"].join(" | "));
  console.log("-".repeat(128));

  let targetChecks = 0, totalRoster = 0, totalPerf = 0, totalUnsel = 0, totalMissing = 0, totalDup = 0;
  const byMode: Record<string, { checks: number; missing: number }> = {};
  const skips: Record<string, number> = {};
  const operatingRows: string[] = [];
  for (const id of statusIds) {
    let p: RegularUnselectedCBackfill;
    try { p = await computeRegularUnselectedCBackfill(id); }
    catch (e) { console.log(`${id}  ✗ error: ${(e as Error).message}`); continue; }
    if ("skipped" in p && p.skipped) { skips[p.reason] = (skips[p.reason] ?? 0) + 1; continue; }
    const pv = p as Extract<RegularUnselectedCBackfill, { skipped?: false }>;
    if (pv.missingCUserIds.length === 0) { totalDup += pv.alreadyLedgeredCount; continue; } // 지급할 신규 없음(전부 이미 지급 or 비대상자 0)
    targetChecks++;
    totalRoster += pv.rosterCount; totalPerf += pv.performerCount; totalUnsel += pv.unselectedCount;
    totalMissing += pv.missingCUserIds.length; totalDup += pv.alreadyLedgeredCount;
    byMode[pv.mode] = byMode[pv.mode] ?? { checks: 0, missing: 0 };
    byMode[pv.mode].checks++; byMode[pv.mode].missing += pv.missingCUserIds.length;
    const line = [
      pv.statusId.padEnd(38), String(pv.org ?? "-").padEnd(9), pv.mode.padEnd(10), String(pv.hub ?? "-").padEnd(11),
      String(pv.effectivePenaltyUnselected).padStart(4), String(pv.rosterCount).padStart(6), String(pv.performerCount).padStart(4),
      String(pv.unselectedCount).padStart(5), String(pv.alreadyLedgeredCount).padStart(5), String(pv.missingCUserIds.length).padStart(5),
    ].join(" | ");
    console.log(line);
    if (pv.mode === "operating") operatingRows.push(line);
  }
  console.log("-".repeat(128));
  if (operatingRows.length) {
    console.log(`\n⚠ 운영(operating·실사용자) 대상 ${operatingRows.length}건 — 실제 패널티 지급 대상:`);
    for (const l of operatingRows) console.log("  " + l);
  }
  console.log(`\n[요약 — 보고]`);
  console.log(`  1) Backfill 대상 체크 수(신규 C 지급 있는 체크): ${targetChecks}`);
  console.log(`  2) 체크별 전체 대상자 수 합계(roster): ${totalRoster}`);
  console.log(`  3) 수행자 수 합계(performers): ${totalPerf}`);
  console.log(`  4) Point C 지급 대상 인원 합계(unselected): ${totalUnsel}`);
  console.log(`  5) 실제 신규 지급 예정 원장 수(missing C): ${totalMissing}`);
  console.log(`  6) 중복(이미 원장 존재)으로 건너뛸 비대상자 수: ${totalDup}`);
  console.log(`  · 모드별: ${J(byMode)}`);
  console.log(`  · 스킵 사유: ${J(skips)}`);
  console.log(`\n(DRY-RUN — 원장/포인트 무변경. 실제 실행: --apply)\n`);
}

async function apply() {
  const statusIds = await collectStatusIds();
  console.log(`\nPoint C backfill — APPLY · ${statusIds.length}건 스캔\n`);
  const backup: BackupEntry[] = [];
  let targetChecks = 0, inserted = 0, dup = 0;
  const affected = new Set<string>();
  for (const id of statusIds) {
    const res = await applyRegularUnselectedCBackfill(id);
    if ("skipped" in res && res.skipped) continue;
    const r = res as Exclude<typeof res, { skipped: true }>;
    dup += r.skippedDuplicate;
    if (r.inserted === 0) continue;
    targetChecks++; inserted += r.inserted;
    for (const u of r.affectedUserIds) affected.add(u);
    const first = r.insertedRows[0];
    backup.push({ statusId: r.statusId, weekId: r.weekId, org: null, mode: "", hub: null, year: first.year, week_number: first.week_number, pointPenalty: first.point_penalty, userIds: r.affectedUserIds });
    console.log(`  ✓ ${id} → +${r.inserted} C (dup skip ${r.skippedDuplicate})`);
  }
  writeFileSync(BACKUP, JSON.stringify({ createdAt: new Date().toISOString(), entries: backup }, null, 2));
  console.log(`\n[APPLY 결과]`);
  console.log(`  1) Backfill 대상 체크 수: ${targetChecks}`);
  console.log(`  2) 신규 생성된 Point C 원장 수: ${inserted}`);
  console.log(`  3) 중복으로 건너뛴 건수: ${dup}`);
  console.log(`  4) uwp 재계산·snapshot 무효화 대상 사용자 수: ${affected.size}`);
  console.log(`  · 백업: ${BACKUP} (rollback 복원용)`);
  console.log(`\n(APPLY 완료)\n`);
}

async function rollback() {
  if (!existsSync(BACKUP)) { console.error(`백업 없음: ${BACKUP}`); process.exit(1); }
  const { entries } = JSON.parse(readFileSync(BACKUP, "utf8")) as { entries: BackupEntry[] };
  console.log(`\nPoint C backfill — ROLLBACK · ${entries.length}건 복원\n`);
  let deleted = 0; const affected = new Set<string>();
  for (const e of entries) {
    // 백필로 넣은 C 행만 삭제(0/0/pp) — A/B 원장 보존.
    const { data, error } = await sb.from("process_point_awards").delete()
      .eq("source", "regular").eq("ref_id", e.statusId).in("user_id", e.userIds)
      .eq("point_check", 0).eq("point_advantage", 0)
      .select("user_id");
    if (error) { console.log(`  ✗ ${e.statusId}: ${error.message}`); continue; }
    const n = (data ?? []).length; deleted += n;
    for (const u of e.userIds) affected.add(u);
    await recomputeWeeklyPointsForUsers(e.userIds, e.weekId);
    console.log(`  ✓ ${e.statusId} → -${n} C 회수`);
  }
  console.log(`\n[ROLLBACK 결과] 회수 원장 ${deleted} · 재계산 사용자 ${affected.size}\n`);
}

async function main() {
  if (flag("rollback")) return rollback();
  if (flag("apply")) return apply();
  return dryRun();
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e?.stack ?? e?.message ?? e); process.exit(1); });
