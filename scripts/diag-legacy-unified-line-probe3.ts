/**
 * READ-ONLY 진단 3: user_activity_details 분포(테스터/실유저, 주차, modal, rating)
 * + user_week_statuses 분포.
 *   npx tsx --env-file=.env.local scripts/diag-legacy-unified-line-probe3.ts
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
  const weeks = await pageAll<any>("weeks", "id,start_date,season_key,week_number,result_published_at");
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerIds = new Set((markers ?? []).map((m: any) => m.user_id));

  // activity_types cluster map
  const { data: at } = await sb.from("activity_types").select("id,cluster_id,name");
  console.log(`activity_types: ${(at ?? []).length}`);
  for (const a of (at ?? []) as any[]) console.log(`  ${a.id} cluster=${a.cluster_id} name=${a.name}`);

  const uad = await pageAll<any>(
    "user_activity_details",
    "id,user_id,week_id,activity_type_id,sub_title,growth_point,rating",
  );
  console.log(`\nuser_activity_details 총수: ${uad.length}`);

  // 주차 × activity_type, tester/real
  const agg = new Map<string, { t: number; r: number; tRated: number; rRated: number }>();
  const userWeeks = new Map<string, Set<string>>(); // "t"/"r" -> user|week
  for (const row of uad) {
    const wk = weekById.get(row.week_id);
    const ws = wk ? `${wk.start_date}` : `??${row.week_id}`;
    const key = `${ws}|${row.activity_type_id}`;
    if (!agg.has(key)) agg.set(key, { t: 0, r: 0, tRated: 0, rRated: 0 });
    const a = agg.get(key)!;
    const isT = testerIds.has(row.user_id);
    if (isT) { a.t += 1; if (row.rating != null) a.tRated += 1; }
    else { a.r += 1; if (row.rating != null) a.rRated += 1; }
    const k2 = isT ? "t" : "r";
    if (!userWeeks.has(k2)) userWeeks.set(k2, new Set());
    userWeeks.get(k2)!.add(`${row.user_id}|${ws}`);
  }
  console.log("\n=== user_activity_details 주차×type (tester건/rated | real건/rated) ===");
  for (const [k, a] of [...agg.entries()].sort()) {
    console.log(`  ${k.padEnd(40)} t=${a.t}/${a.tRated} r=${a.r}/${a.rRated}`);
  }
  console.log(`\nuser-week 페어: tester=${userWeeks.get("t")?.size ?? 0} real=${userWeeks.get("r")?.size ?? 0}`);

  // rating 분포 (tester/real)
  const rT = new Map<number, number>(), rR = new Map<number, number>();
  for (const row of uad) {
    if (row.rating == null) continue;
    const m = testerIds.has(row.user_id) ? rT : rR;
    m.set(row.rating, (m.get(row.rating) ?? 0) + 1);
  }
  console.log("rating 분포 tester:", JSON.stringify([...rT.entries()].sort((a, b) => a[0] - b[0])));
  console.log("rating 분포 real:", JSON.stringify([...rR.entries()].sort((a, b) => a[0] - b[0])));

  // uws
  const uws = await pageAll<any>("user_week_statuses", "id,user_id,week_id,status").catch(async () => {
    // week_id 없으면 컬럼 확인
    const { data, error } = await sb.from("user_week_statuses").select("*").limit(2);
    console.log("uws 샘플:", JSON.stringify(data), error?.message);
    return [];
  });
  if (uws.length) {
    console.log(`\nuser_week_statuses 총수: ${uws.length}`);
    const ua = new Map<string, { [s: string]: { t: number; r: number } }>();
    for (const u of uws) {
      const wk = weekById.get(u.week_id);
      const ws = wk ? wk.start_date : "??";
      if (!ua.has(ws)) ua.set(ws, {});
      const m = ua.get(ws)!;
      if (!m[u.status]) m[u.status] = { t: 0, r: 0 };
      if (testerIds.has(u.user_id)) m[u.status].t += 1; else m[u.status].r += 1;
    }
    console.log("=== uws 주차×status (t/r) ===");
    for (const [ws, m] of [...ua.entries()].sort()) {
      console.log(`  ${ws.padEnd(12)} ${Object.entries(m).map(([s, a]) => `${s}=${a.t}t/${a.r}r`).join(" ")}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
