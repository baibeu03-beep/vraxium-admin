// 검증(direct): roster slim 일정신뢰도 + Po.A/B/C 정합 + 소요.
//   getRosterPointsScheduleFast(slim 우선) == pure live(getScheduleReliabilityRateBatch + sumPointsForUsers)
//   - 마이그레이션/백필 전: 전체 live 폴백 → 자명히 동일(새 함수 무결성 확인).
//   - 마이그레이션+백필 후: slim 경로가 live 와 동일해야 함(직전 recompute 기준 staleness 한도 내).
//   npx tsx --env-file=.env.local scripts/verify-roster-slim-points-schedule.ts [limit]
import { writeFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getRosterPointsScheduleFast,
  sumPointsForUsers,
} from "@/lib/adminMembersData";
import { getScheduleReliabilityRateBatch } from "@/lib/cluster1ResumeData";

const OUT = "C:/Users/vanua/AppData/Local/Temp/roster-slim-verify.txt";
const log = (m: string) => {
  writeFileSync(OUT, m + "\n", { flag: "a" });
  process.stderr.write(m + "\n");
};

async function main() {
  writeFileSync(OUT, `roster slim verify ${new Date().toISOString()}\n`);
  const limit = Number(process.argv[2] ?? 300);

  // 표본 user_id — 무거운 crew DTO 경로 대신 user_profiles 직독(경량).
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .not("activity_started_at", "is", null)
    .order("user_id", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  const ids = (data ?? []).map((r) => r.user_id as string);
  log(`표본 user=${ids.length}`);

  const tFast = Date.now();
  const fast = await getRosterPointsScheduleFast(ids);
  log(`getRosterPointsScheduleFast: ${Date.now() - tFast}ms`);

  const tLive = Date.now();
  const [sched, pts] = await Promise.all([
    getScheduleReliabilityRateBatch(ids),
    sumPointsForUsers(ids),
  ]);
  log(`pure live(schedule+points): ${Date.now() - tLive}ms`);

  let mismatch = 0;
  let checked = 0;
  for (const uid of ids) {
    const f = fast.get(uid);
    if (!f) {
      log(`  ✗ ${uid}: fast 결과 없음`);
      mismatch++;
      continue;
    }
    checked++;
    const liveSched = sched.get(uid) ?? null;
    const lp = pts.get(uid);
    const livePoA = lp?.checkPoints ?? 0;
    const livePoB = lp?.advantagePoints ?? 0;
    const livePoC = lp?.penaltyPoints ?? 0;
    if (
      f.scheduleReliability !== liveSched ||
      f.poA !== livePoA ||
      f.poB !== livePoB ||
      f.poC !== livePoC
    ) {
      mismatch++;
      if (mismatch <= 12) {
        log(
          `  ✗ ${uid}: fast(s=${f.scheduleReliability},A=${f.poA},B=${f.poB},C=${f.poC}) vs live(s=${liveSched},A=${livePoA},B=${livePoB},C=${livePoC})`,
        );
      }
    }
  }
  log(`비교 ${checked}명 · 불일치 ${mismatch}명 → ${mismatch === 0 ? "동일 ✓" : "검토(캐시 staleness 또는 버그)"}`);
  log("DONE");
}

main().then(
  () => process.exit(0),
  (e) => {
    log("ERROR: " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  },
);
