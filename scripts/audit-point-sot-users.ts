// READ-ONLY. Per-user baseline table for the A/B/C regression recovery.
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
  const uwpAll = await pageAll<{
    user_id: string; year: Num; week_number: Num;
    points: Num; advantages: Num; penalty: Num; checks_migrated?: boolean | null;
  }>((f, t) => supabaseAdmin.from("user_weekly_points")
    .select("user_id,year,week_number,points,advantages,penalty,checks_migrated")
    .order("user_id", { ascending: true }).range(f, t));

  const ppaAll = await pageAll<{
    user_id: string; year: Num; week_number: Num;
    point_check: Num; point_advantage: Num; point_penalty: Num; cancelled_at?: string | null;
  }>((f, t) => supabaseAdmin.from("process_point_awards")
    .select("user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at")
    .order("user_id", { ascending: true }).range(f, t));

  const ucpAll = await pageAll<{
    user_id: string; total_checks: Num; total_raw_advantages: Num;
    total_penalties: Num; total_advantages: Num;
  }>((f, t) => supabaseAdmin.from("user_cumulative_points")
    .select("user_id,total_checks,total_raw_advantages,total_penalties,total_advantages")
    .order("user_id", { ascending: true }).range(f, t));

  const roster = await pageAll<{ user_id: string; po_a: Num; po_b: Num; po_c: Num }>((f, t) =>
    supabaseAdmin.from("cluster4_roster_card_stats").select("user_id,po_a,po_b,po_c")
      .order("user_id", { ascending: true }).range(f, t));

  const profiles = await pageAll<{
    user_id: string; display_name: string | null; organization_slug: string | null;
  }>((f, t) => supabaseAdmin.from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .order("user_id", { ascending: true }).range(f, t));

  const markers = await pageAll<{ user_id: string; user_type: string | null }>((f, t) =>
    supabaseAdmin.from("test_user_markers").select("user_id,user_type")
      .order("user_id", { ascending: true }).range(f, t));
  const testIds = new Set(markers.map((m) => m.user_id));

  const agg = <T,>(rows: T[], key: (r: T) => string, add: (acc: any, r: T) => void) => {
    const m = new Map<string, any>();
    for (const r of rows) {
      const k = key(r);
      const cur = m.get(k) ?? { a: 0, adv: 0, pen: 0, n: 0, legacyA: 0, legacyN: 0 };
      add(cur, r);
      cur.n += 1;
      m.set(k, cur);
    }
    return m;
  };

  const uwp = agg(uwpAll, (r) => r.user_id, (acc, r) => {
    acc.a += r.points ?? 0; acc.adv += r.advantages ?? 0; acc.pen += Math.abs(r.penalty ?? 0);
    if (r.year === 1900) { acc.legacyA += r.points ?? 0; acc.legacyN += 1; }
  });
  const ppa = agg(ppaAll.filter((r) => !r.cancelled_at), (r) => r.user_id, (acc, r) => {
    acc.a += r.point_check ?? 0; acc.adv += r.point_advantage ?? 0; acc.pen += Math.abs(r.point_penalty ?? 0);
  });

  const ucp = new Map(ucpAll.map((r) => [r.user_id, r]));
  const ros = new Map(roster.map((r) => [r.user_id, r]));
  const prof = new Map(profiles.map((r) => [r.user_id, r]));

  // ── Q5: is user_cumulative_points an exact cache of user_weekly_points? ──
  let exact = 0, mismatch = 0;
  const mismatchSamples: string[] = [];
  for (const [uid, u] of uwp) {
    const c = ucp.get(uid);
    if (!c) { mismatch += 1; if (mismatchSamples.length < 8) mismatchSamples.push(`${uid} MISSING in ucp (uwpA=${u.a})`); continue; }
    const okA = (c.total_checks ?? 0) === u.a;
    const okAdv = (c.total_raw_advantages ?? 0) === u.adv;
    const okPen = (c.total_penalties ?? 0) === u.pen;
    const okB = (c.total_advantages ?? 0) === u.adv - u.pen;
    if (okA && okAdv && okPen && okB) exact += 1;
    else {
      mismatch += 1;
      if (mismatchSamples.length < 8)
        mismatchSamples.push(`${uid} uwp{a:${u.a},adv:${u.adv},pen:${u.pen}} ucp{a:${c.total_checks},adv:${c.total_raw_advantages},pen:${c.total_penalties},b:${c.total_advantages}}`);
    }
  }
  console.log("=== Q5 ucp vs uwp per-user ===");
  console.log("uwp users:", uwp.size, "exact:", exact, "mismatch:", mismatch, "ucp rows:", ucpAll.length);
  for (const s of mismatchSamples) console.log("  ", s);

  // ── locate the reported example user: awards-derived A=20 B=-18 C=18 ──
  console.log("\n=== users whose AWARDS-only A/B/C == 20/-18/18 ===");
  for (const [uid, p] of ppa) {
    if (p.a === 20 && p.adv - p.pen === -18 && p.pen === 18) {
      const u = uwp.get(uid) ?? { a: 0, adv: 0, pen: 0 };
      const pr = prof.get(uid);
      console.log(JSON.stringify({
        uid, name: pr?.display_name, org: pr?.organization_slug,
        awards: { A: p.a, B: p.adv - p.pen, C: p.pen },
        uwp: { A: u.a, B: u.adv - u.pen, C: u.pen },
      }));
    }
  }

  // ── §2 baseline sample: 10+ users across required categories ──
  const rows = [...uwp.keys()].map((uid) => {
    const u = uwp.get(uid)!;
    const p = ppa.get(uid) ?? { a: 0, adv: 0, pen: 0 };
    const c = ucp.get(uid);
    const r = ros.get(uid);
    const pr = prof.get(uid);
    return {
      uid,
      name: pr?.display_name ?? null,
      org: pr?.organization_slug ?? null,
      test: testIds.has(uid),
      legacyA: u.legacyA, legacyN: u.legacyN,
      ppa: [p.a, p.adv - p.pen, p.pen],
      uwp: [u.a, u.adv - u.pen, u.pen],
      ucp: c ? [c.total_checks ?? 0, c.total_advantages ?? 0, c.total_penalties ?? 0] : null,
      roster: r ? [r.po_a ?? 0, r.po_b ?? 0, r.po_c ?? 0] : null,
      hasAwards: (ppa.get(uid)?.n ?? 0) > 0,
      penalty: u.pen > 0,
    };
  });

  const pick = (label: string, f: (r: (typeof rows)[number]) => boolean, n: number) => {
    const sel = rows.filter(f).sort((a, b) => b.uwp[0] - a.uwp[0]).slice(0, n);
    console.log(`\n--- ${label} (${sel.length}) ---`);
    for (const s of sel) console.log(JSON.stringify(s));
    return sel;
  };

  pick("A) legacy/PMS heavy (year=1900 rows) + 3-digit A", (r) => r.legacyN > 0 && r.uwp[0] >= 100, 4);
  pick("B) recent awards present AND 3-digit uwp A", (r) => r.hasAwards && r.uwp[0] >= 100, 4);
  pick("C) two sources AGREE (uwp A == ppa A, nonzero)", (r) => r.hasAwards && r.uwp[0] === r.ppa[0] && r.uwp[0] !== 0, 3);
  pick("D) two sources DIFFER most", (r) => r.hasAwards && r.uwp[0] !== r.ppa[0], 3);
  pick("E) penalty holders", (r) => r.penalty && r.uwp[0] >= 100, 3);
  pick("F) test accounts", (r) => r.test === true, 4);
  pick("G) negative uwp A cohort", (r) => r.uwp[0] < 0, 5);

  console.log("\n=== NEGATIVE uwp A cohort size ===", rows.filter((r) => r.uwp[0] < 0).length);
  console.log("=== 3-digit uwp A users ===", rows.filter((r) => r.uwp[0] >= 100).length);
  console.log("=== users whose ppa A is 0 but uwp A > 0 ===", rows.filter((r) => r.ppa[0] === 0 && r.uwp[0] > 0).length);

  // roster cache sanity — po_a scale check
  console.log("\n=== roster po_a vs uwp A (first 10 with roster row) ===");
  for (const r of rows.filter((x) => x.roster).slice(0, 10)) {
    console.log(JSON.stringify({ uid: r.uid, roster: r.roster, uwp: r.uwp, ppa: r.ppa }));
  }

  console.log("\n=== DONE (no writes issued) ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
