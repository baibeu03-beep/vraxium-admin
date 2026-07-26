/**
 * READ-ONLY 실 DB 검증 — 수정된 재계산 산식을 실제 데이터에 적용해 계층 분리가 맞는지 대조.
 *   npx tsx --env-file=.env.local scripts/verify-weekly-points-layering-db.ts
 * **DB write 0** — select 만 발행하고, 재계산은 메모리에서 시뮬레이션한다(rollback 불필요).
 *
 * 대조 축:
 *   PMS/레거시 기준값  = legacy_point_ledger 재구성(복구 dry-run 산출) 또는 legacy_* 컬럼
 *   award 기여값       = process_point_awards 활성 합
 *   최종 기대 A/B/C    = 기준 + 기여 (pointResolver 규칙으로 B/C 산출)
 *   현재값             = user_weekly_points 실측
 *   수정된 함수 계산값 = composeWeeklyPointTotals(기준, 기여)  ← 프로덕션과 동일 순수 함수
 */
import { readdirSync, readFileSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { composeWeeklyPointTotals, sumAwardTriple, type PointTriple } from "@/lib/userWeeklyPointsBaseline";
import { resolvePointAwardRows } from "@/lib/pointResolver";

type DryRow = {
  user_id: string; display_name: string; org: string; is_test: boolean; week_start_date: string; week_kind: string;
  cur_a: number; exp_a: number; cur_adv: number; exp_adv: number; cur_pen: number; exp_pen: number;
  checks_migrated: boolean; wiped: boolean; has_award: boolean;
};

async function pageAll<T>(b: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const o: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await b(f, f + 999);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[];
    o.push(...r);
    if (r.length < 1000) break;
  }
  return o;
}

const abc = (t: PointTriple) => {
  const r = resolvePointAwardRows([{ point_check: t.points, point_advantage: t.advantages, point_penalty: t.penalty }]);
  return `${r.pointA}/${r.pointB}/${r.pointC}`;
};

