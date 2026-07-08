/**
 * uws 운영 주차 확정 — READ-ONLY 프리뷰 검증 (DB 무변경).
 *   검수 완료 시 finalizeWeekUws 가 무엇을 할지 실제로 쓰지 않고 미리 보여준다:
 *     - 안전장치(적립 완료) 게이트 결과
 *     - 코호트(전 org 시즌 참여자) 규모/org 분포
 *     - 각 유저 verdict(success/fail/personal_rest/pending/skip) 분포
 *     - 현재 uws 유무(= 공표 후 no_data 드롭 위험 유저)
 *
 *   npx tsx --env-file=.env.local scripts/verify-uws-operating-finalization.ts [weekId]
 *   기본 weekId = 2026-summer W1 (496656d0-...).
 *
 * ⚠ 이 스크립트는 finalizeWeekUws 를 호출하지 않는다(쓰기 0). 읽기 전용 부품만 사용.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  assertWeekAccrualComplete,
  loadFinalizeCohort,
  type FinalizeWeekRow,
} from "@/lib/adminWeekUwsFinalize";
import { fetchExperienceRequiredSlotStatusByWeek } from "@/lib/lineAvailability";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const WEEK_ID = process.argv[2] ?? "496656d0-8d92-4738-b69b-e5e28aa1d57a";

async function main() {
  const { data: wk, error } = await supabaseAdmin
    .from("weeks")
    .select(
      "id,start_date,end_date,season_key,week_number,iso_year,iso_week,is_official_rest,check_threshold,result_published_at,result_reviewed_at",
    )
    .eq("id", WEEK_ID)
    .maybeSingle();
  if (error || !wk) {
    console.error("주차 조회 실패:", error?.message ?? "not found");
    process.exit(1);
  }
  const w = wk as Record<string, unknown>;
  console.log("=== 주차 메타 ===");
  console.log({
    weekId: WEEK_ID,
    seasonKey: w.season_key,
    weekNumber: w.week_number,
    startDate: w.start_date,
    isoYearWeek: `${w.iso_year}/${w.iso_week}`,
    isOfficialRest: w.is_official_rest,
    weeksCheckThreshold: w.check_threshold,
    published: w.result_published_at,
    reviewed: w.result_reviewed_at,
    legacy: String(w.start_date) < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  });

  // org_week_thresholds (org별 기준값) — 이 주차.
  const { data: owt } = await supabaseAdmin
    .from("org_week_thresholds")
    .select("organization_slug,check_threshold")
    .eq("week_id", WEEK_ID);
  console.log("org_week_thresholds:", owt ?? []);

  const week: FinalizeWeekRow = {
    id: WEEK_ID,
    start_date: w.start_date as string | null,
    end_date: w.end_date as string | null,
    season_key: w.season_key as string | null,
    iso_year: w.iso_year as number | null,
    iso_week: w.iso_week as number | null,
    is_official_rest: w.is_official_rest as boolean | null,
  };

  console.log("\n=== 안전장치(적립 완료) 게이트 ===");
  const gate = await assertWeekAccrualComplete(week);
  console.log(gate);

  console.log("\n=== 코호트 (operating scope, 전 org) ===");
  const cohort = await loadFinalizeCohort(week.season_key ?? "", "operating");
  const orgDist: Record<string, number> = {};
  for (const m of cohort) orgDist[m.org ?? "null"] = (orgDist[m.org ?? "null"] ?? 0) + 1;
  console.log(`코호트 수: ${cohort.length}`, "org 분포:", orgDist);

  // 현재 uws 유무 (공표 후 no_data 드롭 위험 = uws 없는 참여자).
  const cohortIds = cohort.map((m) => m.userId);
  const haveUws = new Set<string>();
  for (let i = 0; i < cohortIds.length; i += 300) {
    const chunk = cohortIds.slice(i, i + 300);
    const { data } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id")
      .eq("week_start_date", week.start_date)
      .in("user_id", chunk);
    for (const r of (data ?? []) as { user_id: string }[]) haveUws.add(r.user_id);
  }
  const noUws = cohort.filter((m) => !haveUws.has(m.userId));
  console.log(`현재 uws 보유: ${haveUws.size} / uws 없음(드롭 위험): ${noUws.length}`);

  // verdict 프리뷰 (샘플 최대 20명 — 전량은 비용 큼).
  console.log("\n=== verdict 프리뷰 (샘플 최대 20명) ===");
  const sample = cohort.slice(0, 20);
  const alwaysOpen = new Set<string>([WEEK_ID]);
  const dist: Record<string, number> = { success: 0, fail: 0, personal_rest: 0, pending: 0, skip: 0 };
  for (const m of sample) {
    const vmap = await fetchExperienceRequiredSlotStatusByWeek(m.userId, [WEEK_ID], Date.now(), {
      alwaysOpenWeekIds: alwaysOpen,
      organizationSlug: m.org,
    });
    const v = vmap.get(WEEK_ID);
    let bucket: string;
    if (!v || v.status === "not_applicable") bucket = "skip";
    else if (v.status === "pending") bucket = "pending";
    else if (v.status === "pass") bucket = "success";
    else bucket = "fail";
    dist[bucket]++;
    console.log(
      `  ${m.userId.slice(0, 8)} org=${m.org ?? "-"} uws=${haveUws.has(m.userId) ? "Y" : "N"} → ${bucket}` +
        (v?.checkGate ? ` (check ${v.checkGate.earned}/${v.checkGate.required}${v.checkGate.passed ? " PASS" : " FAIL"})` : ""),
    );
  }
  console.log("샘플 verdict 분포:", dist);

  console.log("\n=== 요약 ===");
  console.log(
    `이 주차 검수 완료 시: 게이트 ${gate.ok ? "통과" : "차단(" + gate.reason + ")"}, ` +
      `코호트 ${cohort.length}명 중 uws 없는 ${noUws.length}명이 현재 드롭 위험 → 확정으로 uws 생성 시 해소 예상.`,
  );
}

main().then(() => process.exit(0));
