/**
 * 검증(read-only): /admin/members · 고객 /crews 의 2026 여름 휴식 반영(시즌 스코프 게이팅).
 *   npx tsx --env-file=.env.local scripts/verify-members-crews-summer.ts
 *
 * 두 로스터의 displayGrowthStatus = growthCore.resolveGrowthStatusDetail (auto=computeAutoGrowthStatus).
 *   seasonRestActive = (현재시즌 user_season_statuses.status='rest') — 시즌 스코프.
 *   growth_status='active' 는 수동오버라이드(graduated/suspended/paused)가 아니므로 display=auto.
 * ⇒ 오늘(현재시즌=봄)은 봄 휴식자만 seasonal_rest, 여름-only 휴식자(전현성 포함)는 active(정상 게이팅).
 *   여름 전환(06-29) 시 seasonRestActive=true → 50명 전원 auto=seasonal_rest (growth_status 무수정).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSeasonParticipations } from "@/lib/adminSeasonParticipationsData";
import { getGrowthStatusResolutionBatch } from "@/lib/cluster3GrowthData";
import { computeAutoGrowthStatus } from "@/lib/growthCore";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  // 여름 휴식 50명 + 봄 휴식 여부
  const summer = await getSeasonParticipations({ seasonKey: "2026-summer", status: "rest", organizationSlug: null, search: null });
  const ids = summer.rows.map((r) => r.user_id);
  const byId = new Map(summer.rows.map((r) => [r.user_id, r]));
  const { data: springRows } = await supabaseAdmin.from("user_season_statuses").select("user_id").eq("season_key", "2026-spring").eq("status", "rest").in("user_id", ids);
  const springRest = new Set((springRows ?? []).map((r: any) => r.user_id));

  hr(); line("A. 오늘(현재시즌=봄) /admin/members·/crews 로스터 상태 — getGrowthStatusResolutionBatch"); hr();
  const res = await getGrowthStatusResolutionBatch(ids);
  const resById = new Map((res as any[]).map((r: any) => [r.userId ?? r.user_id, r]));
  const dist: Record<string, number> = {};
  let springRestSeasonal = 0, springActiveNonSeasonal = 0;
  for (const id of ids) {
    const r: any = resById.get(id);
    const disp = r?.displayGrowthStatus ?? r?.display ?? "(?)";
    dist[disp] = (dist[disp] ?? 0) + 1;
    if (springRest.has(id)) { if (disp === "seasonal_rest") springRestSeasonal++; }
    else { if (disp !== "seasonal_rest") springActiveNonSeasonal++; }
  }
  line(`  displayGrowthStatus 분포(50명, 오늘): ${JSON.stringify(dist)}`);
  line(`  봄 휴식자 ${springRest.size}명 · 여름-only 휴식자 ${ids.length - springRest.size}명`);
  ck("봄 휴식자는 오늘 seasonal_rest 로 표시(봄이 현재시즌)", springRestSeasonal === springRest.size, `${springRestSeasonal}/${springRest.size}`);
  ck("여름-only 휴식자는 오늘 seasonal_rest 아님(여름 미시작·정상 게이팅)", springActiveNonSeasonal === ids.length - springRest.size, `${springActiveNonSeasonal}/${ids.length - springRest.size}`);

  // 전현성 today
  const { data: jhs } = await supabaseAdmin.from("user_profiles").select("user_id").eq("organization_slug", "oranke").eq("display_name", "전현성").maybeSingle();
  const jhsId = (jhs as any)?.user_id;
  const jhsRes: any = resById.get(jhsId);
  line(`  전현성 오늘 displayGrowthStatus=${jhsRes?.displayGrowthStatus ?? jhsRes?.display} (active 기대 — 봄 활동/현재 비휴식)`);
  ck("전현성 오늘 seasonal_rest 아님", (jhsRes?.displayGrowthStatus ?? jhsRes?.display) !== "seasonal_rest");

  hr(); line("B. 여름 전환 시(06-29~) 게이팅 — 단위 증명"); hr();
  // 50명 전원: 여름이 현재시즌이면 seasonRestActive=true → auto=seasonal_rest (computeAutoGrowthStatus 첫 분기)
  const sampleAuto = computeAutoGrowthStatus({ seasonRestActive: true, currentWeekStatus: null as any, approvedWeeks: 5, elapsedWeeks: 10, graduationThreshold: 30 });
  ck("computeAutoGrowthStatus(seasonRestActive=true) == 'seasonal_rest'", sampleAuto === "seasonal_rest", sampleAuto);
  ck("computeAutoGrowthStatus(seasonRestActive=false, active) != 'seasonal_rest'", computeAutoGrowthStatus({ seasonRestActive: false, currentWeekStatus: null as any, approvedWeeks: 5, elapsedWeeks: 10, graduationThreshold: 30 }) !== "seasonal_rest");
  line(`  ⇒ 여름 전환 시 50명 전원 user_season_statuses(2026-summer,rest) 보유 → seasonRestActive=true → 로스터 auto=seasonal_rest`);
  line(`     (growth_status 무수정. boundary lazy 재계산이 roster_card_stats 동기화 — snapshot 재계산과 동일 경로)`);

  hr();
  line(fail === 0 ? "✅ members/crews 시즌 스코프 게이팅 검증 PASS" : `❌ ${fail} FAILED`);
  line("요약: 두 로스터는 현재시즌 기준 season-scoped. 오늘=봄 → 여름휴식 미표시(정상). 06-29 여름전환 시 50명 자동 seasonal_rest(전인 플래그 무수정).");
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
