// info-stats DTO 캡처(병렬/RPC 전·후 동일성 비교 + 타이밍). org×mode 조합별로 안정 직렬화.
//   npx tsx --env-file=.env.local scripts/diag-info-stats-eq.ts <label>
//   <label>=before|after — 출력: C:/.../claude/info-stats-<label>-<combo>.json
import { writeFileSync } from "node:fs";
import { runWithQueryMeter } from "@/lib/supabaseQueryMeter";
import { loadMembersInfoStats } from "@/lib/adminMembersInfoStats";
import { ORGANIZATIONS } from "@/lib/organizations";

const label = process.argv[2] || "run";
const DIR = "C:/Users/vanua/AppData/Local/Temp/claude";
const log = (m: string) => process.stderr.write(m + "\n");

const COMBOS: Array<{ name: string; organization: "all" | string; mode: "operating" | "test" }> = [
  { name: "all-operating", organization: "all", mode: "operating" },
  { name: "all-test", organization: "all", mode: "test" },
  ...ORGANIZATIONS.map((o) => ({ name: `${o}-operating`, organization: o, mode: "operating" as const })),
];

async function main() {
  for (const c of COMBOS) {
    const s = Date.now();
    const o = await runWithQueryMeter(c.name, async (mt) => ({
      r: await loadMembersInfoStats({ organization: c.organization as never, mode: c.mode }),
      q: mt.count,
    }));
    const ms = Date.now() - s;
    // generatedAt 제외(타임스탬프) — 나머지 안정 직렬화.
    const stable = JSON.stringify({ ...o.r, generatedAt: "<omitted>" });
    writeFileSync(`${DIR}/info-stats-${label}-${c.name}.json`, stable);
    log(`${c.name.padEnd(20)} ${String(ms).padStart(6)}ms q=${String(o.q).padStart(3)} weeks=${o.r.weeks.length} cumClubbing=${o.r.cumulative.cumulativeClubbing} bytes=${stable.length}`);
  }
  log("DONE " + label);
}
main().then(() => process.exit(0), (e) => { log("FATAL " + (e?.stack || e)); process.exit(1); });
