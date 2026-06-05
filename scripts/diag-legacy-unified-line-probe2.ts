/**
 * READ-ONLY 진단 2: 전체 cluster4_lines 의 week_id 분포 + weeks 테이블 전수 + 제출 분포.
 *   npx tsx --env-file=.env.local scripts/diag-legacy-unified-line-probe2.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function pageAll<T>(table: string, select: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("id", { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    let data: any = null, error: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { const res = await q; data = res.data; error = res.error; if (!error) break; }
      catch (e) { error = e; }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (error) throw new Error(`${table}: ${error.message ?? error}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  // 1) weeks 전수
  const weeks = await pageAll<any>("weeks", "id,start_date,end_date,season_key,week_number,result_published_at");
  console.log(`weeks 총수: ${weeks.length}`);
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const byStart = new Map<string, any[]>();
  for (const w of weeks) {
    if (!byStart.has(w.start_date)) byStart.set(w.start_date, []);
    byStart.get(w.start_date)!.push(w);
  }
  const dups = [...byStart.entries()].filter(([, v]) => v.length > 1);
  console.log(`start_date 중복 주차: ${dups.length}`);
  for (const [sd, v] of dups.slice(0, 10)) console.log(`  ${sd}: ${v.map((x) => x.id).join(" | ")}`);

  // 2) 모든 lines (week_id 별)
  const lines = await pageAll<any>(
    "cluster4_lines",
    "id,week_id,part_type,is_active,experience_line_master_id",
  );
  console.log(`\ncluster4_lines 총수: ${lines.length}`);
  const linesByWeek = new Map<string, Map<string, number>>();
  for (const l of lines) {
    const w = weekById.get(l.week_id);
    const ws = w ? `${w.start_date}(${w.season_key} W${w.week_number})` : `??week_id=${l.week_id}`;
    if (!linesByWeek.has(ws)) linesByWeek.set(ws, new Map());
    const m = linesByWeek.get(ws)!;
    m.set(l.part_type, (m.get(l.part_type) ?? 0) + 1);
  }
  console.log("\n=== 라인 주차별 part 분포 ===");
  for (const [ws, m] of [...linesByWeek.entries()].sort()) {
    console.log(`  ${ws.padEnd(40)} ${[...m.entries()].map(([p, c]) => `${p}=${c}`).join(", ")}`);
  }

  // 3) 제출 전체 — week 분포
  const subs = await pageAll<any>(
    "cluster4_line_submissions",
    "id,line_target_id,user_id,submitted_at",
  );
  console.log(`\ncluster4_line_submissions 총수: ${subs.length}`);

  // 타깃 → week
  const targets = await pageAll<any>("cluster4_line_targets", "id,line_id,week_id,target_user_id");
  console.log(`cluster4_line_targets 총수: ${targets.length}`);
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const lineByIdAll = new Map(lines.map((l) => [l.id, l]));

  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerIds = new Set((markers ?? []).map((m: any) => m.user_id));

  const subAgg = new Map<string, { tester: number; real: number }>();
  for (const s of subs) {
    const t = targetById.get(s.line_target_id);
    const wk = t ? weekById.get(t.week_id) : null;
    const line = t ? lineByIdAll.get(t.line_id) : null;
    const ws = wk ? `${wk.start_date}|${line?.part_type ?? "?"}` : "orphan";
    if (!subAgg.has(ws)) subAgg.set(ws, { tester: 0, real: 0 });
    const a = subAgg.get(ws)!;
    if (testerIds.has(s.user_id)) a.tester += 1; else a.real += 1;
  }
  console.log("\n=== 제출 주차×파트 분포 (tester/real) ===");
  for (const [ws, a] of [...subAgg.entries()].sort()) {
    console.log(`  ${ws.padEnd(34)} tester=${a.tester} real=${a.real}`);
  }

  // 4) 평가 전체
  const evals = await pageAll<any>("cluster4_experience_line_evaluations", "id,line_target_id,user_id,rating");
  console.log(`\ncluster4_experience_line_evaluations 총수: ${evals.length}`);
  const evalAgg = new Map<string, { tester: number; real: number; ratings: number[] }>();
  for (const e of evals) {
    const t = targetById.get(e.line_target_id);
    const wk = t ? weekById.get(t.week_id) : null;
    const ws = wk ? wk.start_date : "orphan";
    if (!evalAgg.has(ws)) evalAgg.set(ws, { tester: 0, real: 0, ratings: [] });
    const a = evalAgg.get(ws)!;
    if (testerIds.has(e.user_id)) a.tester += 1; else a.real += 1;
    if (e.rating != null) a.ratings.push(e.rating);
  }
  console.log("=== 평가 주차 분포 (tester/real) ===");
  for (const [ws, a] of [...evalAgg.entries()].sort()) {
    const lo = Math.min(...a.ratings), hi = Math.max(...a.ratings);
    console.log(`  ${ws.padEnd(12)} tester=${a.tester} real=${a.real} rating[${isFinite(lo) ? lo : "-"}..${isFinite(hi) ? hi : "-"}]`);
  }

  // 5) uws(user_week_statuses) — 주차 성공 데이터는 어디에?
  const uws = await pageAll<any>("user_week_statuses", "id,user_id,week_id,status");
  console.log(`\nuser_week_statuses 총수: ${uws.length}`);
  const uwsAgg = new Map<string, Map<string, { tester: number; real: number }>>();
  for (const u of uws) {
    const wk = weekById.get(u.week_id);
    const ws = wk ? wk.start_date : "orphan";
    if (!uwsAgg.has(ws)) uwsAgg.set(ws, new Map());
    const m = uwsAgg.get(ws)!;
    if (!m.has(u.status)) m.set(u.status, { tester: 0, real: 0 });
    const a = m.get(u.status)!;
    if (testerIds.has(u.user_id)) a.tester += 1; else a.real += 1;
  }
  console.log("=== uws 주차×status (tester/real) ===");
  for (const [ws, m] of [...uwsAgg.entries()].sort()) {
    console.log(
      `  ${ws.padEnd(12)} ${[...m.entries()].map(([s, a]) => `${s}=${a.tester}t/${a.real}r`).join(" ")}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
