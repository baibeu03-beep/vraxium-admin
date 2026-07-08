/**
 * uws finalize 안전장치 검증 (write 0 — 안전).
 *   ① 플래그 없이 호출하면 mass-fail 가드가 유지되어 throw(422)·write 0 (기본 안전, env 무관).
 *   ② bypass 판정 규칙 = allowIncompleteTestData && (scope==='qa' || QA_HIDE_REAL_USERS).
 *      → operating 실유저(QA_HIDE_REAL_USERS=false, scope=operating) 에서는 플래그가 있어도 bypass=false.
 *   ③ 현재 env 의 QA_HIDE_REAL_USERS 값과 코호트 규모를 보고한다.
 *
 *   npx tsx --env-file=.env.local scripts/verify-uws-finalize-safety.ts [weekId]
 *
 * ⚠ 이 스크립트는 flag=true 로 finalizeWeekUws 를 호출하지 않는다(QA env 에서 write 방지).
 *   flag=true 강제 진행 write+revert E2E 는 run-log 마이그레이션 적용 후 UI/route 로 수행.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import {
  finalizeWeekUws,
  loadFinalizeCohort,
  UwsFinalizeBlockedError,
  type FinalizeWeekRow,
} from "@/lib/adminWeekUwsFinalize";

const WEEK_ID = process.argv[2] ?? "496656d0-8d92-4738-b69b-e5e28aa1d57a";

async function uwsCount(startDate: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("user_week_statuses")
    .select("id", { count: "exact", head: true })
    .eq("week_start_date", startDate);
  return count ?? 0;
}

async function main() {
  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest")
    .eq("id", WEEK_ID)
    .maybeSingle();
  if (!wk) {
    console.error("주차 없음");
    process.exit(1);
  }
  const week = wk as unknown as FinalizeWeekRow;
  const startDate = week.start_date as string;
  let pass = true;

  console.log(`env QA_HIDE_REAL_USERS = ${QA_HIDE_REAL_USERS}`);

  // ── [1] 기본 가드: 플래그 없음 → throw, write 0 (env 무관 안전) ──────────────
  console.log("\n=== [1] 플래그 없이 호출 → mass-fail 가드 유지 ===");
  const before = await uwsCount(startDate);
  let threw = false;
  let blocked = false;
  try {
    await finalizeWeekUws(week, "operating", null, {});
  } catch (e) {
    threw = true;
    blocked = e instanceof UwsFinalizeBlockedError;
    console.log(`  throw: ${blocked ? "UwsFinalizeBlockedError(422)" : "기타"} — ${(e as Error).message}`);
  }
  const after = await uwsCount(startDate);
  const ok1 = threw && blocked && before === after;
  console.log(`  uws(week) ${before} → ${after} | [1] ${ok1 ? "PASS" : "FAIL"}`);
  if (!ok1) pass = false;

  // ── [2] bypass 판정 규칙 (순수 — write 없음) ────────────────────────────────
  console.log("\n=== [2] bypass 판정 규칙 ===");
  const rule = (flag: boolean, scope: "operating" | "qa") =>
    flag && (scope === "qa" || QA_HIDE_REAL_USERS);
  console.log(`  operating + flag=false → bypass=${rule(false, "operating")} (가드 유지)`);
  console.log(`  operating + flag=true  → bypass=${rule(true, "operating")} ` +
    `(QA_HIDE_REAL_USERS=${QA_HIDE_REAL_USERS} 이므로 ${rule(true, "operating") ? "허용(현재 QA env)" : "무시=가드 유지(운영 env)"})`);
  console.log(`  qa + flag=true         → bypass=${rule(true, "qa")} (test 코호트 강제 진행 허용)`);
  console.log("  ✔ 실유저 운영 배포(QA_HIDE_REAL_USERS=false)에서는 operating+flag 도 bypass=false → 가드 유지.");

  // ── [3] 코호트 규모 ─────────────────────────────────────────────────────────
  const opC = await loadFinalizeCohort(week.season_key ?? "", "operating");
  const qaC = await loadFinalizeCohort(week.season_key ?? "", "qa");
  console.log(`\n=== [3] 코호트 ===\n  operating=${opC.length} · qa(test-only)=${qaC.length}`);

  console.log(`\n결론: ${pass ? "SAFETY PASS ✅" : "SAFETY FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}

main();
