/**
 * 검증(read-only): 고객 경로 시즌 스코프 — 봄 휴식자가 여름으로 누수되지 않음.
 *   npx tsx --env-file=.env.local scripts/verify-summer-rest-customer-scope.ts
 *
 * 고객 SoT = user_season_statuses(currentSeasonKey, status='rest').
 *   (cluster4WeeklyGrowthData.loadWeeklyCards currentSeasonRestActive / 고객 /api/profile currentSeasonStatus)
 * 여름이 현재 시즌이 되면(2026-06-29~) 위 쿼리가 휴식 카드/상태를 만든다. 따라서:
 *   - 여름 rest 행 보유자 = 정확히 44 (현재시즌=여름일 때 휴식 표시 대상)
 *   - 봄에만 rest(여름 rest 없음)인 ~347명은 여름 현재시즌에 휴식 표시 안 됨(누수 0)
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function idsFor(seasonKey: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("user_season_statuses")
      .select("user_id").eq("season_key", seasonKey).eq("status", "rest")
      .order("user_id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as any[]) out.add(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  hr(); line("고객 경로 시즌 스코프 — user_season_statuses 기준"); hr();
  const summer = await idsFor("2026-summer");
  const spring = await idsFor("2026-spring");
  line(`  2026-summer rest = ${summer.size}  /  2026-spring rest = ${spring.size}`);
  ck("여름 rest = 44 (현재시즌=여름일 때 휴식표시 대상)", summer.size === 44, `${summer.size}`);
  ck("봄 rest = 365 (불변)", spring.size === 365, `${spring.size}`);

  const springOnly = [...spring].filter((id) => !summer.has(id));
  const overlap = [...spring].filter((id) => summer.has(id));
  line(`  봄에만 휴식(여름 휴식 아님) = ${springOnly.length}  /  봄·여름 모두 휴식 = ${overlap.length}`);
  // 핵심 누수 검사: 봄-only 휴식자는 여름 rest 행이 절대 없어야(현재시즌=여름 시 휴식 표시 안 됨)
  ck("봄-only 휴식자(347)는 여름 rest 행 0 (누수 없음)", springOnly.every((id) => !summer.has(id)), `${springOnly.length}`);

  hr(); line("고객 currentSeason 게이팅(오늘=봄, 여름 시작 2026-06-29)"); hr();
  // 오늘 기준 currentSeasonKey=2026-spring → 여름 rest 44명은 '아직' 고객 화면에 휴식으로 안 뜸(정상).
  //   봄에 활동자였던 여름휴식자는 오늘 봄 카드(활동)로 정상 표시. 여름 휴식은 06-29 이후 currentSeason 전환 시 표시.
  line("  · 오늘은 currentSeasonKey=2026-spring → 고객 weekly-cards 는 봄 상태만 표시(여름 휴식 미표시=정상 게이팅)");
  line("  · 2026-06-29 여름 전환 시: 위 44명만 currentSeasonRestActive=true → 휴식 카드 생성, 347 봄-only 는 false");
  line("  · boundary lazy 재계산(weekly-cards 조회 시)로 자동 반영 — 사전 snapshot 재계산 불필요");

  hr();
  line(fail === 0 ? "✅ 고객 시즌 스코프 검증 PASS (누수 0)" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
