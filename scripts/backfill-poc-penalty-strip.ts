/**
 * 소급 교정 — 이행자(matched) 원장의 패널티 Po.C 제거 (A+C / B+C 동시 지급 해소).
 *   dry-run : npx tsx --env-file=.env.local scripts/backfill-poc-penalty-strip.ts
 *   apply   : npx tsx --env-file=.env.local scripts/backfill-poc-penalty-strip.ts --apply
 *   rollback: npx tsx --env-file=.env.local scripts/backfill-poc-penalty-strip.ts --rollback
 *
 * 정책(2026-07-04): process_point_awards 원장의 대상자는 전원 이행자(recipients match_type='matched').
 *   이행자는 Po.C(패널티)를 받지 않는다. 따라서 point_penalty>0 인 원장행은 모두 위반 → 0 으로 교정.
 * 교정 후: 영향 (user,year,week)의 user_weekly_points 를 원장 합으로 재계산 + weekly-card snapshot 무효화.
 *   (재계산은 processPointAccrual.recomputeWeeklyPoints 와 동일 로직 — 원장 SoT 합, 증분 아님.)
 * snapshot-only 구조 무변: DTO 버전/스키마 미변경. 데이터(원장·uwp) 값만 정책에 맞게 교정.
 * 백업: claudedocs/backfill-poc-penalty-strip-backup.json (id/old point_penalty). rollback 로 원복.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const ROLLBACK = process.argv.includes("--rollback");
const BACKUP = resolve(process.cwd(), "claudedocs", "backfill-poc-penalty-strip-backup.json");

type Row = {
  id: string; source: string; ref_id: string; user_id: string;
  year: number; week_number: number;
  point_check: number; point_advantage: number; point_penalty: number;
};

async function fetchAll(): Promise<Row[]> {
  const out: Row[] = [];
  const page = 1000; let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("process_point_awards")
      .select("id,source,ref_id,user_id,year,week_number,point_check,point_advantage,point_penalty")
      .order("id", { ascending: true }).range(from, from + page - 1);
    if (error) throw new Error("process_point_awards: " + error.message);
    const b = (data ?? []) as Row[]; out.push(...b);
    if (b.length < page) break; from += page;
  }
  return out;
}

// (user,year,week) 재계산 — 원장 합으로 user_weekly_points upsert(증분 금지). accrual 코어와 동일.
async function recomputeWeeklyPoints(pairs: Array<{ userId: string; year: number; week: number }>) {
  const seen = new Set<string>();
  for (const p of pairs) {
    const key = `${p.userId}:${p.year}:${p.week}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { data: ledger, error } = await supabaseAdmin
      .from("process_point_awards")
      .select("point_check,point_advantage,point_penalty")
      .eq("user_id", p.userId).eq("year", p.year).eq("week_number", p.week);
    if (error) throw error;
    const rows = (ledger ?? []) as { point_check: number; point_advantage: number; point_penalty: number }[];
    const points = rows.reduce((s, r) => s + (r.point_check || 0), 0);
    const advantages = rows.reduce((s, r) => s + (r.point_advantage || 0), 0);
    const penalty = rows.reduce((s, r) => s + (r.point_penalty || 0), 0);
    // week_start_date 보강(iso 키 → weeks).
    const { data: w } = await supabaseAdmin
      .from("weeks").select("start_date")
      .eq("iso_year", p.year).eq("iso_week", p.week).maybeSingle();
    const weekStartDate = (w as { start_date: string } | null)?.start_date ?? new Date().toISOString().slice(0, 10);
    const { error: upErr } = await supabaseAdmin.from("user_weekly_points").upsert(
      { user_id: p.userId, year: p.year, week_number: p.week, week_start_date: weekStartDate, points, advantages, penalty, checks_migrated: true },
      { onConflict: "user_id,year,week_number" },
    );
    if (upErr) throw upErr;
  }
}

async function main() {
  if (ROLLBACK) {
    const backup = JSON.parse(readFileSync(BACKUP, "utf8")) as Array<{ id: string; point_penalty: number; user_id: string; year: number; week_number: number }>;
    console.log(`[rollback] 백업 ${backup.length}건 원복`);
    for (const b of backup) {
      const { error } = await supabaseAdmin.from("process_point_awards").update({ point_penalty: b.point_penalty, updated_at: new Date().toISOString() }).eq("id", b.id);
      if (error) throw error;
    }
    await recomputeWeeklyPoints(backup.map((b) => ({ userId: b.user_id, year: b.year, week: b.week_number })));
    const users = Array.from(new Set(backup.map((b) => b.user_id)));
    const inv = await invalidateWeeklyCardsForUsers(users);
    console.log(`[rollback] 완료 — uwp 재계산 + snapshot 무효화(${inv.mode}, ${inv.count})`);
    return;
  }

  const all = await fetchAll();
  // 위반 = 패널티 C>0 이면서 보상(A 또는 B)도 함께 지급된 행(A+C·B+C). 순수 C(수동 미발생)는 보존.
  const penRows = all.filter((r) => (r.point_penalty ?? 0) > 0);
  const offenders = penRows.filter((r) => (r.point_check ?? 0) > 0 || (r.point_advantage ?? 0) > 0);
  const pureC = penRows.filter((r) => (r.point_check ?? 0) === 0 && (r.point_advantage ?? 0) === 0);
  console.log(`총 원장행 ${all.length} · penalty>0 ${penRows.length} · 위반(A/B+C) ${offenders.length} · 순수C보존 ${pureC.length}`);
  if (offenders.length === 0) { console.log("교정 대상 없음."); return; }

  const users = Array.from(new Set(offenders.map((r) => r.user_id)));
  const pairs = offenders.map((r) => ({ userId: r.user_id, year: r.year, week: r.week_number }));

  console.log("\n교정 대상(최대 40):");
  console.table(offenders.slice(0, 40).map((r) => ({
    source: r.source, ref: r.ref_id.slice(0, 8), user: r.user_id.slice(0, 8),
    yw: `${r.year}W${r.week_number}`, A: r.point_check, B: r.point_advantage,
    "C(→0)": r.point_penalty,
  })));

  // 교정 전 영향 uwp 스냅샷(검증 비교용).
  console.log("\n교정 전 영향 user_weekly_points:");
  const beforeKeys = Array.from(new Set(pairs.map((p) => `${p.userId}:${p.year}:${p.week}`)));
  for (const k of beforeKeys) {
    const [uid, y, w] = k.split(":");
    const { data } = await supabaseAdmin.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", uid).eq("year", Number(y)).eq("week_number", Number(w)).maybeSingle();
    const d = data as { points: number; advantages: number; penalty: number } | null;
    console.log(`  ${uid.slice(0, 8)} ${y}W${w}: points=${d?.points ?? "-"} adv=${d?.advantages ?? "-"} pen=${d?.penalty ?? "-"} (net=${(d?.advantages ?? 0) - (d?.penalty ?? 0)})`);
  }

  if (!APPLY) {
    console.log(`\n[DRY-RUN] --apply 로 실제 교정. 영향 유저 ${users.size ?? users.length}명 · 주차 ${new Set(pairs.map((p) => `${p.year}W${p.week}`)).size}종.`);
    return;
  }

  // 백업 저장.
  const backup = offenders.map((r) => ({ id: r.id, point_penalty: r.point_penalty, user_id: r.user_id, year: r.year, week_number: r.week_number }));
  writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n[apply] 백업 저장: ${BACKUP} (${backup.length}건)`);

  // 1) 원장 point_penalty=0.
  for (const r of offenders) {
    const { error } = await supabaseAdmin.from("process_point_awards").update({ point_penalty: 0, updated_at: new Date().toISOString() }).eq("id", r.id);
    if (error) throw error;
  }
  console.log(`[apply] 원장 ${offenders.length}행 point_penalty→0`);

  // 2) 영향 uwp 재계산(원장 합).
  await recomputeWeeklyPoints(pairs);
  console.log(`[apply] user_weekly_points 재계산 완료`);

  // 3) snapshot 무효화(≤threshold 면 즉시 재계산).
  const inv = await invalidateWeeklyCardsForUsers(users);
  console.log(`[apply] snapshot 무효화: mode=${inv.mode} count=${inv.count}`);

  console.log("\n교정 후 영향 user_weekly_points:");
  for (const k of beforeKeys) {
    const [uid, y, w] = k.split(":");
    const { data } = await supabaseAdmin.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", uid).eq("year", Number(y)).eq("week_number", Number(w)).maybeSingle();
    const d = data as { points: number; advantages: number; penalty: number } | null;
    console.log(`  ${uid.slice(0, 8)} ${y}W${w}: points=${d?.points ?? "-"} adv=${d?.advantages ?? "-"} pen=${d?.penalty ?? "-"} (net=${(d?.advantages ?? 0) - (d?.penalty ?? 0)})`);
  }
  console.log("\n[done] 교정 완료.");
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
