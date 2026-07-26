/**
 * 실 DB 왕복 검증 — 수정된 재계산 경로가 레거시 기준값을 보존하는지 **프로덕션 함수 그대로** 확인.
 *   npx tsx --env-file=.env.local scripts/verify-weekly-points-roundtrip.ts            # preview(대상만 출력)
 *   npx tsx --env-file=.env.local scripts/verify-weekly-points-roundtrip.ts --run
 *
 * 안전 계약:
 *   · 대상은 **test_user_markers 계정** 1명·1주차뿐. 실사용자 무접촉.
 *   · 시작 전 대상 행 원본을 메모리+파일에 보관하고, 어떤 경로로 끝나든 finally 에서 원복한다.
 *   · 생성하는 award 행은 이 스크립트가 만든 (source='irregular', ref_id=<전용 UUID>) 하나뿐이며
 *     종료 시 삭제한다. 기존 원장 행은 조회만 한다.
 *   · 단계마다 기대값과 대조하고, 하나라도 어긋나면 즉시 원복 후 비정상 종료한다.
 *
 * 검증 시나리오(요청 §2·§9):
 *   A. 재계산 no-op        — award 없는 레거시 주차 재계산 → 값 불변(구버전이면 0 으로 파괴됐다)
 *   B. award 적립          → legacy + award
 *   C. award 취소(soft)    → 정확히 legacy 복귀
 *   D. award 재활성        → 다시 legacy + award
 *   E. award 삭제(hard)    → 정확히 legacy 복귀
 *   F. PMS 재동기화 형상   — legacy_* 를 ledger 재합산으로 다시 쓴 뒤 재계산 → legacy + award 유지
 *   G. 25회 반복 재계산    → 값 불변(증가·감소 없음)
 */
import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeWeeklyPointsForUsers } from "@/lib/processPointAccrual";

const RUN = process.argv.includes("--run");
/** --real: 복구된 **실사용자** 행을 대상으로 한다(복구 포인트가 award 변동에 살아남는지 확인).
 *  기본(플래그 없음)은 test_user_markers 계정만 건드린다. */
const REAL = process.argv.includes("--real");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

type Row = {
  id: string; user_id: string; year: number; week_number: number; week_start_date: string;
  points: number; advantages: number; penalty: number;
  legacy_points: number | null; legacy_advantages: number | null; legacy_penalty: number | null;
  checks_migrated: boolean;
};

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}${!ok && detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) throw new Error(`검증 실패: ${name}`);
}

async function readRow(id: string): Promise<Row> {
  const { data, error } = await supabaseAdmin
    .from("user_weekly_points")
    .select("id,user_id,year,week_number,week_start_date,points,advantages,penalty,legacy_points,legacy_advantages,legacy_penalty,checks_migrated")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data as Row;
}

const shape = (r: Row) => `${r.points}/${r.advantages}/${r.penalty} (legacy ${r.legacy_points}/${r.legacy_advantages}/${r.legacy_penalty})`;
const sameTotals = (r: Row, p: number, a: number, c: number) => r.points === p && r.advantages === a && r.penalty === c;
const sameLegacy = (r: Row, b: Row) =>
  r.legacy_points === b.legacy_points && r.legacy_advantages === b.legacy_advantages && r.legacy_penalty === b.legacy_penalty;

