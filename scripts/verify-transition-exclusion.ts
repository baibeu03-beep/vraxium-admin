/**
 * READ-ONLY 검증: 전환 주차가 read-time 집계에서 제외되는지 확인.
 *   - 코드 집계와 동일한 판정(isTransitionWeekStart, week_start_date 기반)으로
 *     user_week_statuses 를 분할하고, 제외되는 row 수/상태 분포를 보고한다.
 *   - .select 만 사용. UPDATE/INSERT/DELETE/마이그레이션 없음.
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-transition-exclusion.ts
 */
import { createClient } from "@supabase/supabase-js";
import {
  isTransitionWeekStart,
  getSeasonWeekStatusForDate,
} from "../lib/seasonCalendar";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

type Row = {
  week_start_date: string | null;
  status: string | null;
  season_key: string | null;
};

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function fetchAllUws(): Promise<Row[]> {
  const out: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("user_week_statuses")
      .select("week_start_date,status,season_key")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main() {
  console.log("=== 전환 주차 집계 제외 검증 (READ-ONLY) ===\n");

  // ── A. helper 단위 검증 (DB 무관) ─────────────────────────────────────
  console.log("[A] isTransitionWeekStart helper 판정:");
  assert('2025-12-22 (autumn W17) = transition', isTransitionWeekStart("2025-12-22") === true);
  assert('2026-02-23 (winter W9) = transition', isTransitionWeekStart("2026-02-23") === true);
  assert('2026-02-16 (winter W8 정규) ≠ transition', isTransitionWeekStart("2026-02-16") === false,
    `status=${getSeasonWeekStatusForDate("2026-02-16")}`);
  assert('2025-12-15 (autumn W16 정규) ≠ transition', isTransitionWeekStart("2025-12-15") === false,
    `status=${getSeasonWeekStatusForDate("2025-12-15")}`);

  // ── B. 실제 uws 데이터 분할 ───────────────────────────────────────────
  const all = await fetchAllUws();
  const transition = all.filter(
    (r) => r.week_start_date && isTransitionWeekStart(r.week_start_date),
  );
  console.log(`\n[B] user_week_statuses 총 ${all.length} rows`);
  console.log(`    전환 주차로 식별되어 집계 제외될 rows = ${transition.length}`);

  // (week_start_date, status) 분포
  const byKey = new Map<string, number>();
  for (const r of transition) {
    const k = `${r.week_start_date}|${r.status}`;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  console.log("\n[C] 제외 대상 분포 (week_start_date | status → count):");
  for (const [k, c] of [...byKey.entries()].sort()) {
    console.log(`    ${k} → ${c}`);
  }

  // ── D. 핵심 수치 단언 (요청 6) ────────────────────────────────────────
  console.log("\n[D] 기대 수치 단언:");
  const autumnOR = transition.filter(
    (r) => r.week_start_date === "2025-12-22" && r.status === "official_rest",
  ).length;
  const winterSuccess = transition.filter(
    (r) => r.week_start_date === "2026-02-23" && r.status === "success",
  ).length;
  assert("2025-autumn W17 official_rest = 18건 제외", autumnOR === 18, `실제 ${autumnOR}`);
  assert("2026-winter W9 success = 60건 제외", winterSuccess === 60, `실제 ${winterSuccess}`);
  assert("전환 주차 총 제외 = 78건", transition.length === 78, `실제 ${transition.length}`);

  // ── E. 집계 델타 시뮬레이션 (제외 전/후 status 합계) ──────────────────
  const tallyAll = tally(all);
  const tallyKept = tally(all.filter((r) => !(r.week_start_date && isTransitionWeekStart(r.week_start_date))));
  console.log("\n[E] status 합계 — 제외 전 → 제외 후 (델타):");
  for (const s of ["success", "fail", "personal_rest", "official_rest"]) {
    const before = tallyAll.get(s) ?? 0;
    const after = tallyKept.get(s) ?? 0;
    console.log(`    ${s.padEnd(14)} ${before} → ${after}  (Δ ${after - before})`);
  }
  assert(
    "델타: official_rest −18, success −60",
    (tallyAll.get("official_rest") ?? 0) - (tallyKept.get("official_rest") ?? 0) === 18 &&
      (tallyAll.get("success") ?? 0) - (tallyKept.get("success") ?? 0) === 60,
  );

  console.log(`\n=== 결과: ${failures === 0 ? "ALL PASS ✅" : `${failures} FAIL ❌`} ===`);
  if (failures > 0) process.exit(1);
}

function tally(rows: Row[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!r.status) continue;
    m.set(r.status, (m.get(r.status) ?? 0) + 1);
  }
  return m;
}

main().catch((e) => {
  console.error("검증 실패:", e?.message ?? e);
  process.exit(1);
});
