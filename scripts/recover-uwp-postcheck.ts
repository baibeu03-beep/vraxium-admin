/**
 * READ-ONLY — STEP 40 이 실제로 COMMIT 됐는지 DB 에서 직접 확인한다 (보고된 값에 의존하지 않음).
 *   npx tsx --env-file=.env.local scripts/recover-uwp-postcheck.ts
 * DB write 0.
 */
import { readFileSync, readdirSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const EXPECT = {
  rows: 11508, users: 629,
  finalA: 474277, finalAdv: 39766, finalPen: 22525,
  deltaA: 449474, deltaAdv: 30810, deltaPen: 18891,
  preA: 24803, preAdv: 8956, prePen: 3634,
  uwpRows: 14581,
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

let fail = 0;
const ck = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " — " + String(detail) : ""}`);
};

async function tableCount(t: string): Promise<number | null> {
  const { count, error } = await supabaseAdmin.from(t).select("*", { count: "exact", head: true });
  return error ? null : (count ?? 0);
}

async function main() {
  console.log("═══ ① 보조 표 존재 여부 ═══");
  const staging = await tableCount("uwp_recovery_staging_20260726");
  const chunkman = await tableCount("uwp_recovery_chunk_manifest_20260726");
  const backup = await tableCount("uwp_point_recovery_backup_20260726");
  ck("staging 표", staging !== null, `행 ${staging ?? "(부재)"}`);
  ck("chunk manifest", chunkman !== null, `행 ${chunkman ?? "(부재)"}`);
  ck("백업 표(= STEP 40 이 실행됐다는 직접 증거)", backup !== null, `행 ${backup ?? "(부재 → STEP 40 미실행)"}`);
  if (staging !== null) ck("staging 행수 11508", staging === EXPECT.rows, staging);

  console.log("\n═══ ② user_weekly_points 현재 합계 ═══");
  const uwp = await pageAll<{ id: string; user_id: string; year: number | null; week_number: number | null; points: number | null; advantages: number | null; penalty: number | null; legacy_points: number | null; legacy_advantages: number | null; legacy_penalty: number | null; checks_migrated: boolean | null }>(
    (f, t) => supabaseAdmin.from("user_weekly_points").select("id,user_id,year,week_number,points,advantages,penalty,legacy_points,legacy_advantages,legacy_penalty,checks_migrated").order("id").range(f, t));
  const A = uwp.reduce((s, r) => s + (r.points ?? 0), 0);
  const AD = uwp.reduce((s, r) => s + (r.advantages ?? 0), 0);
  const P = uwp.reduce((s, r) => s + (r.penalty ?? 0), 0);
  console.log(`  행 ${uwp.length} · ΣA ${A} · Σadv ${AD} · Σpen ${P}`);
  const applied = A === EXPECT.finalA && AD === EXPECT.finalAdv && P === EXPECT.finalPen;
  const notApplied = A === EXPECT.preA && AD === EXPECT.preAdv && P === EXPECT.prePen;
  ck("행수 14581 유지", uwp.length === EXPECT.uwpRows, uwp.length);
  ck(`최종 A ${EXPECT.finalA}`, A === EXPECT.finalA, A);
  ck(`최종 raw advantage ${EXPECT.finalAdv}`, AD === EXPECT.finalAdv, AD);
  ck(`최종 penalty ${EXPECT.finalPen}`, P === EXPECT.finalPen, P);
  if (notApplied) console.log("  ⚠ 합계가 복구 전 값과 완전히 동일 — STEP 40 이 COMMIT 되지 않았을 가능성이 매우 높다.");

  if (staging === null) {
    console.log("\n판정: staging 표가 없어 대조 불가 — STEP 10/20 부터 확인 필요");
    process.exit(1);
  }

  console.log("\n═══ ③ staging 계획 대비 실제 값 ═══");
  const st = await pageAll<{ uwp_id: string; user_id: string; points: number; advantages: number; penalty: number; pre_points: number; pre_advantages: number; pre_penalty: number }>(
    (f, t) => supabaseAdmin.from("uwp_recovery_staging_20260726").select("uwp_id,user_id,points,advantages,penalty,pre_points,pre_advantages,pre_penalty").order("uwp_id").range(f, t));
  const byId = new Map(uwp.map((r) => [r.id, r]));
  let matchTarget = 0, matchPre = 0, other = 0;
  for (const s of st) {
    const u = byId.get(s.uwp_id);
    if (!u) { other++; continue; }
    if ((u.points ?? 0) === s.points && (u.advantages ?? 0) === s.advantages && (u.penalty ?? 0) === s.penalty) matchTarget++;
    else if ((u.points ?? 0) === s.pre_points && (u.advantages ?? 0) === s.pre_advantages && (u.penalty ?? 0) === s.pre_penalty) matchPre++;
    else other++;
  }
  console.log(`  계획 목표값과 일치(복구됨) : ${matchTarget}`);
  console.log(`  pre 값과 일치(미복구)      : ${matchPre}`);
  console.log(`  둘 다 아님                 : ${other}`);
  ck("전 대상이 목표값", matchTarget === EXPECT.rows, `${matchTarget}/${EXPECT.rows}`);
  ck("사용자 629명", new Set(st.map((s) => s.user_id)).size === EXPECT.users, new Set(st.map((s) => s.user_id)).size);

  console.log("\n═══ ④ 계층 불변식 (points = legacy + Σ활성 award) ═══");
  const ppa = await pageAll<{ user_id: string; year: number | null; week_number: number | null; point_check: number | null; point_advantage: number | null; point_penalty: number | null; cancelled_at: string | null }>(
    (f, t) => supabaseAdmin.from("process_point_awards").select("user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at").order("id").range(f, t));
  const aw = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of ppa) {
    if (r.cancelled_at) continue;
    const k = `${r.user_id}|${r.year}|${r.week_number}`;
    const e = aw.get(k) ?? { a: 0, adv: 0, pen: 0 };
    e.a += r.point_check ?? 0; e.adv += r.point_advantage ?? 0; e.pen += Math.abs(r.point_penalty ?? 0);
    aw.set(k, e);
  }
  let inv = 0;
  for (const r of uwp) {
    const a = aw.get(`${r.user_id}|${r.year}|${r.week_number}`) ?? { a: 0, adv: 0, pen: 0 };
    if ((r.points ?? 0) !== (r.legacy_points ?? 0) + a.a
      || (r.advantages ?? 0) !== (r.legacy_advantages ?? 0) + a.adv
      || (r.penalty ?? 0) !== (r.legacy_penalty ?? 0) + a.pen) inv++;
  }
  ck("불변식 위반 0", inv === 0, `${inv} / ${uwp.length}`);

  console.log("\n═══ ⑤ 계획 밖 행 변경 (백업표 대조) ═══");
  if (backup === null) {
    console.log("  ⚠ 백업 표 부재 — STEP 40 미실행으로 판단");
  } else {
    const bk = await pageAll<{ id: string; points: number | null; advantages: number | null; penalty: number | null; checks_migrated: boolean | null }>(
      (f, t) => supabaseAdmin.from("uwp_point_recovery_backup_20260726").select("id,points,advantages,penalty,checks_migrated").order("id").range(f, t));
    const stIds = new Set(st.map((s) => s.uwp_id));
    const bkById = new Map(bk.map((r) => [r.id, r]));
    let outside = 0, cmChanged = 0;
    for (const r of uwp) {
      const b = bkById.get(r.id);
      if (!b) continue;
      if (r.checks_migrated !== b.checks_migrated) cmChanged++;
      if (stIds.has(r.id)) continue;
      if ((r.points ?? 0) !== (b.points ?? 0) || (r.advantages ?? 0) !== (b.advantages ?? 0) || (r.penalty ?? 0) !== (b.penalty ?? 0)) outside++;
    }
    ck("계획 밖 행 변경 0", outside === 0, outside);
    ck("checks_migrated 변경 0", cmChanged === 0, cmChanged);
    ck("백업 행수 = uwp 행수", bk.length === uwp.length, `${bk.length} / ${uwp.length}`);
  }

  console.log("\n═══ 판정 ═══");
  if (applied && fail === 0) console.log("✅ STEP 40 COMMIT 확인 — 전 항목 기대값 일치");
  else if (notApplied) console.log("❌ STEP 40 미적용 — user_weekly_points 가 복구 전 값 그대로다");
  else console.log(`❌ 부분/이상 상태 — 실패 항목 ${fail}개`);
  process.exit(applied && fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