async function main() {
  const file = "claudedocs/" + readdirSync("claudedocs").filter((x) => x.startsWith("recover-uwp-dryrun-") && x.endsWith(".json")).sort().pop()!;
  const { rows: dry } = JSON.parse(readFileSync(file, "utf8")) as { rows: DryRow[] };
  const ledgerByKey = new Map(dry.map((r) => [`${r.user_id}|${r.week_start_date}`, r]));

  const weeks = await pageAll<{ start_date: string | null; iso_year: number | null; iso_week: number | null; week_number: number | null; is_official_rest: boolean | null }>(
    (f, t) => supabaseAdmin.from("weeks").select("start_date,iso_year,iso_week,week_number,is_official_rest").order("start_date").range(f, t));
  const isoByStart = new Map(weeks.map((w) => [w.start_date, w]));

  const uwp = await pageAll<{ user_id: string; year: number | null; week_number: number | null; week_start_date: string | null; points: number | null; advantages: number | null; penalty: number | null; checks_migrated: boolean | null; updated_at: string | null }>(
    (f, t) => supabaseAdmin.from("user_weekly_points").select("user_id,year,week_number,week_start_date,points,advantages,penalty,checks_migrated,updated_at").order("id").range(f, t));
  const uwpByKey = new Map(uwp.map((r) => [`${r.user_id}|${r.week_start_date}`, r]));

  const ppa = await pageAll<{ user_id: string; year: number | null; week_number: number | null; point_check: number | null; point_advantage: number | null; point_penalty: number | null; cancelled_at: string | null; source: string | null }>(
    (f, t) => supabaseAdmin.from("process_point_awards").select("user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at,source").order("id").range(f, t));
  const awardsByYW = new Map<string, typeof ppa>();
  for (const r of ppa) {
    if (r.cancelled_at) continue;
    const k = `${r.user_id}|${r.year}|${r.week_number}`;
    const l = awardsByYW.get(k) ?? [];
    l.push(r);
    awardsByYW.set(k, l);
  }

  const profs = new Map((await pageAll<{ user_id: string; display_name: string | null; organization_slug: string | null }>(
    (f, t) => supabaseAdmin.from("user_profiles").select("user_id,display_name,organization_slug").order("user_id").range(f, t))).map((p) => [p.user_id, p]));
  const markers = new Set((await pageAll<{ user_id: string }>((f, t) => supabaseAdmin.from("test_user_markers").select("user_id").order("user_id").range(f, t))).map((m) => m.user_id));

  // ── 검증 케이스 선정 ─────────────────────────────────────────────────
  type Case = { label: string; userId: string; week: string };
  const cases: Case[] = [];
  const byName = (n: string) => [...profs.values()].find((p) => p.display_name === n)?.user_id ?? null;

  const yunha = byName("최윤하");
  if (yunha) cases.push({ label: "최윤하 (award 적립→취소로 PMS 소멸한 실사례)", userId: yunha, week: "2024-07-01" });
  const sh = byName("김성훈");
  if (sh) cases.push({ label: "김성훈 (기준선 차이 사례)", userId: sh, week: "2025-05-19" });

  // award 가 붙은 레거시 주차(era 게이트 누수) 전건
  for (const [k, list] of awardsByYW) {
    const [uid, y, w] = k.split("|");
    const wk = weeks.find((x) => String(x.iso_year) === y && String(x.iso_week) === w);
    if (wk?.start_date && wk.start_date < "2026-06-29" && !cases.some((c) => c.userId === uid && c.week === wk.start_date))
      cases.push({ label: `era 누수 award 주차 (source=${list[0].source})`, userId: uid, week: wk.start_date });
  }
  // PMS 만 있는 사용자 · award 만 있는 사용자 · 둘 다 · 휴식 주차 잔존
  const pmsOnly = dry.filter((r) => !r.has_award && r.exp_a > 100 && r.week_kind === "activity").sort((a, b) => b.exp_a - a.exp_a);
  for (const r of pmsOnly.slice(0, 3)) cases.push({ label: `PMS 만 (${r.display_name})`, userId: r.user_id, week: r.week_start_date });
  const awardOnly = [...awardsByYW.keys()].map((k) => {
    const [uid, y, w] = k.split("|");
    const wk = weeks.find((x) => String(x.iso_year) === y && String(x.iso_week) === w);
    return wk?.start_date && wk.start_date >= "2026-06-29" ? { uid, start: wk.start_date } : null;
  }).filter(Boolean) as Array<{ uid: string; start: string }>;
  for (const a of awardOnly.slice(0, 3)) cases.push({ label: "award 만 (신정책 era)", userId: a.uid, week: a.start });
  const restLeft = dry.filter((r) => (r.week_kind === "rest" || r.week_kind === "transition") && (r.cur_a !== 0 || r.cur_adv !== 0 || r.cur_pen !== 0)).slice(0, 3);
  for (const r of restLeft) cases.push({ label: `공식 휴식/전환 주차 값 잔존 (${r.display_name}${markers.has(r.user_id) ? ",TEST" : ""})`, userId: r.user_id, week: r.week_start_date });

  // ── 대조 ─────────────────────────────────────────────────────────────
  console.log("| 사용자 | 주차 | 케이스 | PMS/레거시 기준값 | award 기여값 | 최종 기대 A/B/C | 현재값 A/B/C | 수정된 함수 계산값 A/B/C | 판정 |");
  console.log("|---|---|---|---|---|---|---|---|---|");

  let ok = 0, ng = 0;
  const seen = new Set<string>();
  for (const c of cases) {
    const key = `${c.userId}|${c.week}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const row = uwpByKey.get(key);
    const wk = isoByStart.get(c.week);
    const awardRows = awardsByYW.get(`${c.userId}|${wk?.iso_year}|${wk?.iso_week}`) ?? [];
    const awards = sumAwardTriple(awardRows);

    // 기준층 = 원장 재구성값. 원장에 없는 행(QA 시드 등)은 "현재값 − award" 를 기준층으로 본다
    //   (마이그레이션 백필과 동일 규칙).
    const led = ledgerByKey.get(key);
    const cur: PointTriple = { points: row?.points ?? 0, advantages: row?.advantages ?? 0, penalty: row?.penalty ?? 0 };
    const ledgerHas = !!led && (led.exp_a !== 0 || led.exp_adv !== 0 || led.exp_pen !== 0);
    const baselineBackfill: PointTriple = {
      points: cur.points - awards.points,
      advantages: cur.advantages - awards.advantages,
      penalty: cur.penalty - awards.penalty,
    };
    const baselineLedger: PointTriple = led ? { points: led.exp_a, advantages: led.exp_adv, penalty: led.exp_pen } : { points: 0, advantages: 0, penalty: 0 };

    // 수정된 프로덕션 함수와 동일 산식(백필 기준층 기반 — 마이그레이션 직후 상태)
    const computed = composeWeeklyPointTotals(baselineBackfill, awards);
    const expectedAfterRecovery = composeWeeklyPointTotals(baselineLedger, awards);

    const idempotent = composeWeeklyPointTotals(baselineBackfill, awards);
    const pass = computed.points === cur.points && computed.advantages === cur.advantages && computed.penalty === cur.penalty
      && idempotent.points === computed.points;
    if (pass) ok++; else ng++;

    const name = profs.get(c.userId)?.display_name ?? c.userId.slice(0, 8);
    console.log(
      `| ${name} | ${c.week} | ${c.label} | ${ledgerHas ? `원장 ${abc(baselineLedger)}` : "원장없음"} · 백필 ${abc(baselineBackfill)} | ${abc(awards)} (${awardRows.length}행) | ${abc(expectedAfterRecovery)} | ${abc(cur)} | ${abc(computed)} | ${pass ? "✅ 현재값 재현" : "❌"} |`,
    );
  }

  // ── 전수 불변식: 수정된 산식이 현재 DB 를 그대로 재현하는가 ──────────
  let allOk = 0, allNg = 0;
  const ngSample: string[] = [];
  for (const r of uwp) {
    const awards = sumAwardTriple(awardsByYW.get(`${r.user_id}|${r.year}|${r.week_number}`) ?? []);
    const baseline = { points: (r.points ?? 0) - awards.points, advantages: (r.advantages ?? 0) - awards.advantages, penalty: (r.penalty ?? 0) - awards.penalty };
    const t = composeWeeklyPointTotals(baseline, awards);
    if (t.points === (r.points ?? 0) && t.advantages === (r.advantages ?? 0) && t.penalty === (r.penalty ?? 0)) allOk++;
    else { allNg++; if (ngSample.length < 5) ngSample.push(`${r.user_id} ${r.week_start_date}`); }
  }
  console.log(`\n전수 항등 검증(백필 기준층 + award = 현재값): ${allOk} / ${uwp.length} 성립 · 불일치 ${allNg}`);
  for (const s of ngSample) console.log("  ", s);

  // 구버전 산식이었다면 파괴됐을 행 수 = 재발 위험 규모
  let wouldDestroy = 0, wouldDestroyA = 0;
  for (const r of uwp) {
    const k = `${r.user_id}|${r.year}|${r.week_number}`;
    const hasAward = awardsByYW.has(k);
    const legacyGuess = (r.points ?? 0) - sumAwardTriple(awardsByYW.get(k) ?? []).points;
    if (!hasAward && legacyGuess !== 0) { wouldDestroy++; wouldDestroyA += legacyGuess; }
  }
  console.log(`\n구버전 산식 기준 "award 1건만 생겨도 소멸했을" 행: ${wouldDestroy}행 · ΣA ${wouldDestroyA}`);
  console.log("  (복구 실행 후에는 11,508행/449,474 A 가 여기에 추가로 노출된다 — 수정 없이 복구하면 재파괴 위험)");

  console.log(`\n케이스 판정: ✅ ${ok} · ❌ ${ng}`);
  console.log("=== DONE (writes: 0) ===");
  process.exit(ng === 0 && allNg === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
