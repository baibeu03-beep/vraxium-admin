/**
 * READ-ONLY: pending 체크 상태가 /admin/processes/check 기준 "이번 주 가동(open) 체크 대상"인지 판정.
 *   readiness 게이트(assertWeekAccrualComplete)는 status=pending 만 세므로, 체크 페이지가 제외하는
 *   (미가동/미개설/체크대상아님) 액트도 미완료로 잡을 수 있다. 이 스크립트가 그 발산을 실측한다.
 *
 *   npx tsx --env-file=.env.local scripts/inspect-readiness-open-gate.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { isActOpenForWeek } from "@/lib/weekOpenGate";
import type { OrganizationSlug } from "@/lib/organizations";

async function main() {
  // 모든 pending 정규 체크 상태 — 전체 컬럼.
  const { data: pendRows } = await supabaseAdmin
    .from("process_check_statuses")
    .select("*")
    .eq("status", "pending");
  const pend = (pendRows ?? []) as any[];
  console.log(`=== pending 정규 체크 상태: ${pend.length}건 ===\n`);
  console.log(`[status 컬럼]: ${pend[0] ? Object.keys(pend[0]).join(", ") : "(없음)"}\n`);

  for (const r of pend) {
    // 액트 마스터.
    const { data: act } = await supabaseAdmin
      .from("process_acts")
      .select("act_name, hub, line_group_id, act_type, is_active, check_target")
      .eq("id", r.act_id)
      .maybeSingle();
    const a = act as any;
    // 오픈 설정.
    const { config, openConfirmed } = await loadWeekOpeningConfig(
      r.week_id,
      r.organization_slug as OrganizationSlug,
    );
    const open = a
      ? isActOpenForWeek({
          hub: r.hub,
          openConfirmed,
          config,
          lineGroupId: a.line_group_id,
          teamId: r.team_id ?? null,
        })
      : false;
    const isCheckTarget = a?.check_target === "check";

    console.log(`─ status.id=${r.id}`);
    console.log(`  org=${r.organization_slug} hub=${r.hub} team_id=${r.team_id ?? "(null)"} part_name=${r.part_name ?? "(null)"}`);
    console.log(`  week_id=${r.week_id} status=${r.status} completion_type=${r.completion_type ?? "-"}`);
    console.log(`  act: name="${a?.act_name}" is_active=${a?.is_active} check_target=${a?.check_target} lineGroup=${a?.line_group_id}`);
    console.log(`  openConfirmed=${openConfirmed}  ⇒ isCheckTarget=${isCheckTarget}  isOpenThisWeek=${open}`);
    console.log(`  scheduled_check_at=${r.scheduled_check_at} requested_at=${r.requested_at}`);
    console.log(`  ▶ 체크페이지 기준 유효 체크 대상(isCheckTarget && isOpenThisWeek) = ${isCheckTarget && open}`);
    console.log(`  ▶ readiness 게이트 기준 미완료 카운트 포함 = true (status=pending 이면 무조건)\n`);
  }

  // 이 주차 iso 년/주 별 process_point_awards 개수(awardCount 게이트 재료).
  const weekIds = [...new Set(pend.map((r) => r.week_id))];
  for (const wid of weekIds) {
    const { data: w } = await supabaseAdmin
      .from("weeks")
      .select("iso_year, iso_week, start_date")
      .eq("id", wid)
      .maybeSingle();
    const ww = w as any;
    if (ww?.iso_year != null && ww?.iso_week != null) {
      const { count } = await supabaseAdmin
        .from("process_point_awards")
        .select("id", { count: "exact", head: true })
        .eq("year", ww.iso_year)
        .eq("week_number", ww.iso_week);
      const { count: totalStatuses } = await supabaseAdmin
        .from("process_check_statuses")
        .select("id", { count: "exact", head: true })
        .eq("week_id", wid);
      console.log(`week ${wid} (${ww.start_date}, iso ${ww.iso_year}/${ww.iso_week}): process_point_awards=${count} · 전체 체크상태행=${totalStatuses}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
