/**
 * 검증(read-only): 2026-summer 최종 318 (active201/rest51/stopped66) + 4인 상태.
 *   npx tsx --env-file=.env.local scripts/verify-summer-318.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSeasonParticipations } from "@/lib/adminSeasonParticipationsData";
import { listMembersRoster } from "@/lib/adminMembersData";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function summerStatus(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("user_season_statuses").select("status").eq("user_id", userId).eq("season_key", "2026-summer").maybeSingle();
  return (data as any)?.status ?? null;
}
async function uidOf(src: string, legacy: number): Promise<string | null> {
  const { data } = await supabaseAdmin.from("users").select("id").eq("source_system", src).eq("legacy_user_id", legacy).maybeSingle();
  return (data as any)?.id ?? null;
}

async function main() {
  hr(); line("A. user_season_statuses(2026-summer) 분포"); hr();
  const counts: Record<string, number> = {};
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_season_statuses").select("status").eq("season_key", "2026-summer").order("user_id").range(from, from + 999);
    for (const r of (data ?? []) as any[]) counts[r.status] = (counts[r.status] ?? 0) + 1;
    if ((data ?? []).length < 1000) break;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  line(`  ${JSON.stringify(counts)} total=${total}`);
  ck("active 201", counts.active === 201, `${counts.active}`);
  ck("rest 51", counts.rest === 51, `${counts.rest}`);
  ck("stopped 66", counts.stopped === 66, `${counts.stopped}`);
  ck("total 318", total === 318, `${total}`);

  hr(); line("B. 4인 상태 (src/legacy → user_id → 2026-summer status)"); hr();
  const kjwGangwon = await uidOf("hrdb", 1505); // 강원대 김준우
  const kjwBaekseok = await uidOf("hrdb", 852);  // 백석대 김준우
  const idg = await uidOf("hrdb", 1607);          // 이다경
  const ryu = await uidOf("oranke", 1200);        // 류건영
  ck("강원대 김준우(hrdb1505) = active", (await summerStatus(kjwGangwon!)) === "active");
  ck("백석대 김준우(hrdb852) = rest", (await summerStatus(kjwBaekseok!)) === "rest");
  ck("이다경(hrdb1607) = rest", (await summerStatus(idg!)) === "rest");
  ck("류건영(oranke1200) = active", (await summerStatus(ryu!)) === "active");
  // 류건영 growth_status = active (전역 graduated 아님)
  const { data: ryuP } = await supabaseAdmin.from("user_profiles").select("growth_status,school_name").eq("user_id", ryu!).maybeSingle();
  ck("류건영 growth_status=active (전역 graduated 아님)", (ryuP as any)?.growth_status === "active", `${(ryuP as any)?.growth_status} 학교=${(ryuP as any)?.school_name}`);
  // 백석대/세종대 학교 확인
  const { data: bsP } = await supabaseAdmin.from("user_educations").select("school_name").eq("user_id", kjwBaekseok!).maybeSingle();
  const { data: idgP } = await supabaseAdmin.from("user_educations").select("school_name").eq("user_id", idg!).maybeSingle();
  ck("백석대 김준우 학교=백석대", (bsP as any)?.school_name === "백석대", `${(bsP as any)?.school_name}`);
  ck("이다경 학교=세종대", (idgP as any)?.school_name === "세종대", `${(idgP as any)?.school_name}`);

  hr(); line("C. getSeasonParticipations(2026-summer) 전체"); hr();
  const dto = await getSeasonParticipations({ seasonKey: "2026-summer", status: null, organizationSlug: null, search: null });
  line(`  total=${dto.rows.length} summary=${JSON.stringify(dto.summary)}`);
  ck("direct total 318", dto.rows.length === 318);
  ck("active 201", dto.summary.active_count === 201);
  ck("rest 51", dto.summary.rest_count === 51);
  ck("stopped 66", dto.summary.stopped_count === 66);

  hr(); line("D. listMembersRoster(operating) 모집단"); hr();
  const { members } = await listMembersRoster({ mode: "operating" });
  ck("명부 모집단 318", members.length === 318, `${members.length}`);
  const dist: Record<string, number> = {};
  for (const m of members as any[]) dist[m.displayGrowthStatus ?? "?"] = (dist[m.displayGrowthStatus ?? "?"] ?? 0) + 1;
  line(`  displayGrowthStatus: ${JSON.stringify(dist)}`);
  ck("명부 seasonal_rest 51", (dist.seasonal_rest ?? 0) === 51, `${dist.seasonal_rest}`);
  ck("명부 suspended(중단) 66", (dist.suspended ?? 0) === 66, `${dist.suspended}`);

  hr();
  line(fail === 0 ? "✅ 318 direct 검증 PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
