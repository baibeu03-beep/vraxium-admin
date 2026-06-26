/**
 * 검증(read-only): 2026-summer 모집단 315 (active199/rest50/stopped66).
 *   npx tsx --env-file=.env.local scripts/verify-summer-315.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSeasonParticipations } from "@/lib/adminSeasonParticipationsData";
import { listMembersRoster } from "@/lib/adminMembersData";
import { operationalSeasonDbKey } from "@/lib/seasonCalendar";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  hr(); line("A. user_season_statuses(2026-summer) status 분포"); hr();
  const counts: Record<string, number> = {};
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_season_statuses").select("status").eq("season_key", "2026-summer").order("user_id").range(from, from + 999);
    for (const r of (data ?? []) as any[]) counts[r.status] = (counts[r.status] ?? 0) + 1;
    if ((data ?? []).length < 1000) break;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  line(`  ${JSON.stringify(counts)} total=${total}`);
  ck("active 199", counts.active === 199, `${counts.active}`);
  ck("rest 50", counts.rest === 50, `${counts.rest}`);
  ck("stopped 66", counts.stopped === 66, `${counts.stopped}`);
  ck("total 315", total === 315, `${total}`);

  hr(); line("B. getSeasonParticipations(2026-summer) 전체"); hr();
  const dto = await getSeasonParticipations({ seasonKey: "2026-summer", status: null, organizationSlug: null, search: null });
  line(`  rows=${dto.rows.length} summary=${JSON.stringify(dto.summary)}`);
  ck("direct total 315", dto.rows.length === 315, `${dto.rows.length}`);
  ck("active_count 199", dto.summary.active_count === 199, `${dto.summary.active_count}`);
  ck("rest_count 50", dto.summary.rest_count === 50, `${dto.summary.rest_count}`);
  ck("stopped_count 66", dto.summary.stopped_count === 66, `${dto.summary.stopped_count}`);

  hr(); line("C. listMembersRoster(operating) 모집단 = operationalSeasonKey 참여자"); hr();
  const opKey = operationalSeasonDbKey(new Date().toISOString().slice(0, 10));
  line(`  operationalSeasonKey=${opKey}`);
  const { members, partialFailure } = await listMembersRoster({ mode: "operating" });
  line(`  roster total=${members.length} partialFailure=${JSON.stringify(partialFailure)}`);
  ck("명부 모집단 315 (633 아님)", members.length === 315, `${members.length}`);
  const dist: Record<string, number> = {};
  for (const m of members as any[]) dist[m.displayGrowthStatus ?? "(null)"] = (dist[m.displayGrowthStatus ?? "(null)"] ?? 0) + 1;
  line(`  displayGrowthStatus 분포: ${JSON.stringify(dist)}`);
  ck("명부 seasonal_rest 50", (dist.seasonal_rest ?? 0) === 50, `${dist.seasonal_rest}`);
  ck("명부 suspended(중단) >= 66", (dist.suspended ?? 0) >= 66, `${dist.suspended}`);

  hr();
  line(fail === 0 ? "✅ 315 모집단 direct 검증 PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
