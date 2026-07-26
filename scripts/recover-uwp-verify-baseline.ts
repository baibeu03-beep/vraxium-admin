/**
 * READ-ONLY 독립 검증 — 원장 재구성값을 "마이그레이션 이전" 캐시 2종과 대조.
 *   npx tsx --env-file=.env.local scripts/recover-uwp-verify-baseline.ts
 * write 0.
 *
 * 독립 기준선(최종 정답 아님 — 교차 검증용):
 *   ① cluster4_weekly_card_snapshots  computed_at < 2026-07-25T04:52  (주차 단위)
 *      cards[].points = { star:A, shield:B(=rawAdv−C), pointC:C, lightning:−C }
 *      → rawAdvantage = shield + pointC
 *   ② cluster4_roster_card_stats      updated_at   < 2026-07-25T04:52  (누적 단위)
 *      po_a/po_b/po_c = 누적 A/B/C
 *
 * 대조 대상 = recover-uwp-dryrun-*.json 의 재구성값(exp_*)과 현재값(cur_*).
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WIPE = "2026-07-25T04:52:00Z";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

type Row = {
  group: number; user_id: string; display_name: string; org: string; is_test: boolean;
  week_start_date: string; week_kind: string;
  cur_a: number; exp_a: number; cur_adv: number; exp_adv: number; cur_pen: number; exp_pen: number;
  checks_migrated: boolean; wiped: boolean; has_award: boolean; ledger_rows: number;
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
  console.log("dry-run source:", file);
  const byKey = new Map(rows.map((r) => [`${r.user_id}|${r.week_start_date}`, r]));

  // ── ① 주차 단위 기준선: pre-wipe weekly-card snapshot ──
  // cards JSON 이 커서 1000행 페이지는 statement timeout — 25행씩 읽는다.
  const snaps = await pageAll<{ user_id: string; cards: any; computed_at: string | null }>(
    (f, t) => supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id,cards,computed_at").lt("computed_at", WIPE).order("user_id").range(f, t),
    25,
  );
  console.log(`pre-wipe snapshot: ${snaps.length}명`);

  type Cmp = {
    user_id: string; name: string; org: string; test: boolean; week: string; kind: string;
    baseA: number; baseAdv: number; baseC: number;
    expA: number; expAdv: number; expC: number;
    curA: number; curAdv: number; curC: number;
    match: boolean; hasAward: boolean; wiped: boolean; inDryrun: boolean;
  };
  const cmps: Cmp[] = [];
  let cardsSeen = 0, cardsNoPoints = 0;

  for (const s of snaps) {
    const cards = Array.isArray(s.cards) ? s.cards : [];
    for (const c of cards) {
      cardsSeen++;
      const p = c?.points;
      const ws = c?.startDate;
      if (!ws) continue;
      if (!p || (p.star == null && p.shield == null && p.pointC == null)) { cardsNoPoints++; continue; }
      const baseA = Number(p.star ?? 0);
      const baseC = Number(p.pointC ?? 0);
      const baseAdv = Number(p.shield ?? 0) + baseC; // rawAdvantage = B + C
      const k = `${s.user_id}|${ws}`;
      const r = byKey.get(k);
      const expA = r?.exp_a ?? 0, expAdv = r?.exp_adv ?? 0, expC = r?.exp_pen ?? 0;
      const curA = r?.cur_a ?? 0, curAdv = r?.cur_adv ?? 0, curC = r?.cur_pen ?? 0;
      cmps.push({
        user_id: s.user_id, name: r?.display_name ?? "?", org: r?.org ?? "?", test: r?.is_test ?? false,
        week: ws, kind: r?.week_kind ?? "?",
        baseA, baseAdv, baseC, expA, expAdv, expC, curA, curAdv, curC,
        match: baseA === expA && baseAdv === expAdv && baseC === expC,
        hasAward: r?.has_award ?? false, wiped: r?.wiped ?? false, inDryrun: !!r,
      });
    }
  }
  console.log(`카드 ${cardsSeen}장 (points 없음 ${cardsNoPoints}) → 대조 ${cmps.length}건`);

  const nonTrivial = cmps.filter((c) => c.baseA !== 0 || c.baseAdv !== 0 || c.baseC !== 0 || c.expA !== 0 || c.expAdv !== 0 || c.expC !== 0);
  const S = (rs: Cmp[], f: (c: Cmp) => number) => rs.reduce((s, c) => s + f(c), 0);
  const line = (label: string, rs: Cmp[]) =>
    console.log(`${label.padEnd(48)} n=${String(rs.length).padStart(6)} | baseA=${String(S(rs, (c) => c.baseA)).padStart(7)} expA=${String(S(rs, (c) => c.expA)).padStart(7)} curA=${String(S(rs, (c) => c.curA)).padStart(6)}` +
      ` | baseAdv=${String(S(rs, (c) => c.baseAdv)).padStart(6)} expAdv=${String(S(rs, (c) => c.expAdv)).padStart(6)}` +
      ` | baseC=${String(S(rs, (c) => c.baseC)).padStart(6)} expC=${String(S(rs, (c) => c.expC)).padStart(6)}`);

  console.log("\n════ ① 주차 단위: pre-wipe 스냅샷 vs 원장 재구성 ════");
  line("전체(비영 조합만)", nonTrivial);
  line("  일치", nonTrivial.filter((c) => c.match));
  line("  불일치", nonTrivial.filter((c) => !c.match));
  line("    └ award 있음(awards SoT — 원장 미보유 정상)", nonTrivial.filter((c) => !c.match && c.hasAward));
  line("    └ award 없음", nonTrivial.filter((c) => !c.match && !c.hasAward));
  line("      └ 테스트 계정", nonTrivial.filter((c) => !c.match && !c.hasAward && c.test));
  line("      └ 실사용자", nonTrivial.filter((c) => !c.match && !c.hasAward && !c.test));

  const realMismatch = nonTrivial.filter((c) => !c.match && !c.hasAward && !c.test);
  console.log(`\n  ── 실사용자 불일치 상위 25 (|baseA−expA| 내림차순) ──`);
  for (const c of [...realMismatch].sort((a, b) => Math.abs(b.baseA - b.expA) - Math.abs(a.baseA - a.expA)).slice(0, 25))
    console.log(`   ${c.name}(${c.org}) ${c.week}[${c.kind}] A base=${c.baseA} exp=${c.expA} cur=${c.curA} | adv base=${c.baseAdv} exp=${c.expAdv} | C base=${c.baseC} exp=${c.expC} | dryrun=${c.inDryrun} wiped=${c.wiped}`);

  // ── ② 누적 단위: pre-wipe roster slim ──
  const roster = await pageAll<{ user_id: string; po_a: number | null; po_b: number | null; po_c: number | null; updated_at: string | null }>(
    (f, t) => supabaseAdmin.from("cluster4_roster_card_stats").select("user_id,po_a,po_b,po_c,updated_at").lt("updated_at", WIPE).order("user_id").range(f, t),
  );
  console.log(`\npre-wipe roster slim: ${roster.length}명`);

  // 복구 후 예상 누적 = 현재 uwp 합 + 스코프 행의 Δ
  const uwp = await pageAll<{ user_id: string; points: number | null; advantages: number | null; penalty: number | null; week_start_date: string | null; checks_migrated: boolean | null; updated_at: string | null }>(
    (f, t) => supabaseAdmin.from("user_weekly_points").select("user_id,points,advantages,penalty,week_start_date,checks_migrated,updated_at").order("id").range(f, t),
  );
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
    e.a += r.exp_a - r.cur_a; e.adv += r.exp_adv - r.cur_adv; e.pen += r.exp_pen - r.cur_pen;
    deltaCum.set(r.user_id, e);
  }

  type CumCmp = { user_id: string; name: string; org: string; test: boolean; baseA: number; baseB: number; baseC: number; curA: number; curB: number; curC: number; resA: number; resB: number; resC: number; ok: boolean; dA: number };
  const cumCmps: CumCmp[] = [];
  const nameOf = new Map(rows.map((r) => [r.user_id, { n: r.display_name, o: r.org, t: r.is_test }]));
  for (const r of roster) {
    const cur = curCum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 };
    const d = deltaCum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 };
    const resA = cur.a + d.a, resAdv = cur.adv + d.adv, resC = cur.pen + d.pen;
    const meta = nameOf.get(r.user_id);
    cumCmps.push({
      user_id: r.user_id, name: meta?.n ?? "?", org: meta?.o ?? "?", test: meta?.t ?? false,
      baseA: r.po_a ?? 0, baseB: r.po_b ?? 0, baseC: r.po_c ?? 0,
      curA: cur.a, curB: cur.adv - cur.pen, curC: cur.pen,
      resA, resB: resAdv - resC, resC,
      ok: (r.po_a ?? 0) === resA && (r.po_b ?? 0) === resAdv - resC && (r.po_c ?? 0) === resC,
      dA: resA - (r.po_a ?? 0),
    });
  }
  const T = (rs: CumCmp[], f: (c: CumCmp) => number) => rs.reduce((s, c) => s + f(c), 0);
  console.log("\n════ ② 누적 단위: pre-wipe roster slim vs 복구 예상 ════");
  console.log(`대상 ${cumCmps.length}명 | baseΣA=${T(cumCmps, (c) => c.baseA)} curΣA=${T(cumCmps, (c) => c.curA)} 복구예상ΣA=${T(cumCmps, (c) => c.resA)}`);
  console.log(`            | baseΣB=${T(cumCmps, (c) => c.baseB)} curΣB=${T(cumCmps, (c) => c.curB)} 복구예상ΣB=${T(cumCmps, (c) => c.resB)}`);
  console.log(`            | baseΣC=${T(cumCmps, (c) => c.baseC)} curΣC=${T(cumCmps, (c) => c.curC)} 복구예상ΣC=${T(cumCmps, (c) => c.resC)}`);
  console.log(`A/B/C 3항 완전 일치: ${cumCmps.filter((c) => c.ok).length} / ${cumCmps.length}`);
  console.log(`A 만 일치           : ${cumCmps.filter((c) => c.dA === 0).length} / ${cumCmps.length}`);
  console.log(`복구 후에도 base 미달(resA<baseA): ${cumCmps.filter((c) => c.dA < 0).length}명  Σ부족=${T(cumCmps.filter((c) => c.dA < 0), (c) => c.dA)}`);
  console.log(`복구 후 base 초과   (resA>baseA): ${cumCmps.filter((c) => c.dA > 0).length}명  Σ초과=${T(cumCmps.filter((c) => c.dA > 0), (c) => c.dA)}`);

  console.log("\n  ── 누적 A 차이 상위 20 (|resA−baseA|) ──");
  for (const c of [...cumCmps].filter((c) => c.dA !== 0).sort((a, b) => Math.abs(b.dA) - Math.abs(a.dA)).slice(0, 20))
    console.log(`   ${c.name.padEnd(7)}${c.org.padEnd(8)}${c.test ? "T" : " "} base A/B/C=${c.baseA}/${c.baseB}/${c.baseC}  cur=${c.curA}/${c.curB}/${c.curC}  복구예상=${c.resA}/${c.resB}/${c.resC}  ΔA=${c.dA}`);

  const out = `claudedocs/recover-uwp-baseline-${STAMP}.json`;
  writeFileSync(out, JSON.stringify({ weekly: { total: nonTrivial.length, match: nonTrivial.filter((c) => c.match).length, mismatchRealUser: realMismatch.length, sample: realMismatch.slice(0, 200) }, cumulative: cumCmps }, null, 1), "utf8");
  console.log(`\n→ ${out}`);
  console.log("\n=== DONE (writes: 0) ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
