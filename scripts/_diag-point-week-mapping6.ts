// READ-ONLY 진단 6 — 2026-07-25 마이그레이션 §2 로 인한 주차별 포인트 소실량 정량화.
//   기준 원천 A: legacy_point_ledger(PMS 원장 206k행) → (user, week_id) 재구성
//   기준 원천 B: cluster4_roster_card_stats(2026-07-25T04:52 이전 갱신분 = 마이그 이전 누적)
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

const MIG_TS = "2026-07-25T04:52:05";

async function main() {
  const weeks = await pageAll<{
    id: string; season_key: string | null; week_number: Num; start_date: string | null; is_official_rest: boolean | null;
  }>((f, t) => supabaseAdmin.from("weeks")
    .select("id,season_key,week_number,start_date,is_official_rest").order("start_date").range(f, t));
  const weekById = new Map(weeks.map((w) => [w.id, w]));

  const uwp = await pageAll<{
    user_id: string; week_start_date: string | null; points: Num; advantages: Num; penalty: Num;
    checks_migrated: boolean | null; updated_at: string | null;
  }>((f, t) => supabaseAdmin.from("user_weekly_points")
    .select("user_id,week_start_date,points,advantages,penalty,checks_migrated,updated_at")
    .order("id").range(f, t));

  const ledger = await pageAll<{
    user_id: string; week_id: string | null; star: Num; shield: Num; entry_type: string | null;
  }>((f, t) => supabaseAdmin.from("legacy_point_ledger")
    .select("user_id,week_id,star,shield,entry_type").order("id").range(f, t));
  console.log(`legacy_point_ledger ${ledger.length}행 · entry_type: ${JSON.stringify(
    [...ledger.reduce((m, r) => m.set(r.entry_type ?? "null", (m.get(r.entry_type ?? "null") ?? 0) + 1), new Map<string, number>())],
  )}`);

  // 재구성: (user, week_start_date) → {a, adv, pen}
  const recon = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of ledger) {
    if (!r.week_id) continue;
    const w = weekById.get(r.week_id);
    if (!w?.start_date) continue;
    const k = `${r.user_id}::${w.start_date}`;
    const e = recon.get(k) ?? { a: 0, adv: 0, pen: 0 };
    e.a += Number(r.star ?? 0);
    if (r.entry_type === "POINTLOG") {
      const sh = Number(r.shield ?? 0);
      if (sh > 0) e.adv += sh;
      else if (sh < 0) e.pen += -sh;
    }
    recon.set(k, e);
  }

  const cur = new Map<string, { a: number; adv: number; pen: number; mig: boolean; zeroedByMig: boolean }>();
  for (const r of uwp) {
    if (!r.week_start_date) continue;
    const k = `${r.user_id}::${r.week_start_date}`;
    const e = cur.get(k) ?? { a: 0, adv: 0, pen: 0, mig: false, zeroedByMig: false };
    e.a += r.points ?? 0; e.adv += r.advantages ?? 0; e.pen += Math.abs(r.penalty ?? 0);
    e.mig = e.mig || !!r.checks_migrated;
    e.zeroedByMig = e.zeroedByMig || (String(r.updated_at ?? "").startsWith(MIG_TS) && !!r.checks_migrated);
    cur.set(k, e);
  }

  // 비교
  let keysMissingA = 0, lostA = 0, lostAdv = 0, lostPen = 0;
  const lostUsers = new Set<string>();
  const lostByWeek = new Map<string, { keys: number; a: number }>();
  const samples: string[] = [];
  for (const [k, exp] of recon) {
    const c = cur.get(k);
    const curA = c?.a ?? 0, curAdv = c?.adv ?? 0, curPen = c?.pen ?? 0;
    if (exp.a === curA && exp.adv === curAdv && exp.pen === curPen) continue;
    const [uid, start] = k.split("::");
    const dA = exp.a - curA;
    if (dA !== 0 || exp.adv - curAdv !== 0 || exp.pen - curPen !== 0) {
      keysMissingA += 1;
      lostA += dA; lostAdv += exp.adv - curAdv; lostPen += exp.pen - curPen;
      lostUsers.add(uid);
      const e = lostByWeek.get(start) ?? { keys: 0, a: 0 };
      e.keys += 1; e.a += dA;
      lostByWeek.set(start, e);
      if (samples.length < 15) {
        const w = weeks.find((x) => x.start_date === start);
        samples.push(
          `  ${uid.slice(0, 8)} ${start} ${w?.season_key} W${w?.week_number}${w?.is_official_rest ? " 휴식" : ""}` +
            ` 원장=${exp.a}/${exp.adv}/${exp.pen}  현재uwp=${curA}/${curAdv}/${curPen}` +
            ` (마이그로 0 처리=${c?.zeroedByMig ? "예" : "아니오"})`,
        );
      }
    }
  }
  console.log(`\n=== 원장 재구성 vs 현재 uwp ===`);
  console.log(`불일치 (user,week) 키: ${keysMissingA} · 영향 사용자 ${lostUsers.size}명`);
  console.log(`소실 합계 ΣA=${lostA}  Σadv=${lostAdv}  Σpen=${lostPen}`);
  samples.forEach((s) => console.log(s));

  console.log(`\n주차별 소실 상위 25:`);
  [...lostByWeek.entries()].sort((a, b) => b[1].a - a[1].a).slice(0, 25).forEach(([d, e]) => {
    const w = weeks.find((x) => x.start_date === d);
    console.log(`  ${d} ${w?.season_key} W${w?.week_number}${w?.is_official_rest ? " [휴식]" : ""}  키 ${e.keys}  ΣA소실 ${e.a}`);
  });

  // 기준 B: roster slim 미갱신분 vs 현재 uwp 합
  console.log(`\n=== roster slim(마이그 미갱신 = 이전 누적) vs 현재 uwp 누적 ===`);
  const roster = await pageAll<{ user_id: string; po_a: Num; po_b: Num; po_c: Num; updated_at: string | null }>(
    (f, t) => supabaseAdmin.from("cluster4_roster_card_stats").select("user_id,po_a,po_b,po_c,updated_at").order("user_id").range(f, t),
  );
  const curTotal = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of uwp) {
    const e = curTotal.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 };
    e.a += r.points ?? 0; e.adv += r.advantages ?? 0; e.pen += Math.abs(r.penalty ?? 0);
    curTotal.set(r.user_id, e);
  }
  let cmp = 0, diff = 0, diffA = 0;
  const dsamples: string[] = [];
  for (const r of roster) {
    if (!r.updated_at || r.updated_at >= MIG_TS) continue; // 마이그가 덮은 행 제외
    const c = curTotal.get(r.user_id);
    if (!c) continue;
    cmp += 1;
    if ((r.po_a ?? 0) !== c.a) {
      diff += 1; diffA += (r.po_a ?? 0) - c.a;
      if (dsamples.length < 12) dsamples.push(`  ${r.user_id.slice(0, 8)} roster(이전) A=${r.po_a} → 현재 uwp A=${c.a}  차 ${(r.po_a ?? 0) - c.a}`);
    }
  }
  console.log(`비교 대상 ${cmp}명 · A 불일치 ${diff}명 · 합계 차 ${diffA}`);
  dsamples.forEach((s) => console.log(s));
}

main().catch((e) => { console.error(e); process.exit(1); });
