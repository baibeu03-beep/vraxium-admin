/**
 * READ-ONLY 검증: 하드닝된 assertWeekAccrualComplete 가 /admin/processes/check 유효 체크 대상 SoT 와
 *   정합하는지. 운영 DB 미변경(SELECT 만 · 쓰기 없음).
 *   npx tsx --env-file=.env.local scripts/verify-readiness-accrual-gate-sot.ts
 *
 * 확인:
 *   1) 현재 pending 정규 체크(phalanx/experience/앱 '[브리핑] 파트 시작')는 유효 open 대상 → 여전히 카운트(정상 차단 유지).
 *   2) 변동 pending(encre review_request)도 그대로 카운트.
 *   3) 유효 대상 판정을 각 pending 행에 재현해 gate.pendingChecks 와 일치하는지 크로스체크.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertWeekAccrualComplete, type FinalizeWeekRow } from "@/lib/adminWeekUwsFinalize";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { isActOpenForWeek } from "@/lib/weekOpenGate";
import type { OrganizationSlug } from "@/lib/organizations";

async function main() {
  // pending 이 걸린 주차를 찾는다.
  const { data: pendRows } = await supabaseAdmin
    .from("process_check_statuses")
    .select("week_id")
    .eq("status", "pending");
  const weekIds = [...new Set(((pendRows ?? []) as any[]).map((r) => r.week_id))];
  if (weekIds.length === 0) {
    console.log("현재 pending 정규 체크가 없습니다. (검증 종료)");
    return;
  }

  for (const wid of weekIds) {
    const { data: w } = await supabaseAdmin
      .from("weeks")
      .select("id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest")
      .eq("id", wid)
      .maybeSingle();
    const week = w as FinalizeWeekRow | null;
    if (!week) continue;

    console.log(`\n════ week ${wid} (${(week as any).start_date}) ════`);

    // gate 실행(하드닝된 함수).
    const gate = await assertWeekAccrualComplete(week);
    console.log(`  gate.ok=${gate.ok}  pendingChecks=${gate.pendingChecks}  pendingIrregular=${gate.pendingIrregular}  awardCount=${gate.awardCount}`);
    console.log(`  reason=${gate.reason ?? "(없음)"}`);

    // 독립 재현: 이 주차 모든 정규 상태행을 유효 open 대상 기준으로 필터.
    const { data: rows } = await supabaseAdmin
      .from("process_check_statuses")
      .select("id,organization_slug,hub,line_group_id,act_id,team_id,status")
      .eq("week_id", wid);
    let manualPending = 0;
    let manualTotal = 0;
    let rawPending = 0;
    for (const r of (rows ?? []) as any[]) {
      if (r.status === "pending") rawPending++;
      const { data: act } = await supabaseAdmin
        .from("process_acts")
        .select("is_active,check_target,line_group_id")
        .eq("id", r.act_id)
        .maybeSingle();
      const a = act as any;
      if (!a || a.is_active !== true || a.check_target !== "check") continue;
      const { config, openConfirmed } = await loadWeekOpeningConfig(wid, r.organization_slug as OrganizationSlug);
      const open = isActOpenForWeek({ hub: r.hub, openConfirmed, config, lineGroupId: a.line_group_id, teamId: r.team_id });
      if (!open) continue;
      manualTotal++;
      if (r.status === "pending") manualPending++;
    }
    console.log(`  [독립재현] 유효 open pending=${manualPending}  유효 open total=${manualTotal}  (raw pending=${rawPending})`);
    console.log(`  ▶ gate.pendingChecks(${gate.pendingChecks}) === 독립재현(${manualPending}) ? ${gate.pendingChecks === manualPending ? "OK ✅" : "MISMATCH ❌"}`);
    if (rawPending !== manualPending) {
      console.log(`  ⚠ raw(${rawPending}) ≠ valid(${manualPending}) — 잔존 비대상 pending 행이 제외됨(하드닝 효과 발현).`);
    } else {
      console.log(`  · raw==valid — 현재 이 주차엔 비대상 잔존 pending 없음(모든 pending 이 유효 대상).`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
