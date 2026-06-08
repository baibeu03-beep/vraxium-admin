// conflicts B/C그룹 보정 (2026-06-07). A그룹(2023-autumn)은 의도적으로 제외.
//  C: official_rest_periods 에 "2025 설 연휴" 등록 (canonical lib 경유 — stale 트리거 포함)
//  B: 2024-autumn W6~8·W14~16 weeks.is_official_rest=false → true 보정 (id 지정)
// 사전 백업 로그: claudedocs/conflict-fix-backup-20260607.json
import { writeFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createOfficialRestPeriod } from "@/lib/officialRestPeriodsData";

const B_WEEK_IDS = [
  "8d18584b-38f3-4a73-9f47-f7dcba21ac7e", // 2024-autumn W6
  "67906ed8-b316-469e-b491-5dafe24b7cc5", // W7
  "7d41357b-8212-44b2-bad6-45090641e6b4", // W8
  "a74ecd68-7a0b-4e60-bc2d-5634c551bc33", // W14
  "6e355dc9-d662-4497-8378-25b9743808f1", // W15
  "9f11a6c6-902d-4d46-9f54-c03a371c62cf", // W16
];

async function main() {
  // ── 0. 백업 ──────────────────────────────────────────────────────────
  const { data: periodsBefore, error: pErr } = await supabaseAdmin
    .from("official_rest_periods")
    .select("*")
    .order("start_date");
  if (pErr) throw pErr;
  const { data: weeksBefore, error: wErr } = await supabaseAdmin
    .from("weeks")
    .select("*")
    .in("id", B_WEEK_IDS)
    .order("start_date");
  if (wErr) throw wErr;
  if ((weeksBefore ?? []).length !== 6) {
    throw new Error(`backup expected 6 weeks rows, got ${weeksBefore?.length}`);
  }
  // 가드: 대상이 전부 2024-autumn + is_official_rest=false 인지 확인 후 진행
  for (const w of weeksBefore!) {
    if (w.season_key !== "2024-autumn" || w.is_official_rest !== false) {
      throw new Error(`guard failed: ${w.id} season=${w.season_key} rest=${w.is_official_rest}`);
    }
  }
  // 가드: 2025 설 period 미존재 확인 (중복 등록 방지)
  const dup = (periodsBefore ?? []).find(
    (p) => p.start_date <= "2025-02-02" && p.end_date >= "2025-01-27",
  );
  if (dup) throw new Error(`guard failed: overlapping period exists: ${dup.name}`);

  writeFileSync(
    "claudedocs/conflict-fix-backup-20260607.json",
    JSON.stringify(
      { backedUpAt: new Date().toISOString(), official_rest_periods: periodsBefore, weeks_b_group: weeksBefore },
      null,
      2,
    ),
    "utf-8",
  );
  console.log("백업 저장: claudedocs/conflict-fix-backup-20260607.json");

  // ── 1. C그룹: 2025 설 연휴 등록 (2026 설과 동일하게 주차 전체 범위 컨벤션) ──
  const dto = await createOfficialRestPeriod({
    name: "2025 설 연휴",
    type: "lunar_new_year",
    startDate: "2025-01-27",
    endDate: "2025-02-02",
    description:
      "2025 설 연휴(1/28~1/30) 공식 휴식. legacy(official_rest_weeks 2025-W5)와 신규 SoT 정합 보정 — 2026-06-07 conflicts C그룹 처리.",
    isActive: true,
  });
  console.log(`[C] official_rest_periods 등록: ${dto.id} ${dto.name} ${dto.startDate}~${dto.endDate}`);

  // ── 2. B그룹: weeks.is_official_rest=true 보정 ───────────────────────
  const { data: updated, error: uErr } = await supabaseAdmin
    .from("weeks")
    .update({ is_official_rest: true })
    .in("id", B_WEEK_IDS)
    .select("id,season_key,week_number,start_date,is_official_rest");
  if (uErr) throw uErr;
  console.log(`[B] weeks.is_official_rest=true 보정: ${updated?.length}건`);
  for (const w of updated ?? []) {
    console.log(`  ${w.id} ${w.season_key} W${w.week_number} ${w.start_date} → rest=${w.is_official_rest}`);
  }

  // ── 3. snapshot stale 확인 ───────────────────────────────────────────
  const { count: staleAfter } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true })
    .eq("is_stale", true);
  console.log(`[snapshot] 적용 후 is_stale=true: ${staleAfter ?? 0}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
