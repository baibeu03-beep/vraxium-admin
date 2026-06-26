/**
 * 검증(read-only): getRankPopulationExcludedUserIds 시즌 스코프 정정.
 *   npx tsx --env-file=.env.local scripts/verify-rank-population-season-scope.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getRankPopulationExcludedUserIds } from "@/lib/cluster3ClubRankData";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(70));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function setOf(table: string, col: string, filt: (q: any) => any): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filt(supabaseAdmin.from(table).select(col).order(col, { ascending: true }).range(from, from + 999));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as any[]) out.add(r[col]);
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: wk } = await supabaseAdmin.from("weeks").select("season_key").lte("start_date", today).gte("end_date", today).order("start_date", { ascending: false }).limit(1).maybeSingle();
  const curKey = (wk as any)?.season_key ?? null;
  hr(); line(`현재 시즌(오늘=${today}) season_key=${curKey}`); hr();

  const excluded = await getRankPopulationExcludedUserIds();
  const seasonRest = await setOf("user_season_statuses", "user_id", (q: any) => q.eq("season_key", curKey).eq("status", "rest"));
  const wholePerson = await setOf("user_profiles", "user_id", (q: any) => q.eq("growth_status", "seasonal_rest"));

  line(`  excluded(fixed)=${excluded.size}  현재시즌 season_rest=${seasonRest.size}  whole-person seasonal_rest=${wholePerson.size}`);
  ck("excluded == 현재 시즌 user_season_statuses rest (시즌 스코프)", excluded.size === seasonRest.size && [...excluded].every((id) => seasonRest.has(id)), `${excluded.size} vs ${seasonRest.size}`);

  // 오늘(현재=봄)은 whole-person 과 동일 집합(무회귀) — growth_status='seasonal_rest' 가 정확히 봄 휴식 365
  const sameAsWhole = excluded.size === wholePerson.size && [...excluded].every((id) => wholePerson.has(id));
  ck("오늘은 whole-person 집합과 동일(무회귀)", sameAsWhole, `excluded=${excluded.size} whole=${wholePerson.size}`);

  // 여름-only 휴식자(전현성, growth=active, 봄 휴식 아님)는 오늘 제외되면 안 됨
  const { data: jhs } = await supabaseAdmin.from("user_profiles").select("user_id,growth_status").eq("organization_slug", "oranke").eq("display_name", "전현성").maybeSingle();
  const jhsId = (jhs as any)?.user_id;
  ck("전현성(여름-only 휴식·growth=active) 오늘 제외 안 됨", jhsId && !excluded.has(jhsId), `growth=${(jhs as any)?.growth_status}`);

  // 시즌 스코프 증명: 여름이 현재시즌이면 50명이 제외 대상(현재는 봄이라 미발현)
  const summerRest = await setOf("user_season_statuses", "user_id", (q: any) => q.eq("season_key", "2026-summer").eq("status", "rest"));
  line(`  (참고) 여름 전환 시 제외 대상 = user_season_statuses(2026-summer,rest) = ${summerRest.size}명`);
  ck("여름 휴식 50명은 오늘 제외집합에 없음(봄 현재시즌·소급 없음)", [...summerRest].filter((id) => excluded.has(id)).length === [...summerRest].filter((id) => seasonRest.has(id)).length, "봄·여름 겹침만 일치");

  hr();
  line(fail === 0 ? "✅ rank-population 시즌 스코프 PASS (무회귀·시즌정정)" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
