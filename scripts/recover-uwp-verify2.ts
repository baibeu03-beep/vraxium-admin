/**
 * READ-ONLY 검증 #2 — (a) roster slim po_b 해석 정정(= raw advantage, e180783 이전 코드),
 *   (b) "pre-wipe 스냅샷에는 값이 있는데 원장 재구성이 0" 인 행의 정체 규명.
 *   npx tsx --env-file=.env.local scripts/recover-uwp-verify2.ts
 * write 0.
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WIPE = "2026-07-25T04:52:00Z";
const WIPE_PREFIX = "2026-07-25T04:52:05";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

type Row = {
  user_id: string; display_name: string; org: string; is_test: boolean; week_start_date: string; week_kind: string;
  cur_a: number; exp_a: number; cur_adv: number; exp_adv: number; cur_pen: number; exp_pen: number;
  checks_migrated: boolean; wiped: boolean; has_award: boolean;
};

async function pageAll<T>(b: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, page = 1000): Promise<T[]> {
  const o: T[] = [];
  for (let f = 0; ; f += page) {
    const { data, error } = await b(f, f + page - 1);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[];
    o.push(...r);
    if (r.length < page) break;
  }
  return o;
}

async function main() {
  const file = "claudedocs/" + readdirSync("claudedocs").filter((x) => x.startsWith("recover-uwp-dryrun-") && x.endsWith(".json")).sort().pop()!;
  const { rows } = JSON.parse(readFileSync(file, "utf8")) as { rows: Row[] };
  const byKey = new Map(rows.map((r) => [`${r.user_id}|${r.week_start_date}`, r]));

  // 마스터 데이터
  const profiles = await pageAll<{ user_id: string; display_name: string | null; organization_slug: string | null }>(
    (f, t) => supabaseAdmin.from("user_profiles").select("user_id,display_name,organization_slug").order("user_id").range(f, t));
  const profById = new Map(profiles.map((p) => [p.user_id, p]));
  const markers = new Set((await pageAll<{ user_id: string }>((f, t) => supabaseAdmin.from("test_user_markers").select("user_id").order("user_id").range(f, t))).map((m) => m.user_id));
  const usersRows = await pageAll<{ id: string; source_system: string | null; legacy_user_id: number | null }>(
    (f, t) => supabaseAdmin.from("users").select("id,source_system,legacy_user_id").order("id").range(f, t));
  const srcOf = new Map(usersRows.map((u) => [u.id, u.source_system]));

  const uwp = await pageAll<{ id: string; user_id: string; week_start_date: string | null; points: number | null; advantages: number | null; penalty: number | null; checks_migrated: boolean | null; updated_at: string | null }>(
    (f, t) => supabaseAdmin.from("user_weekly_points").select("id,user_id,week_start_date,points,advantages,penalty,checks_migrated,updated_at").order("id").range(f, t));
  const uwpByKey = new Map(uwp.map((r) => [`${r.user_id}|${r.week_start_date}`, r]));

  // ═══ (a) 누적 기준선 재해석: po_b = raw advantage ═══
  const roster = await pageAll<{ user_id: string; po_a: number | null; po_b: number | null; po_c: number | null }>(
    (f, t) => supabaseAdmin.from("cluster4_roster_card_stats").select("user_id,po_a,po_b,po_c").lt("updated_at", WIPE).order("user_id").range(f, t));

  const curCum = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of uwp) {
    const e = curCum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 };
    e.a += r.points ?? 0; e.adv += r.advantages ?? 0; e.pen += r.penalty ?? 0;
    curCum.set(r.user_id, e);
  }
  const scope = rows.filter((r) => r.wiped && r.checks_migrated && !r.has_award && r.cur_a === 0 && r.cur_adv === 0 && r.cur_pen === 0 && (r.exp_a !== 0 || r.exp_adv !== 0 || r.exp_pen !== 0));
  const deltaCum = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of scope) {
    const e = deltaCum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 };
    e.a += r.exp_a; e.adv += r.exp_adv; e.pen += r.exp_pen;
    deltaCum.set(r.user_id, e);
  }

  let okA = 0, okAdv = 0, okC = 0, okAll = 0;
  const bad: string[] = [];
  for (const r of roster) {
    const cur = curCum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 };
    const d = deltaCum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 };
    const resA = cur.a + d.a, resAdv = cur.adv + d.adv, resC = cur.pen + d.pen;
    const a = (r.po_a ?? 0) === resA, adv = (r.po_b ?? 0) === resAdv, c = (r.po_c ?? 0) === resC;
    if (a) okA++; if (adv) okAdv++; if (c) okC++;
    if (a && adv && c) okAll++;
    else bad.push(`${profById.get(r.user_id)?.display_name ?? "?"}(${profById.get(r.user_id)?.organization_slug ?? "?"}${markers.has(r.user_id) ? ",T" : ""}) base A/rawAdv/C=${r.po_a}/${r.po_b}/${r.po_c} 복구예상=${resA}/${resAdv}/${resC} Δ=${resA - (r.po_a ?? 0)}/${resAdv - (r.po_b ?? 0)}/${resC - (r.po_c ?? 0)}`);
  }
  console.log("═══ (a) 누적: pre-wipe roster slim (po_b = raw advantage) vs 복구 예상 ═══");
  console.log(`대상 ${roster.length}명 | A 일치 ${okA} · rawAdv 일치 ${okAdv} · C 일치 ${okC} · 3항 전부 ${okAll}`);
  console.log(`Σ base   A/rawAdv/C = ${roster.reduce((s, r) => s + (r.po_a ?? 0), 0)} / ${roster.reduce((s, r) => s + (r.po_b ?? 0), 0)} / ${roster.reduce((s, r) => s + (r.po_c ?? 0), 0)}`);
  let sA = 0, sAdv = 0, sC = 0;
  for (const r of roster) { const cur = curCum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 }; const d = deltaCum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 }; sA += cur.a + d.a; sAdv += cur.adv + d.adv; sC += cur.pen + d.pen; }
  console.log(`Σ 복구예상 A/rawAdv/C = ${sA} / ${sAdv} / ${sC}`);
  console.log(`불일치 ${bad.length}명:`);
  for (const b of bad.slice(0, 20)) console.log("   " + b);

  // ═══ (b) 스냅샷에만 값이 있는 행의 정체 ═══
  const snaps = await pageAll<{ user_id: string; cards: any }>(
    (f, t) => supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id,cards").lt("computed_at", WIPE).order("user_id").range(f, t), 25);

  type Orphan = { user_id: string; name: string; org: string; test: boolean; src: string; week: string; baseA: number; baseAdv: number; baseC: number; uwpExists: boolean; uwpA: number; uwpAdv: number; uwpPen: number; cm: boolean | null; wiped: boolean; expA: number };
  const orphans: Orphan[] = [];
  for (const s of snaps) {
    for (const c of (Array.isArray(s.cards) ? s.cards : [])) {
      const p = c?.points, ws = c?.startDate;
      if (!ws || !p) continue;
      const baseA = Number(p.star ?? 0), baseC = Number(p.pointC ?? 0), baseAdv = Number(p.shield ?? 0) + baseC;
      if (baseA === 0 && baseAdv === 0 && baseC === 0) continue;
      const k = `${s.user_id}|${ws}`;
      const dr = byKey.get(k);
      const expA = dr?.exp_a ?? 0, expAdv = dr?.exp_adv ?? 0, expC = dr?.exp_pen ?? 0;
      if (baseA === expA && baseAdv === expAdv && baseC === expC) continue; // 일치
      if (dr?.has_award) continue; // awards SoT
      const u = uwpByKey.get(k);
      orphans.push({
        user_id: s.user_id, name: profById.get(s.user_id)?.display_name ?? "?", org: profById.get(s.user_id)?.organization_slug ?? "?",
        test: markers.has(s.user_id), src: srcOf.get(s.user_id) ?? "null", week: ws,
        baseA, baseAdv, baseC,
        uwpExists: !!u, uwpA: u?.points ?? 0, uwpAdv: u?.advantages ?? 0, uwpPen: u?.penalty ?? 0,
        cm: u?.checks_migrated ?? null, wiped: String(u?.updated_at ?? "").startsWith(WIPE_PREFIX), expA,
      });
    }
  }
  const S = (rs: Orphan[], f: (o: Orphan) => number) => rs.reduce((s, o) => s + f(o), 0);
  const rep = (label: string, rs: Orphan[]) => console.log(`${label.padEnd(56)} n=${String(rs.length).padStart(5)} users=${String(new Set(rs.map((o) => o.user_id)).size).padStart(4)} ΣbaseA=${String(S(rs, (o) => o.baseA)).padStart(7)} ΣuwpA=${String(S(rs, (o) => o.uwpA)).padStart(6)} ΣexpA=${String(S(rs, (o) => o.expA)).padStart(6)}`);

  console.log("\n═══ (b) 스냅샷 비영 · 원장 재구성 불일치 (award 제외) ═══");
  rep("전체", orphans);
  rep("  테스트 계정", orphans.filter((o) => o.test));
  rep("  실사용자", orphans.filter((o) => !o.test));
  rep("    └ PMS 이관자(source_system 있음)", orphans.filter((o) => !o.test && o.src !== "null"));
  rep("    └ 비이관자(source_system=null)", orphans.filter((o) => !o.test && o.src === "null"));
  rep("  uwp 행 부재", orphans.filter((o) => !o.uwpExists));
  rep("  uwp 행 존재 ∧ wiped", orphans.filter((o) => o.uwpExists && o.wiped));
  rep("  uwp 행 존재 ∧ wiped 아님", orphans.filter((o) => o.uwpExists && !o.wiped));

  const unrecoverable = orphans.filter((o) => !o.test && o.uwpExists && o.wiped && o.expA === 0 && o.baseA !== 0);
  console.log(`\n  ⚠ 복구 불가 후보(실사용자 ∧ §2 wiped ∧ 원장 0 ∧ 스냅샷 비영): ${unrecoverable.length}행 / ${new Set(unrecoverable.map((o) => o.user_id)).size}명 ΣbaseA=${S(unrecoverable, (o) => o.baseA)}`);
  for (const o of unrecoverable.slice(0, 15)) console.log(`     ${o.name}(${o.org},src=${o.src}) ${o.week} baseA=${o.baseA} baseAdv=${o.baseAdv} baseC=${o.baseC} uwp=${o.uwpA}/${o.uwpAdv}/${o.uwpPen} cm=${o.cm}`);

  console.log("\n  ── 실사용자 orphan 사용자별 상위 15 ──");
  const byUser = new Map<string, { name: string; org: string; src: string; rows: number; baseA: number; uwpA: number; expA: number }>();
  for (const o of orphans.filter((x) => !x.test)) {
    const e = byUser.get(o.user_id) ?? { name: o.name, org: o.org, src: o.src, rows: 0, baseA: 0, uwpA: 0, expA: 0 };
    e.rows++; e.baseA += o.baseA; e.uwpA += o.uwpA; e.expA += o.expA;
    byUser.set(o.user_id, e);
  }
  for (const [uid, e] of [...byUser].sort((a, b) => b[1].baseA - a[1].baseA).slice(0, 15))
    console.log(`     ${e.name.padEnd(7)}${e.org.padEnd(8)} src=${String(e.src).padEnd(8)} rows=${String(e.rows).padStart(3)} ΣbaseA=${String(e.baseA).padStart(6)} ΣuwpA=${String(e.uwpA).padStart(5)} ΣexpA=${String(e.expA).padStart(5)}  ${uid}`);

  const out = `claudedocs/recover-uwp-verify2-${STAMP}.json`;
  writeFileSync(out, JSON.stringify({ cumulative: { total: roster.length, okA, okAdv, okC, okAll, mismatches: bad }, orphans }, null, 1), "utf8");
  console.log(`\n→ ${out}`);
  console.log("\n=== DONE (writes: 0) ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
