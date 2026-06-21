/** verify-tk-poststate.ts (READ-ONLY) — 제거 후 23개 라인 현재 상태 정밀 확인. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const TARGET = "28a39131-a719-4264-b2a4-96dbda64cbb6";
import { readFileSync } from "node:fs";
async function main() {
  const testIds = await fetchTestUserMarkerIds();
  const diag = JSON.parse(readFileSync("claudedocs/diag-tkwonsoyul-info-lines.json", "utf8")) as { classified: any[] };
  let zero = 0, withReal = 0, tkPresent = 0, sentinelOnZero = 0, testLeak = 0;
  let realTotal = 0;
  for (const l of diag.classified) {
    const { data } = await sb.from("cluster4_line_targets")
      .select("target_mode,target_user_id,target_rule")
      .eq("line_id", l.lineId).eq("week_id", l.weekId);
    const rows = (data ?? []) as any[];
    const users = rows.filter((r) => r.target_mode === "user" && r.target_user_id).map((r) => r.target_user_id);
    const sentinels = rows.filter((r) => r.target_mode === "rule").length;
    const real = users.filter((u) => !testIds.has(u));
    const testU = users.filter((u) => testIds.has(u));
    if (users.includes(TARGET)) tkPresent++;
    if (testU.length > 0) testLeak += testU.length;
    if (users.length === 0) { zero++; if (sentinels >= 1) sentinelOnZero++; }
    else { withReal++; realTotal += users.length; }
    console.log(`${(l.lineCode||"").padEnd(26)} users=${users.length} real=${real.length} test=${testU.length} sentinel=${sentinels} tk=${users.includes(TARGET)}`);
  }
  console.log(`\n요약: 0명 라인=${zero}(그중 sentinel복원=${sentinelOnZero}) · 크루보유 라인=${withReal}(유저합 ${realTotal}) · T권소율 잔존 라인=${tkPresent} · 잔존 테스트유저=${testLeak}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
