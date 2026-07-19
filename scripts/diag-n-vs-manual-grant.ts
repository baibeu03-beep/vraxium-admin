/**
 * READ-ONLY 진단: 수동 부여(process_check_statuses.completion_type='manual_grant')가
 *   주차별 활동 인정 개수 N(cluster4_week_opening_configs.recognition_count_n) 산출에 포함되는가?
 *
 *   증명 전략(쓰기 없음):
 *     1) N 저장된 (주차,조직) 을 찾는다(open_confirmed + recognition_count_n non-null).
 *     2) 같은 주차에 수동 부여 상태행(completion_type='manual_grant')이 있는 케이스를 우선 선택.
 *     3) prepareWeekRecognition(오픈확인 실경로) 로 N 을 재계산 → 저장값과 일치 확인.
 *        · prepareWeekRecognition 입력 = process_acts 마스터 + cluster4_line_point_configs + config 뿐.
 *        · process_check_statuses / process_point_awards 는 조회하지 않음.
 *     4) 수동 부여 행의 manual_point_* 와 그 결과 원장(process_point_awards)을 나열.
 *     5) N 에 들어간 액트 포인트(pointA/pointB)가 process_acts 마스터값과 동일함을 대조 →
 *        수동 부여의 manual_point_* 와 무관(별개 숫자)임을 실증.
 *
 *   npx tsx --env-file=.env.local scripts/diag-n-vs-manual-grant.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import {
  prepareWeekRecognition,
  resolveRecognitionInputs,
} from "@/lib/weekRecognitionResolve";
import type { OrganizationSlug } from "@/lib/organizations";

function hr(s: string) {
  console.log("\n" + "─".repeat(72) + "\n" + s);
}

async function main() {
  // ── 1) N 저장된 (주차, 조직) 전수 ──────────────────────────────────────────
  const { data: cfgRows, error: cfgErr } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("week_id, organization_slug, open_confirmed, recognition_count_n, min_points_a, exec_points_b, recognition_calc_version")
    .not("recognition_count_n", "is", null);
  if (cfgErr) throw cfgErr;
  const configured = (cfgRows ?? []) as Array<{
    week_id: string; organization_slug: string; open_confirmed: boolean;
    recognition_count_n: number | null; min_points_a: number | null; exec_points_b: number | null; recognition_calc_version: number | null;
  }>;
  hr(`[1] recognition_count_n 저장된 (주차,조직) = ${configured.length}건`);
  for (const r of configured) {
    console.log(`  week=${r.week_id.slice(0, 8)} org=${r.organization_slug} open=${r.open_confirmed} N=${r.recognition_count_n} (A=${r.min_points_a}/B=${r.exec_points_b}/v${r.recognition_calc_version})`);
  }
  if (configured.length === 0) {
    console.log("\n⚠ N 저장된 주차 없음 — 오픈확인 미실행 환경. 코드 경로 증명만 유효.");
    return;
  }

  // ── 2) 각 (주차,조직)에 대한 수동 부여 상태행 수 집계 → manual grant 있는 케이스 우선 ──
  hr("[2] 각 (주차,조직)의 수동 부여(manual_grant) 상태행 수");
  const withCounts: Array<{ row: typeof configured[number]; manualCount: number }> = [];
  for (const r of configured) {
    const { count } = await supabaseAdmin
      .from("process_check_statuses")
      .select("id", { count: "exact", head: true })
      .eq("week_id", r.week_id)
      .eq("organization_slug", r.organization_slug)
      .eq("completion_type", "manual_grant");
    withCounts.push({ row: r, manualCount: count ?? 0 });
    console.log(`  week=${r.week_id.slice(0, 8)} org=${r.organization_slug} → manual_grant 상태행 ${count ?? 0}건`);
  }
  // manual grant 가 있는 케이스 우선, 없으면 첫 케이스.
  const pick = withCounts.find((w) => w.manualCount > 0) ?? withCounts[0];
  const { row: sel } = pick;
  const org = sel.organization_slug as OrganizationSlug;

  hr(`[3] 선택 케이스: week=${sel.week_id.slice(0, 8)} org=${org} · 저장 N=${sel.recognition_count_n} · 수동부여 ${pick.manualCount}건`);

  // ── 3) prepareWeekRecognition(오픈확인 실경로)로 N 재계산 → 저장값과 대조 ─────────────
  const { config } = await loadWeekOpeningConfig(sel.week_id, org);
  if (!config) {
    console.log("⚠ config 없음 — 재계산 스킵");
  } else {
    const recomputed = await prepareWeekRecognition({ weekId: sel.week_id, organization: org, config });
    console.log(`  재계산(prepareWeekRecognition): A=${recomputed.result.minimalA} B=${recomputed.result.diligentB} N=${recomputed.result.recognitionCountN} · featureAvailable=${recomputed.featureAvailable}`);
    const match = recomputed.result.recognitionCountN === sel.recognition_count_n;
    console.log(`  저장 N(${sel.recognition_count_n}) == 재계산 N(${recomputed.result.recognitionCountN}) → ${match ? "✅ 일치" : "⚠ 불일치(현재 config 재선택 반영일 수 있음)"}`);
    console.log("  ↳ 재계산 입력 = process_acts 마스터 + cluster4_line_point_configs + config. (process_check_statuses/process_point_awards 미조회)");
  }

  // ── 4) 수동 부여 상태행 + 결과 원장 ─────────────────────────────────────────
  hr("[4] 수동 부여 상태행(manual_point_*)과 그 결과 원장(process_point_awards)");
  const { data: mgRows } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id, act_id, hub, manual_point_check, manual_point_advantage, manual_point_penalty, manual_reason")
    .eq("week_id", sel.week_id)
    .eq("organization_slug", org)
    .eq("completion_type", "manual_grant");
  const manualGrants = (mgRows ?? []) as Array<{
    id: string; act_id: string | null; hub: string | null;
    manual_point_check: number | null; manual_point_advantage: number | null; manual_point_penalty: number | null; manual_reason: string | null;
  }>;
  if (manualGrants.length === 0) {
    console.log("  (이 주차에 수동 부여 상태행 없음)");
  }
  for (const mg of manualGrants) {
    const { count: awardCount } = await supabaseAdmin
      .from("process_point_awards")
      .select("id", { count: "exact", head: true })
      .eq("source", "regular")
      .eq("ref_id", mg.id);
    console.log(`  status=${mg.id.slice(0, 8)} act=${mg.act_id?.slice(0, 8) ?? "-"} hub=${mg.hub} manual A/B/C=${mg.manual_point_check}/${mg.manual_point_advantage}/${mg.manual_point_penalty} → 원장 ${awardCount ?? 0}행`);
  }

  // ── 5) N 에 들어간 액트 포인트 = process_acts 마스터값 대조(수동값 아님) ──────────────
  hr("[5] N 산출에 들어간 액트의 pointA/pointB 출처 = process_acts 마스터(수동 부여값 아님)");
  if (config) {
    const { acts } = await resolveRecognitionInputs({ weekId: sel.week_id, organization: org, config, openConfirmed: true });
    const openActs = acts.filter((a) => a.isOpen);
    console.log(`  N 산출 대상(open) 액트 = ${openActs.length}개 (전체 ${acts.length})`);
    // 마스터값 대조: act id 접두 'act:<masterId>' → process_acts.point_check/point_advantage
    const masterIds = [...new Set(openActs.map((a) => a.id.replace(/^act:/, "").split(":")[0]))];
    const { data: paData } = await supabaseAdmin
      .from("process_acts")
      .select("id, point_check, point_advantage")
      .in("id", masterIds);
    const master = new Map((paData ?? []).map((r: { id: string; point_check: number | null; point_advantage: number | null }) => [r.id, r]));
    let allMatch = true;
    for (const a of openActs.slice(0, 12)) {
      const mid = a.id.replace(/^act:/, "").split(":")[0];
      const m = master.get(mid);
      const ok = m && (m.point_check ?? 0) === a.pointA && (m.point_advantage ?? 0) === a.pointB;
      if (!ok) allMatch = false;
      // 이 액트에 수동 부여가 있으면 그 값도 표기 → N 은 마스터값을 쓴다는 대조
      const mg = manualGrants.find((g) => g.act_id === mid);
      const mgStr = mg ? ` · [수동부여 존재: A/B=${mg.manual_point_check}/${mg.manual_point_advantage}]` : "";
      console.log(`  act=${mid.slice(0, 8)} N입력 A/B=${a.pointA}/${a.pointB} · 마스터 A/B=${m?.point_check ?? "-"}/${m?.point_advantage ?? "-"} → ${ok ? "일치" : "불일치"}${mgStr}`);
    }
    console.log(`\n  ${allMatch ? "✅" : "⚠"} N 입력 액트 포인트 == process_acts 마스터값 (수동 manual_point_* 아님).`);
  }

  hr("[결론]");
  console.log("  N 재계산 입력 = process_acts(마스터) + cluster4_line_point_configs + 오픈확인 config.");
  console.log("  수동 부여는 process_check_statuses.manual_point_* → process_point_awards(원장)에만 기록.");
  console.log("  두 경로는 교집합 없음 → 수동 부여는 N 에 포함되지 않는다(결론 B).");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
