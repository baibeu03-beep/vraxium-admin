// 진단: 어드민 주요 GET 로더의 직접 호출 소요 + 쿼리 수 + row 수 + snapshot 건강도.
//   npx tsx --env-file=.env.local scripts/diag-admin-api-perf-direct.ts
// 각 로더를 runWithQueryMeter 로 감싸 실제 Supabase .from() 호출 횟수를 센다(N+1 적발).
import { appendFileSync, writeFileSync } from "node:fs";
import { runWithQueryMeter } from "@/lib/supabaseQueryMeter";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

import { listMembersRoster } from "@/lib/adminMembersData";
import { loadMembersInfoStats } from "@/lib/adminMembersInfoStats";
import { listAdminCrewDtos } from "@/lib/adminCrewData";
import { listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { getWeekRecognitions } from "@/lib/adminWeekRecognitionsData";
import { getSeasonParticipations } from "@/lib/adminSeasonParticipationsData";
import { listAppUsers } from "@/lib/adminAppUsersData";

const OUT = "C:/Users/vanua/AppData/Local/Temp/claude/admin-perf-direct.txt";
const log = (m: string) => {
  appendFileSync(OUT, m + "\n");
  process.stderr.write(m + "\n");
};

type Row = { name: string; ms: number; queries: number; rows: number | string; timeouts: number };
const results: Row[] = [];

async function measure(name: string, fn: () => Promise<unknown>, rowCount: (r: unknown) => number | string) {
  const s = Date.now();
  try {
    const out = await runWithQueryMeter(name, async (meter) => {
      const r = await fn();
      return { r, meter };
    });
    const ms = Date.now() - s;
    const rows = rowCount(out.r);
    results.push({ name, ms, queries: out.meter.count, rows, timeouts: out.meter.timeouts });
    log(`${name.padEnd(42)} ${String(ms).padStart(6)}ms  q=${String(out.meter.count).padStart(3)}  rows=${rows}  timeouts=${out.meter.timeouts}`);
  } catch (e) {
    const ms = Date.now() - s;
    results.push({ name, ms, queries: -1, rows: "ERR", timeouts: 0 });
    log(`${name.padEnd(42)} ${String(ms).padStart(6)}ms  ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const len = (r: unknown) => (Array.isArray(r) ? r.length : (Array.isArray((r as { data?: unknown[] })?.data) ? (r as { data: unknown[] }).data.length : "?"));

async function snapshotHealth() {
  log("\n=== snapshot 건강도 (cluster4_weekly_card_snapshots) ===");
  const total = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id", { count: "exact", head: true });
  const stale = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id", { count: "exact", head: true }).eq("is_stale", true);
  const verMismatch = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id", { count: "exact", head: true }).neq("dto_version", WEEKLY_CARDS_DTO_VERSION);
  log(`current DTO version: ${WEEKLY_CARDS_DTO_VERSION}`);
  log(`total snapshots:     ${total.count}`);
  log(`is_stale=true:        ${stale.count}`);
  log(`dto_version mismatch: ${verMismatch.count}  (read 시 stale 처리 → cron/lazy 재계산 필요)`);

  // roster slim 캐시 건강도
  const slimTotal = await supabaseAdmin.from("cluster4_roster_card_stats").select("user_id", { count: "exact", head: true });
  const slimVer = await supabaseAdmin.from("cluster4_roster_card_stats").select("user_id", { count: "exact", head: true }).neq("dto_version", WEEKLY_CARDS_DTO_VERSION);
  log(`\nroster slim rows:     ${slimTotal.count}`);
  log(`roster slim ver mismatch: ${slimVer.count}  (read 시 fat 폴백)`);
}

async function main() {
  writeFileSync(OUT, `admin API perf (direct) ${new Date().toISOString()}\n\n`);

  await snapshotHealth();

  log("\n=== 로더 직접 호출 (operating mode, 전체 org) ===");
  await measure("members/roster (listMembersRoster ALL)", () => listMembersRoster({ organization: null, mode: "operating" }), len);
  await measure("members/info-stats (loadMembersInfoStats)", () => loadMembersInfoStats({ organization: "all", mode: "operating" }), (r) => JSON.stringify(r).length + "B");
  await measure("crews (listAdminCrewDtos ALL)", () => listAdminCrewDtos(undefined, "operating"), len);
  await measure("cluster4/crews (listCrewsForTargetSelection)", () => listCrewsForTargetSelection({ mode: "operating" }), len);
  await measure("season-weeks (loadSeasonWeeks)", () => loadSeasonWeeks(), (r) => JSON.stringify(r).length + "B");
  await measure("week-recognitions (getWeekRecognitions)", () => getWeekRecognitions({}), (r) => JSON.stringify(r).length + "B");
  await measure("season-participations (getSeasonParticipations)", () => getSeasonParticipations({}), (r) => JSON.stringify(r).length + "B");
  await measure("app-users (listAppUsers)", () => listAppUsers({ mode: "operating" }), (r) => len((r as { data?: unknown }).data ?? r));

  log("\n=== TOP (felt slowest) ===");
  for (const r of [...results].sort((a, b) => b.ms - a.ms)) {
    log(`${String(r.ms).padStart(6)}ms  q=${String(r.queries).padStart(3)}  ${r.name}`);
  }
  log("DONE");
}

main().then(
  () => process.exit(0),
  (e) => {
    log("FATAL: " + (e instanceof Error ? e.stack : String(e)));
    process.exit(1);
  },
);