async function main() {
  // ── 대상 선정: 테스트 계정 · 레거시 era 주차 · legacy>0 · award 없음 ──
  const markers = new Set(
    ((await supabaseAdmin.from("test_user_markers").select("user_id")).data ?? []).map((m: { user_id: string }) => m.user_id),
  );
  const { data: cands } = await supabaseAdmin
    .from("user_weekly_points")
    .select("id,user_id,year,week_number,week_start_date,points,advantages,penalty,legacy_points,legacy_advantages,legacy_penalty,checks_migrated")
    .gt("legacy_points", 0)
    .gt("legacy_advantages", 0)
    .lt("week_start_date", "2026-06-29")
    .order("id")
    .limit(500);

  const { data: awardKeys } = await supabaseAdmin.from("process_point_awards").select("user_id,year,week_number");
  const taken = new Set(((awardKeys ?? []) as Array<{ user_id: string; year: number; week_number: number }>).map((r) => `${r.user_id}|${r.year}|${r.week_number}`));

  // --real: 복구 스코프(staging)에 등재된 실사용자 행 중에서 고른다.
  let recovered = new Set<string>();
  if (REAL) {
    const { data: st } = await supabaseAdmin.from("uwp_recovery_staging_20260726").select("uwp_id").limit(20000);
    recovered = new Set(((st ?? []) as Array<{ uwp_id: string }>).map((r) => r.uwp_id));
    if (recovered.size === 0) throw new Error("staging 표가 비어 있다 — --real 대상 특정 불가");
  }
  const target = ((cands ?? []) as Row[]).find((r) =>
    REAL
      ? !markers.has(r.user_id) && recovered.has(r.id) && !taken.has(`${r.user_id}|${r.year}|${r.week_number}`)
      : markers.has(r.user_id) && !taken.has(`${r.user_id}|${r.year}|${r.week_number}`),
  );
  if (!target) throw new Error(`적합한 ${REAL ? "실사용자(복구분)" : "테스트"} 대상 없음 — 중단(write 0)`);

  const { data: week } = await supabaseAdmin
    .from("weeks").select("id").eq("iso_year", target.year).eq("iso_week", target.week_number).maybeSingle();
  const weekId = (week as { id: string } | null)?.id;
  if (!weekId) throw new Error("weeks 행 없음 — 중단(write 0)");

  const { data: prof } = await supabaseAdmin.from("user_profiles").select("display_name").eq("user_id", target.user_id).maybeSingle();
  const name = (prof as { display_name: string } | null)?.display_name ?? target.user_id.slice(0, 8);

  console.log(`대상: ${name} (${REAL ? "실사용자·복구분" : "test 계정"}) ${target.week_start_date} [${target.year}W${target.week_number}]`);
  console.log(`원본: ${shape(target)} cm=${target.checks_migrated}`);
  console.log(`weekId=${weekId} uwpId=${target.id}`);

  if (!RUN) {
    console.log("\npreview — write 0. 실제 실행은 --run");
    return;
  }

  mkdirSync("backups", { recursive: true });
  const backupPath = `backups/roundtrip-target-${STAMP}.json`;
  writeFileSync(backupPath, JSON.stringify({ target, weekId }, null, 1), "utf8");
  console.log(`원본 백업 → ${backupPath}\n`);

  const B = target; // baseline
  const refId = randomUUID();
  const AW = { a: 3, adv: 2, pen: 1 };
  let awardCreated = false;

  try {
    // ── A. 재계산 no-op (구버전이면 여기서 0/0/0 으로 파괴됐다) ──
    console.log("A. award 없는 레거시 주차 재계산 (구버전이면 파괴되던 지점)");
    await recomputeWeeklyPointsForUsers([B.user_id], weekId);
    let r = await readRow(B.id);
    check("값 불변(레거시 보존)", sameTotals(r, B.points, B.advantages, B.penalty), shape(r));
    check("legacy 층 불변", sameLegacy(r, B), shape(r));
    check("checks_migrated 보존", r.checks_migrated === B.checks_migrated, r.checks_migrated);

    // ── B. award 적립 ──
    console.log("\nB. award 적립 (3/2/1)");
    {
      const { error } = await supabaseAdmin.from("process_point_awards").insert({
        source: "irregular", ref_id: refId, user_id: B.user_id, year: B.year, week_number: B.week_number,
        point_check: AW.a, point_advantage: AW.adv, point_penalty: AW.pen,
        organization_slug: null, scope_mode: "test", updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(`award insert: ${error.message}`);
      awardCreated = true;
    }
    await recomputeWeeklyPointsForUsers([B.user_id], weekId);
    r = await readRow(B.id);
    check("A = legacy + award", sameTotals(r, B.points + AW.a, B.advantages + AW.adv, B.penalty + AW.pen), shape(r));
    check("legacy 층 불변", sameLegacy(r, B), shape(r));

    // ── C. award 취소(soft) ──
    console.log("\nC. award 취소(soft cancel)");
    {
      const { error } = await supabaseAdmin.from("process_point_awards")
        .update({ cancelled_at: new Date().toISOString(), cancel_reason: "roundtrip-verify" })
        .eq("source", "irregular").eq("ref_id", refId);
      if (error) throw new Error(`cancel: ${error.message}`);
    }
    await recomputeWeeklyPointsForUsers([B.user_id], weekId);
    r = await readRow(B.id);
    check("정확히 baseline 복귀", sameTotals(r, B.points, B.advantages, B.penalty), shape(r));
    check("legacy 층 불변", sameLegacy(r, B), shape(r));

    // ── D. award 재활성 ──
    console.log("\nD. award 재활성");
    {
      const { error } = await supabaseAdmin.from("process_point_awards")
        .update({ cancelled_at: null, cancel_reason: null }).eq("source", "irregular").eq("ref_id", refId);
      if (error) throw new Error(`reactivate: ${error.message}`);
    }
    await recomputeWeeklyPointsForUsers([B.user_id], weekId);
    r = await readRow(B.id);
    check("다시 legacy + award", sameTotals(r, B.points + AW.a, B.advantages + AW.adv, B.penalty + AW.pen), shape(r));

    // ── F. PMS 재동기화 형상 (legacy 를 ledger 재합산으로 재기입) ──
    console.log("\nF. PMS 재동기화 형상 — legacy_* 재기입 후 재계산");
    {
      const { error } = await supabaseAdmin.from("user_weekly_points")
        .update({ legacy_points: B.legacy_points, legacy_advantages: B.legacy_advantages, legacy_penalty: B.legacy_penalty })
        .eq("id", B.id);
      if (error) throw new Error(`legacy rewrite: ${error.message}`);
    }
    await recomputeWeeklyPointsForUsers([B.user_id], weekId);
    r = await readRow(B.id);
    check("legacy + award 유지(award 기여분 미소실)", sameTotals(r, B.points + AW.a, B.advantages + AW.adv, B.penalty + AW.pen), shape(r));

    // ── G. 25회 반복 재계산 ──
    console.log("\nG. 25회 반복 재계산");
    for (let i = 0; i < 25; i++) await recomputeWeeklyPointsForUsers([B.user_id], weekId);
    r = await readRow(B.id);
    check("25회 후에도 값 불변", sameTotals(r, B.points + AW.a, B.advantages + AW.adv, B.penalty + AW.pen), shape(r));
    check("legacy 층 불변", sameLegacy(r, B), shape(r));

    // ── E. award 삭제(hard) ──
    console.log("\nE. award 삭제(hard delete)");
    {
      const { error } = await supabaseAdmin.from("process_point_awards").delete().eq("source", "irregular").eq("ref_id", refId);
      if (error) throw new Error(`delete: ${error.message}`);
      awardCreated = false;
    }
    await recomputeWeeklyPointsForUsers([B.user_id], weekId);
    r = await readRow(B.id);
    check("정확히 baseline 복귀", sameTotals(r, B.points, B.advantages, B.penalty), shape(r));
    check("legacy 층 불변", sameLegacy(r, B), shape(r));
    check("checks_migrated 보존", r.checks_migrated === B.checks_migrated, r.checks_migrated);
  } finally {
    // ── 원복(어떤 경로로 끝나든 실행) ──
    console.log("\n[cleanup] 원복");
    if (awardCreated) {
      const { error } = await supabaseAdmin.from("process_point_awards").delete().eq("source", "irregular").eq("ref_id", refId);
      console.log(`  award 행 삭제: ${error ? `실패 ${error.message}` : "완료"}`);
    }
    const { error: restErr } = await supabaseAdmin.from("user_weekly_points").update({
      points: B.points, advantages: B.advantages, penalty: B.penalty,
      legacy_points: B.legacy_points, legacy_advantages: B.legacy_advantages, legacy_penalty: B.legacy_penalty,
      checks_migrated: B.checks_migrated,
    }).eq("id", B.id);
    console.log(`  uwp 행 원복: ${restErr ? `실패 ${restErr.message}` : "완료"}`);
    const fin = await readRow(B.id);
    const restored = sameTotals(fin, B.points, B.advantages, B.penalty) && sameLegacy(fin, B) && fin.checks_migrated === B.checks_migrated;
    console.log(`  최종 상태: ${shape(fin)} → ${restored ? "✅ 원본과 동일" : "❌ 불일치 — " + backupPath + " 로 수동 원복 필요"}`);
    const { count } = await supabaseAdmin.from("process_point_awards").select("*", { count: "exact", head: true }).eq("ref_id", refId);
    console.log(`  잔존 테스트 award 행: ${count ?? 0} ${(count ?? 0) === 0 ? "✅" : "❌"}`);
    if (!restored || (count ?? 0) !== 0) failed++;
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAIL"} — passed ${passed} / failed ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\n✖", e instanceof Error ? e.message : e); process.exit(1); });
