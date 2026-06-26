/**
 * 검증(read-only): 2026-summer stopped 66 — direct + 멤버/크루 시즌스코프 게이팅.
 *   npx tsx --env-file=.env.local scripts/verify-summer-stopped-direct.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSeasonParticipations } from "@/lib/adminSeasonParticipationsData";
import { getGrowthStatusResolutionBatch } from "@/lib/cluster3GrowthData";
import { computeAutoGrowthStatus } from "@/lib/growthCore";
import { getSeasonForDate, seasonDbKey } from "@/lib/seasonCalendar";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(74));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function idsFor(status: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_season_statuses").select("user_id").eq("season_key", "2026-summer").eq("status", status).order("user_id").range(from, from + 999);
    for (const r of (data ?? []) as any[]) out.add(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  hr(); line("A. direct getSeasonParticipations(2026-summer, stopped)"); hr();
  const dto = await getSeasonParticipations({ seasonKey: "2026-summer", status: "stopped", organizationSlug: null, search: null });
  const perOrg: Record<string, number> = {};
  for (const r of dto.rows) perOrg[r.organization_slug ?? "?"] = (perOrg[r.organization_slug ?? "?"] ?? 0) + 1;
  line(`  rows=${dto.rows.length} stopped_count=${dto.summary.stopped_count} perOrg=${JSON.stringify(perOrg)}`);
  ck("66행", dto.rows.length === 66, `${dto.rows.length}`);
  ck("summary.stopped_count=66", dto.summary.stopped_count === 66, `${dto.summary.stopped_count}`);
  ck("encre37/oranke21/phalanx8", perOrg.encre === 37 && perOrg.oranke === 21 && perOrg.phalanx === 8, JSON.stringify(perOrg));
  ck("전부 status=stopped & 2026-summer", dto.rows.every((r) => r.status === "stopped" && r.season_key === "2026-summer"));
  ck("season_phase=stopped", dto.rows.every((r) => r.season_phase === "stopped"));

  hr(); line("B. 여름 코호트 분리 (중단66 ∩ 휴식50 = 0) + 과거 무소급"); hr();
  const stopped = await idsFor("stopped"), rest = await idsFor("rest");
  const overlap = [...stopped].filter((id) => rest.has(id));
  ck("여름 stopped 66", stopped.size === 66, `${stopped.size}`);
  ck("여름 rest 50", rest.size === 50, `${rest.size}`);
  ck("중단∩휴식 = 0 (배타)", overlap.length === 0, `${overlap.length}`);
  // 66명이 과거 시즌(봄 등)에 stopped 없음(소급 0)
  const { data: pastStopped } = await supabaseAdmin.from("user_season_statuses").select("user_id,season_key").eq("status", "stopped").neq("season_key", "2026-summer").in("user_id", [...stopped].slice(0, 66));
  ck("66명 과거 시즌 stopped 행 없음(소급 0)", (pastStopped ?? []).length === 0, `${(pastStopped ?? []).length}`);
  // growth_status 무수정 — 66명 중 suspended 로 바뀐 사람 0
  const { data: profs } = await supabaseAdmin.from("user_profiles").select("user_id,growth_status").in("user_id", [...stopped]);
  const flipped = (profs ?? []).filter((p: any) => p.growth_status === "suspended");
  ck("growth_status='suspended' 로 바뀐 66명 = 0 (whole-person 무수정)", flipped.length === 0, `${flipped.length}`);

  hr(); line("C. /admin/members·/crows 게이팅 — 오늘(현재시즌) vs 여름전환"); hr();
  const today = new Date().toISOString().slice(0, 10);
  const curKey = (() => { const s = getSeasonForDate(today); return s ? seasonDbKey(s) : null; })();
  line(`  오늘=${today} 현재시즌=${curKey}`);
  const res = await getGrowthStatusResolutionBatch([...stopped]);
  const dist: Record<string, number> = {};
  for (const r of res as any[]) { const d = r.displayGrowthStatus ?? r.display ?? "?"; dist[d] = (dist[d] ?? 0) + 1; }
  line(`  66명 오늘 displayGrowthStatus 분포: ${JSON.stringify(dist)}`);
  ck("오늘(봄) 66명 누구도 'suspended'(중단) 미표시 — 정상 게이팅", (dist.suspended ?? 0) === 0, `suspended=${dist.suspended ?? 0}`);
  // 단위: 여름 전환 시 seasonStoppedActive=true → 'suspended'(중단)
  ck("computeAutoGrowthStatus(seasonStoppedActive=true) == 'suspended'(중단)", computeAutoGrowthStatus({ seasonRestActive: false, seasonStoppedActive: true, currentWeekStatus: null as any, approvedWeeks: 5, elapsedWeeks: 10, graduationThreshold: 30 }) === "suspended");
  ck("중단>휴식 우선(stopped+rest 동시 입력 시 suspended)", computeAutoGrowthStatus({ seasonRestActive: true, seasonStoppedActive: true, currentWeekStatus: null as any, approvedWeeks: 5, elapsedWeeks: 10, graduationThreshold: 30 }) === "suspended");
  line(`  ⇒ 여름 전환(06-29) 시 66명 auto='suspended'("성장 중단"), 휴식50='seasonal_rest', 나머지='active'(성장 중)`);

  hr();
  line(fail === 0 ? "✅ stopped direct/게이팅 검증 PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
