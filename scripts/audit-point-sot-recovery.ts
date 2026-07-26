// READ-ONLY audit for the A/B/C cumulative point regression.
// Absolutely no writes: only .select() calls are issued.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Num = number | null;

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  // ── 1. Table shape probes ────────────────────────────────────────────
  const probes: Record<string, unknown> = {};
  for (const table of [
    "process_point_awards",
    "user_weekly_points",
    "user_cumulative_points",
    "cluster4_roster_card_stats",
  ]) {
    const { data, error } = await supabaseAdmin.from(table).select("*").limit(1);
    probes[table] = error
      ? { error: error.message }
      : { columns: Object.keys((data?.[0] ?? {}) as object) };
  }
  console.log("=== TABLE SHAPES ===");
  console.log(JSON.stringify(probes, null, 2));

  // ── 2. Row counts ────────────────────────────────────────────────────
  console.log("\n=== ROW COUNTS ===");
  for (const table of [
    "process_point_awards",
    "user_weekly_points",
    "user_cumulative_points",
    "cluster4_roster_card_stats",
  ]) {
    const { count, error } = await supabaseAdmin
      .from(table)
      .select("*", { count: "exact", head: true });
    console.log(table, error ? `ERROR ${error.message}` : count);
  }

  // ── 3. user_weekly_points year distribution (legacy 1900 detection) ──
  const uwpAll = await pageAll<{
    user_id: string;
    year: Num;
    week_number: Num;
    points: Num;
    advantages: Num;
    penalty: Num;
    checks_migrated?: boolean | null;
  }>((from, to) =>
    supabaseAdmin
      .from("user_weekly_points")
      .select("user_id,year,week_number,points,advantages,penalty,checks_migrated")
      .order("user_id", { ascending: true })
      .range(from, to),
  );

  const byYear = new Map<string, { rows: number; points: number; adv: number; pen: number }>();
  for (const r of uwpAll) {
    const k = String(r.year);
    const cur = byYear.get(k) ?? { rows: 0, points: 0, adv: 0, pen: 0 };
    cur.rows += 1;
    cur.points += r.points ?? 0;
    cur.adv += r.advantages ?? 0;
    cur.pen += r.penalty ?? 0;
    byYear.set(k, cur);
  }
  console.log("\n=== user_weekly_points BY YEAR ===");
  for (const [year, v] of [...byYear.entries()].sort()) {
    console.log(year, JSON.stringify(v));
  }

  const migFlag = new Map<string, number>();
  for (const r of uwpAll) {
    const k = String(r.checks_migrated);
    migFlag.set(k, (migFlag.get(k) ?? 0) + 1);
  }
  console.log("checks_migrated distribution:", JSON.stringify([...migFlag]));

  // ── 4. process_point_awards distribution ────────────────────────────
  const ppaAll = await pageAll<{
    user_id: string;
    year: Num;
    week_number: Num;
    point_check: Num;
    point_advantage: Num;
    point_penalty: Num;
    cancelled_at?: string | null;
  }>((from, to) =>
    supabaseAdmin
      .from("process_point_awards")
      .select("user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at")
      .order("user_id", { ascending: true })
      .range(from, to),
  );

  const ppaByYear = new Map<string, { rows: number; a: number; adv: number; pen: number }>();
  for (const r of ppaAll) {
    if (r.cancelled_at) continue;
    const k = String(r.year);
    const cur = ppaByYear.get(k) ?? { rows: 0, a: 0, adv: 0, pen: 0 };
    cur.rows += 1;
    cur.a += r.point_check ?? 0;
    cur.adv += r.point_advantage ?? 0;
    cur.pen += r.point_penalty ?? 0;
    ppaByYear.set(k, cur);
  }
  console.log("\n=== process_point_awards BY YEAR (active only) ===");
  for (const [year, v] of [...ppaByYear.entries()].sort()) {
    console.log(year, JSON.stringify(v));
  }

  // ── 5. Global totals per source ─────────────────────────────────────
  const uwpTotal = uwpAll.reduce(
    (acc, r) => {
      acc.a += r.points ?? 0;
      acc.adv += r.advantages ?? 0;
      acc.pen += r.penalty ?? 0;
      return acc;
    },
    { a: 0, adv: 0, pen: 0 },
  );
  const ppaTotal = ppaAll.reduce(
    (acc, r) => {
      if (r.cancelled_at) return acc;
      acc.a += r.point_check ?? 0;
      acc.adv += r.point_advantage ?? 0;
      acc.pen += Math.abs(r.point_penalty ?? 0);
      return acc;
    },
    { a: 0, adv: 0, pen: 0 },
  );
  console.log("\n=== GLOBAL TOTALS ===");
  console.log("user_weekly_points:", JSON.stringify(uwpTotal));
  console.log("process_point_awards(active):", JSON.stringify(ppaTotal));

  const ucpAll = await pageAll<{
    user_id: string;
    total_checks: Num;
    total_raw_advantages: Num;
    total_penalties: Num;
    total_advantages: Num;
    updated_at?: string | null;
  }>((from, to) =>
    supabaseAdmin
      .from("user_cumulative_points")
      .select("user_id,total_checks,total_raw_advantages,total_penalties,total_advantages,updated_at")
      .order("user_id", { ascending: true })
      .range(from, to),
  );
  const ucpTotal = ucpAll.reduce(
    (acc, r) => {
      acc.a += r.total_checks ?? 0;
      acc.adv += r.total_raw_advantages ?? 0;
      acc.pen += r.total_penalties ?? 0;
      return acc;
    },
    { a: 0, adv: 0, pen: 0 },
  );
  console.log("user_cumulative_points:", JSON.stringify(ucpTotal));

  // updated_at spread tells whether the SoT migration ran against this DB
  const stamps = ucpAll
    .map((r) => r.updated_at ?? "")
    .filter(Boolean)
    .sort();
  console.log(
    "user_cumulative_points.updated_at min/max:",
    stamps[0],
    "/",
    stamps[stamps.length - 1],
  );

  // ── 6. Per-user divergence between the two sources ──────────────────
  const uwpByUser = new Map<string, { a: number; adv: number; pen: number; rows: number }>();
  for (const r of uwpAll) {
    const cur = uwpByUser.get(r.user_id) ?? { a: 0, adv: 0, pen: 0, rows: 0 };
    cur.a += r.points ?? 0;
    cur.adv += r.advantages ?? 0;
    cur.pen += r.penalty ?? 0;
    cur.rows += 1;
    uwpByUser.set(r.user_id, cur);
  }
  const ppaByUser = new Map<string, { a: number; adv: number; pen: number; rows: number }>();
  for (const r of ppaAll) {
    if (r.cancelled_at) continue;
    const cur = ppaByUser.get(r.user_id) ?? { a: 0, adv: 0, pen: 0, rows: 0 };
    cur.a += r.point_check ?? 0;
    cur.adv += r.point_advantage ?? 0;
    cur.pen += Math.abs(r.point_penalty ?? 0);
    cur.rows += 1;
    ppaByUser.set(r.user_id, cur);
  }
  const ucpByUser = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of ucpAll) {
    ucpByUser.set(r.user_id, {
      a: r.total_checks ?? 0,
      adv: r.total_raw_advantages ?? 0,
      pen: r.total_penalties ?? 0,
    });
  }

  const allUsers = new Set<string>([...uwpByUser.keys(), ...ppaByUser.keys()]);
  let sameCount = 0;
  let uwpHigher = 0;
  let ppaHigher = 0;
  const diffs: Array<{ user_id: string; uwpA: number; ppaA: number; ucpA: number; delta: number }> = [];
  for (const uid of allUsers) {
    const u = uwpByUser.get(uid) ?? { a: 0, adv: 0, pen: 0, rows: 0 };
    const p = ppaByUser.get(uid) ?? { a: 0, adv: 0, pen: 0, rows: 0 };
    const c = ucpByUser.get(uid) ?? { a: 0, adv: 0, pen: 0 };
    if (u.a === p.a) sameCount += 1;
    else if (u.a > p.a) uwpHigher += 1;
    else ppaHigher += 1;
    diffs.push({ user_id: uid, uwpA: u.a, ppaA: p.a, ucpA: c.a, delta: u.a - p.a });
  }
  console.log("\n=== PER-USER A COMPARISON ===");
  console.log("users:", allUsers.size, "same:", sameCount, "uwp>ppa:", uwpHigher, "ppa>uwp:", ppaHigher);

  diffs.sort((x, y) => y.delta - x.delta);
  console.log("\ntop 15 uwp>ppa:");
  for (const d of diffs.slice(0, 15)) console.log(JSON.stringify(d));
  console.log("\ntop 15 ppa>uwp:");
  for (const d of diffs.slice(-15)) console.log(JSON.stringify(d));

  // ── 7. Weekly-key overlap: are the tables duplicates of one another? ─
  const uwpKeys = new Set(uwpAll.map((r) => `${r.user_id}::${r.year}::${r.week_number}`));
  const ppaKeys = new Set(
    ppaAll.filter((r) => !r.cancelled_at).map((r) => `${r.user_id}::${r.year}::${r.week_number}`),
  );
  let both = 0;
  for (const k of ppaKeys) if (uwpKeys.has(k)) both += 1;
  console.log("\n=== WEEK-KEY OVERLAP ===");
  console.log("uwp keys:", uwpKeys.size, "ppa keys:", ppaKeys.size, "overlap:", both);
  console.log("ppa-only keys:", ppaKeys.size - both, "uwp-only keys:", uwpKeys.size - both);

  // Per-key value agreement on overlapping keys (duplicate vs mirror check)
  const uwpByKey = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of uwpAll) {
    const k = `${r.user_id}::${r.year}::${r.week_number}`;
    const cur = uwpByKey.get(k) ?? { a: 0, adv: 0, pen: 0 };
    cur.a += r.points ?? 0;
    cur.adv += r.advantages ?? 0;
    cur.pen += r.penalty ?? 0;
    uwpByKey.set(k, cur);
  }
  const ppaByKey = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of ppaAll) {
    if (r.cancelled_at) continue;
    const k = `${r.user_id}::${r.year}::${r.week_number}`;
    const cur = ppaByKey.get(k) ?? { a: 0, adv: 0, pen: 0 };
    cur.a += r.point_check ?? 0;
    cur.adv += r.point_advantage ?? 0;
    cur.pen += Math.abs(r.point_penalty ?? 0);
    ppaByKey.set(k, cur);
  }
  let mirrored = 0;
  let divergent = 0;
  const divergentSamples: string[] = [];
  for (const [k, p] of ppaByKey) {
    const u = uwpByKey.get(k);
    if (!u) continue;
    if (u.a === p.a && u.adv === p.adv && Math.abs(u.pen) === p.pen) mirrored += 1;
    else {
      divergent += 1;
      if (divergentSamples.length < 10)
        divergentSamples.push(`${k} uwp=${JSON.stringify(u)} ppa=${JSON.stringify(p)}`);
    }
  }
  console.log("overlapping keys mirrored:", mirrored, "divergent:", divergent);
  for (const s of divergentSamples) console.log("  ", s);

  // ── 8. roster slim cache ────────────────────────────────────────────
  const roster = await pageAll<{
    user_id: string;
    po_a: Num;
    po_b: Num;
    po_c: Num;
    updated_at?: string | null;
  }>((from, to) =>
    supabaseAdmin
      .from("cluster4_roster_card_stats")
      .select("user_id,po_a,po_b,po_c,updated_at")
      .order("user_id", { ascending: true })
      .range(from, to),
  );
  const rosterTotal = roster.reduce(
    (acc, r) => {
      acc.a += r.po_a ?? 0;
      acc.b += r.po_b ?? 0;
      acc.c += r.po_c ?? 0;
      return acc;
    },
    { a: 0, b: 0, c: 0 },
  );
  console.log("\n=== roster slim cache totals ===", JSON.stringify(rosterTotal));

  console.log("\n=== DONE (no writes issued) ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
