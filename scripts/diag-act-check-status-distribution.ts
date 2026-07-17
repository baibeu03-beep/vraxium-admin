/**
 * (READ-ONLY 진단) process_check_statuses 분포 — "신청(pending|completed)" vs "완료(completed)" 격차,
 * 그리고 오픈 설정(open_confirmed)이 있는 주차와의 교집합.
 *
 *   npx tsx --env-file=.env.local scripts/diag-act-check-status-distribution.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function line(s = "") {
  console.log(s);
}

async function main() {
  // 1) 상태행 전체 분포
  const { data, error } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,organization_slug,hub,week_id,act_id,status,team_id,part_name");
  if (error) {
    line(`✗ ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{
    organization_slug: string | null;
    hub: string | null;
    week_id: string | null;
    act_id: string | null;
    status: string | null;
  }>;
  line(`═══ process_check_statuses 총 행: ${rows.length} ═══`);

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status ?? "-", (byStatus.get(r.status ?? "-") ?? 0) + 1);
  line("  status 분포:");
  for (const [k, n] of [...byStatus.entries()].sort()) line(`   ${String(n).padStart(4)}×  ${k}`);

  const byOrgHub = new Map<string, { applied: number; completed: number }>();
  for (const r of rows) {
    const k = `${r.organization_slug ?? "-"} | ${r.hub ?? "-"}`;
    const e = byOrgHub.get(k) ?? { applied: 0, completed: 0 };
    if (r.status === "pending" || r.status === "completed") e.applied++;
    if (r.status === "completed") e.completed++;
    byOrgHub.set(k, e);
  }
  line("  org|hub 별 신청(pending|completed) vs 완료(completed):");
  for (const [k, e] of [...byOrgHub.entries()].sort()) {
    line(`   ${k.padEnd(24)} 신청=${String(e.applied).padStart(3)}  완료=${String(e.completed).padStart(3)}  격차=${e.applied - e.completed}`);
  }

  // 2) 상태행이 있는 주차 ↔ 오픈 설정 주차 교집합
  const weekIds = [...new Set(rows.map((r) => r.week_id).filter((x): x is string => !!x))];
  line();
  line(`═══ 상태행 보유 주차: ${weekIds.length}개 ═══`);
  const { data: cfg } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("week_id,organization_slug,open_confirmed");
  const cfgRows = (cfg ?? []) as Array<{ week_id: string; organization_slug: string | null; open_confirmed: boolean | null }>;
  const cfgWeekIds = new Set(cfgRows.filter((c) => c.open_confirmed === true).map((c) => c.week_id));
  line(`  open_confirmed=true 설정 보유 주차: ${cfgWeekIds.size}개`);
  const overlap = weekIds.filter((w) => cfgWeekIds.has(w));
  line(`  ▶ 교집합(상태행 ∧ 오픈설정): ${overlap.length}개`);

  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,week_number,iso_year")
    .in("id", [...new Set([...weekIds, ...cfgWeekIds])]);
  const wkById = new Map(
    ((wk ?? []) as Array<{ id: string; start_date: string; week_number: number | null }>).map((w) => [w.id, w]),
  );
  line();
  line("  주차별 상태행(신청/완료) + 오픈설정:");
  for (const w of weekIds) {
    const info = wkById.get(w);
    const rs = rows.filter((r) => r.week_id === w);
    const applied = rs.filter((r) => r.status === "pending" || r.status === "completed").length;
    const completed = rs.filter((r) => r.status === "completed").length;
    const orgs = [...new Set(rs.map((r) => r.organization_slug))].join(",");
    line(
      `   ${(info?.start_date ?? w.slice(0, 8)).padEnd(12)} W${String(info?.week_number ?? "?").padStart(2)}  행=${String(rs.length).padStart(3)} 신청=${String(applied).padStart(3)} 완료=${String(completed).padStart(3)}  오픈설정=${cfgWeekIds.has(w) ? "Y" : "N"}  org=${orgs}`,
    );
  }

  line();
  line("  오픈설정 보유 주차(상태행 유무 무관):");
  for (const c of cfgRows) {
    const info = wkById.get(c.week_id);
    line(
      `   ${(info?.start_date ?? c.week_id.slice(0, 8)).padEnd(12)} W${String(info?.week_number ?? "?").padStart(2)}  org=${c.organization_slug} open_confirmed=${c.open_confirmed}`,
    );
  }
  line();
  line("완료(read-only).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
