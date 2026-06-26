/**
 * 검증(read-only): /admin/members 운영기준시즌(operationalSeasonKey) 적용.
 *   npx tsx --env-file=.env.local scripts/verify-members-operational-season.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { operationalSeasonDbKey, getSeasonForDate, seasonDbKey } from "@/lib/seasonCalendar";
import { listMembersRoster } from "@/lib/adminMembersData";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function ids(status: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_season_statuses").select("user_id").eq("season_key", "2026-summer").eq("status", status).order("user_id").range(from, from + 999);
    for (const r of (data ?? []) as any[]) out.add(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  hr(); line("A. operationalSeasonDbKey (전환주차 → 다음 시즌, 하드코딩 없음)"); hr();
  const curSeason = getSeasonForDate(today);
  const curKey = curSeason ? seasonDbKey(curSeason) : null;
  const opKey = operationalSeasonDbKey(today);
  line(`  오늘=${today} · 현재시즌(getSeasonForDate)=${curKey} · operational=${opKey}`);
  ck("operationalSeasonDbKey = 2026-summer (전환주차→다음시즌)", opKey === "2026-summer", `${opKey}`);
  ck("현재시즌은 2026-spring (전환주차 귀속)", curKey === "2026-spring", `${curKey}`);

  hr(); line("B. listMembersRoster(operating) displayGrowthStatus — operational(여름) 기준"); hr();
  const rest = await ids("rest"), stopped = await ids("stopped");
  const { members, partialFailure } = await listMembersRoster({ mode: "operating" });
  line(`  roster members=${members.length} partialFailure=${JSON.stringify(partialFailure)}`);
  const byId = new Map(members.map((m: any) => [m.userId ?? m.user_id, m.displayGrowthStatus]));
  const dist: Record<string, number> = {};
  for (const m of members as any[]) { const d = m.displayGrowthStatus ?? "(null)"; dist[d] = (dist[d] ?? 0) + 1; }
  line(`  displayGrowthStatus 분포: ${JSON.stringify(dist)}`);

  // 50 휴식 코호트 → 전원 seasonal_rest
  const restInRoster = [...rest].filter((id) => byId.has(id));
  const restAsRest = restInRoster.filter((id) => byId.get(id) === "seasonal_rest");
  ck(`여름 휴식 50 코호트 전원 'seasonal_rest' (명부 내 ${restInRoster.length})`, restAsRest.length === restInRoster.length && restInRoster.length === rest.size, `${restAsRest.length}/${restInRoster.length} (코호트 ${rest.size})`);

  // 66 중단 코호트 → 전원 suspended(중단)
  const stoppedInRoster = [...stopped].filter((id) => byId.has(id));
  const stoppedAsSusp = stoppedInRoster.filter((id) => byId.get(id) === "suspended");
  ck(`여름 중단 66 코호트 전원 'suspended'(중단) (명부 내 ${stoppedInRoster.length})`, stoppedAsSusp.length === stoppedInRoster.length && stoppedInRoster.length === stopped.size, `${stoppedAsSusp.length}/${stoppedInRoster.length} (코호트 ${stopped.size})`);

  line(`  (참고) 명부 seasonal_rest=${dist.seasonal_rest ?? 0} · suspended=${dist.suspended ?? 0}`);
  line(`  ※ suspended 총계가 66보다 크면 = growth_status 수동 override(운영 정지) 별도 존재(시즌 무관). 코호트 66은 위에서 확인.`);

  hr(); line("C. season-participations(2026-summer) 와 일치"); hr();
  ck("여름 rest = 50", rest.size === 50, `${rest.size}`);
  ck("여름 stopped = 66", stopped.size === 66, `${stopped.size}`);

  hr();
  line(fail === 0 ? "✅ operational season 명부 검증 PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
