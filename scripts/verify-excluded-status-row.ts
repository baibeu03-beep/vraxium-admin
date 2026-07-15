/** READ-ONLY: 하드닝 필터가 제외한 상태행이 실제로 비대상(비활성/none/미가동)인지 확인. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { isActOpenForWeek } from "@/lib/weekOpenGate";
import type { OrganizationSlug } from "@/lib/organizations";

async function main() {
  const wid = "39aae7a0-216f-4262-8a67-6beef1bccf22";
  const { data: rows } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,organization_slug,hub,line_group_id,act_id,team_id,status")
    .eq("week_id", wid);
  console.log(`전체 상태행: ${(rows ?? []).length}`);
  for (const r of (rows ?? []) as any[]) {
    const { data: act } = await supabaseAdmin
      .from("process_acts").select("act_name,is_active,check_target,line_group_id").eq("id", r.act_id).maybeSingle();
    const a = act as any;
    let reason = "유효(포함)";
    if (!a) reason = "제외: 액트 고아";
    else if (a.is_active !== true) reason = "제외: 비활성";
    else if (a.check_target !== "check") reason = "제외: check_target≠check";
    else {
      const { config, openConfirmed } = await loadWeekOpeningConfig(wid, r.organization_slug as OrganizationSlug);
      const open = isActOpenForWeek({ hub: r.hub, openConfirmed, config, lineGroupId: a.line_group_id, teamId: r.team_id });
      if (!open) reason = "제외: 미가동(미오픈)";
    }
    if (reason !== "유효(포함)") {
      console.log(`  [제외] org=${r.organization_slug} hub=${r.hub} status=${r.status} act="${a?.act_name ?? "?"}" is_active=${a?.is_active} check_target=${a?.check_target} → ${reason}`);
    }
  }
  console.log("(위에 나열된 행만 분모에서 제외됨 — 없으면 전부 유효)");
}
main().catch((e) => { console.error(e); process.exit(1); });
