/**
 * 프로세스 체크 포인트(point_check/advantage/penalty) 수정 → 적립 반영 추적 (READ-ONLY).
 *   운영 무변경. 현재 DB 상태로 "코드 경로가 실제로 작동했는지"를 사후 확인한다.
 *
 *   확인:
 *     1) process_point_awards(적립 원장) 존재/적립 행 통계 (source/year/week)
 *     2) 원장 ↔ user_weekly_points 정합: 적립된 (user,year,week) 의 uwp.points/adv/pen 이
 *        원장 합과 일치하는가 (= recomputeWeeklyPoints 가 반영됐는가)
 *     3) era 게이트 현실: 오늘 기준 적립 허용 주차(summer W1+/test W13)와 차단 주차 분포
 *     4) process_acts 마스터 point 값 분포 + 마스터 수정 경로 부재 메모
 *     5) manual_grant 상태행 ↔ 원장 ↔ uwp 샘플 추적
 *
 *   npx tsx --env-file=.env.local scripts/verify-process-check-edit-accrual.ts
 */
import { createClient } from "@supabase/supabase-js";
import { isAccrualAllowedWeek } from "@/lib/processPointAccrual";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`오늘=${today} · summer W1(EFFECTIVE_FROM)=${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}\n`);

  // 1) 원장 존재/통계
  const probe = await sb.from("process_point_awards").select("id", { count: "exact", head: true });
  if (probe.error) {
    console.log(`✗ process_point_awards 미적용/조회불가: ${probe.error.code} ${probe.error.message}`);
    console.log("  → 마이그레이션(2026-06-15_process_point_awards.sql) 미적용이면 적립 자체가 스킵됩니다.");
    return;
  }
  console.log(`1) 적립 원장 총 ${probe.count ?? 0} 행`);

  const { data: awards } = await sb
    .from("process_point_awards")
    .select("source,user_id,year,week_number,point_check,point_advantage,point_penalty");
  const rows = (awards ?? []) as any[];
  if (rows.length === 0) {
    console.log("  ⚠ 적립 원장 0행 — 아직 어떤 액트도 적립되지 않음(era 차단/미완료/미적용 가능).");
  } else {
    const bySrc = new Map<string, number>();
    const byWeek = new Map<string, number>();
    for (const r of rows) {
      bySrc.set(r.source, (bySrc.get(r.source) ?? 0) + 1);
      byWeek.set(`${r.year}-W${r.week_number}`, (byWeek.get(`${r.year}-W${r.week_number}`) ?? 0) + 1);
    }
    console.log("   source별:", JSON.stringify(Object.fromEntries(bySrc)));
    console.log("   주차별:", JSON.stringify(Object.fromEntries(byWeek)));
  }

  // 2) 원장 ↔ user_weekly_points 정합 (적립된 user,year,week 전수)
  const keys = new Map<string, { user: string; y: number; w: number; pc: number; pa: number; pp: number }>();
  for (const r of rows) {
    const k = `${r.user_id}|${r.year}|${r.week_number}`;
    const e = keys.get(k) ?? { user: r.user_id, y: r.year, w: r.week_number, pc: 0, pa: 0, pp: 0 };
    e.pc += r.point_check ?? 0; e.pa += r.point_advantage ?? 0; e.pp += r.point_penalty ?? 0;
    keys.set(k, e);
  }
  let checked = 0, mismatch = 0;
  for (const e of keys.values()) {
    const { data: uwp } = await sb
      .from("user_weekly_points")
      .select("points,advantages,penalty")
      .eq("user_id", e.user).eq("year", e.y).eq("week_number", e.w).maybeSingle();
    checked++;
    // uwp = 원장 합(operating summer base=0). 원장합과 정확히 같아야 한다(같은 user·year·week 의 다른 원장원천 없을 때).
    const ok = uwp && uwp.points === e.pc && uwp.advantages === e.pa && uwp.penalty === e.pp;
    if (!ok) {
      mismatch++;
      if (mismatch <= 5) console.log(`   ✗ uwp≠ledger user=${e.user.slice(0,8)} ${e.y}W${e.w}: uwp(${uwp?.points}/${uwp?.advantages}/${uwp?.penalty}) ledger(${e.pc}/${e.pa}/${e.pp})`);
    }
  }
  console.log(`\n2) 원장↔user_weekly_points: ${checked}건 검사 · 불일치 ${mismatch}건 ${mismatch === 0 ? "✓" : "✗"}`);
  if (checked === 0) console.log("   (적립 행 없어 정합 검사 대상 없음)");

  // 3) era 게이트 현실 — 주차 전체에 isAccrualAllowedWeek 적용
  const { data: weeks } = await sb.from("weeks").select("start_date,season_key,week_number");
  let opAllow = 0, opBlock = 0, testW13 = 0;
  for (const w of (weeks ?? []) as any[]) {
    if (isAccrualAllowedWeek("operating", w)) opAllow++; else opBlock++;
    if (!isAccrualAllowedWeek("operating", w) && isAccrualAllowedWeek("test", w)) testW13++;
  }
  console.log(`\n3) era 게이트(전체 ${(weeks ?? []).length}주):`);
  console.log(`   operating 적립 허용 ${opAllow}주(= start_date>=${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}) · 차단 ${opBlock}주`);
  console.log(`   test 전용 추가허용(W13 예외 등) ${testW13}주`);
  if (opAllow === 0) console.log("   ⚠ operating 허용 주차 0 — 오늘 기준 실유저 적립은 전부 era_blocked(설계상 과거 무접촉).");

  // 4) process_acts 마스터 point 분포 + 수정경로
  const { data: acts } = await sb.from("process_acts").select("point_check,point_advantage,point_penalty,is_active");
  const a = (acts ?? []) as any[];
  const nonZero = a.filter((x) => (x.point_check ?? 0) || (x.point_advantage ?? 0) || (x.point_penalty ?? 0));
  console.log(`\n4) process_acts 마스터 ${a.length}개 · point 비0 ${nonZero.length}개`);
  console.log("   ⚠ 마스터 point_check/advantage/penalty 는 createProcessAct(생성)·deleteProcessAct(삭제)만 — UPDATE 경로 없음.");
  console.log("   ⚠ 적립 시점에 process_acts 를 읽으므로, 마스터 수정은 '이후 신규 완료'부터 반영. 기존 원장은 revoke+재적립 전까지 불변.");

  // 5) manual_grant 상태행 추적
  const { data: mg, error: mgErr } = await sb
    .from("process_check_statuses")
    .select("id,completion_type,manual_point_check,manual_point_advantage,manual_point_penalty,week_id")
    .eq("completion_type", "manual_grant").limit(5);
  if (mgErr) {
    console.log(`\n5) manual_grant: 컬럼 조회 불가(${mgErr.code}) — manual_grant 마이그레이션 미적용 가능.`);
  } else {
    const m = (mg ?? []) as any[];
    console.log(`\n5) manual_grant 상태행 샘플 ${m.length}개 (manual_point_* → 적립 시 point_check/adv/pen 으로 사용):`);
    for (const r of m) {
      const led = await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("source", "regular").eq("ref_id", r.id);
      console.log(`   · ${r.id.slice(0,8)} manual(${r.manual_point_check}/${r.manual_point_advantage}/${r.manual_point_penalty}) → 원장 ${led.count ?? 0}행`);
    }
    if (m.length === 0) console.log("   (manual_grant 행 없음)");
  }

  console.log("\n— 추적 완료 (READ-ONLY, 운영 무변경) —");
}

main().catch((e) => { console.error(e); process.exit(1); });
