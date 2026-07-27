/**
 * 공표 snapshot 액트 체크율 정정 — dry-run 기본 / --apply 시에만 write.
 *
 *   dry-run : npx tsx --env-file=.env.local scripts/backfill-published-act-rate.ts
 *   적용    : npx tsx --env-file=.env.local scripts/backfill-published-act-rate.ts --apply
 *
 * 배경(2026-07-27): `crewWeekShowcase.loadActRates` 가 2026-07-13 'line' source 도입 이래
 *   원장 source 필터 없이 집계해, **라인 지급(line·line_rating)까지 액트로 세어** 공표 시점에
 *   부풀려진 액트 체크율/건수를 snapshot 에 굳혔다. 정책 확정(lib/pointAwardSourcePolicy.ts)에 따라
 *   액트 수행 집계 allowlist = regular·irregular 뿐이므로, 굳어 있는 값을 그 기준으로 정정한다.
 *
 * ── 수정 범위(이 3개 컬럼 뿐) ────────────────────────────────────────────────
 *   cluster4_week_finalize_run_crew_results
 *     · act_completion_rate_percent
 *     · act_total_count
 *     · act_success_count
 *   (팀 결과·run 헤더에는 액트 필드가 없다 — 실측 확인. 다른 테이블 무접촉.)
 *
 * ── 절대 건드리지 않는 것 ───────────────────────────────────────────────────
 *   주차 성공·실패(result·uws_status) · criterion_point_a · earned_point_a ·
 *   user_weekly_points · 라인 강화 상태 · 평점 · process_point_awards 원장 ·
 *   그 밖의 snapshot 컬럼 · finalize run 의 created_at/reverted_at/snapshot_captured ·
 *   user_week_statuses · weekly card snapshot.  **재공표(republish)도 하지 않는다.**
 *
 * ── 대상 범위 ───────────────────────────────────────────────────────────────
 *   화면이 실제로 읽는 **활성 run** 만(reverted_at IS NULL && snapshot_captured=true).
 *   되돌려진(reverted) run 은 감사 기록이므로 그대로 둔다.
 *
 * 멱등: 재실행하면 "차이 있는 행"이 0 이 되어 아무것도 쓰지 않는다.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 백필 스크립트: raw row 를 직접 훑는다. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildCrewActSummary, type CrewActSummaryRow } from "@/shared/crewActSummary";
import { isActPerformanceSource } from "@/lib/pointAwardSourcePolicy";

const APPLY = process.argv.includes("--apply");

type Row = {
  id: string;
  runId: string;
  org: string;
  weekLabel: string;
  weekId: string;
  userId: string;
  userName: string;
  beforeTotal: number | null;
  beforeSuccess: number | null;
  beforeRate: number | null;
  afterTotal: number;
  afterSuccess: number;
  afterRate: number | null;
  hasCardSnapshot: boolean;
};

const pad = (v: unknown, n: number) => String(v ?? "").padEnd(n);
const padS = (v: unknown, n: number) => String(v ?? "").padStart(n);

async function main() {
  console.log(APPLY ? "▶ APPLY 모드 — DB 를 씁니다.\n" : "▶ DRY-RUN — DB write 0.\n");

  // 활성 run 만(화면이 읽는 snapshot).
  const { data: runData, error: runErr } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .select("id,week_id,organization_slug,scope,created_at,reverted_at,snapshot_captured")
    .is("reverted_at", null)
    .eq("snapshot_captured", true);
  if (runErr) throw runErr;
  const runs = (runData ?? []) as any[];

  const { data: wkData } = await supabaseAdmin
    .from("weeks").select("id,season_key,week_number,iso_year,iso_week,start_date");
  const W = new Map(((wkData ?? []) as any[]).map((w) => [w.id, w]));

  const changed: Row[] = [];
  let scanned = 0;
  let runsWithoutIso = 0;

  for (const run of runs) {
    const w = W.get(run.week_id);
    if (!w || w.iso_year == null || w.iso_week == null) { runsWithoutIso++; continue; }

    const { data: crData, error: crErr } = await supabaseAdmin
      .from("cluster4_week_finalize_run_crew_results")
      .select("id,user_id,crew_display_name,organization_slug,act_completion_rate_percent,act_total_count,act_success_count")
      .eq("run_id", run.id);
    if (crErr) throw crErr;
    const crews = (crData ?? []) as any[];
    if (crews.length === 0) continue;

    // 그 주차의 원장 전량(활성 행만). 액트 allowlist 로 걸러 공통 빌더에 넣는다 —
    //   런타임 경로(loadActRates)와 **같은 필터·같은 빌더**라 산식이 갈리지 않는다.
    const { data: awData } = await supabaseAdmin
      .from("process_point_awards")
      .select("user_id,source,point_check,point_advantage,point_penalty,cancelled_at")
      .eq("year", w.iso_year)
      .eq("week_number", w.iso_week);
    const active = ((awData ?? []) as any[]).filter((r) => !r.cancelled_at);

    // 카드 snapshot 보유 여부(이 크루들 기준) — 보고용.
    const uids = crews.map((c) => c.user_id);
    const snapUsers = new Set<string>();
    for (let i = 0; i < uids.length; i += 60) {
      const { data } = await supabaseAdmin
        .from("cluster4_weekly_card_snapshots").select("user_id").in("user_id", uids.slice(i, i + 60));
      for (const r of ((data ?? []) as any[])) snapUsers.add(r.user_id);
    }

    for (const c of crews) {
      scanned++;
      const rows: CrewActSummaryRow[] = active
        .filter((r) => r.user_id === c.user_id && isActPerformanceSource(r.source))
        .map((r) => ({
          result: "checked",
          source: r.source === "irregular" ? "irregular" : "regular",
          kindKey: "unknown",
          pointA: Number(r.point_check ?? 0),
          pointB: Number(r.point_advantage ?? 0),
          pointC: Math.abs(Number(r.point_penalty ?? 0)),
        }) as CrewActSummaryRow);
      const s = buildCrewActSummary(rows);
      // 저장 규칙과 동일: total=0 → rate null("-"). (crewWeekShowcase.loadActRates 와 같은 처리)
      const afterRate = s.total > 0 ? s.rate : null;

      if (
        c.act_completion_rate_percent === afterRate &&
        c.act_total_count === s.total &&
        c.act_success_count === s.success
      ) continue;

      changed.push({
        id: c.id, runId: run.id, org: c.organization_slug ?? run.organization_slug,
        weekLabel: `${w.season_key} W${w.week_number}`, weekId: run.week_id,
        userId: c.user_id, userName: c.crew_display_name ?? c.user_id.slice(0, 8),
        beforeTotal: c.act_total_count, beforeSuccess: c.act_success_count, beforeRate: c.act_completion_rate_percent,
        afterTotal: s.total, afterSuccess: s.success, afterRate,
        hasCardSnapshot: snapUsers.has(c.user_id),
      });
    }
  }

  // ── 보고 ────────────────────────────────────────────────────────────────
  console.log(`활성 run ${runs.length}건(iso 미상 ${runsWithoutIso}건 제외) · 크루 결과 ${scanned}행 스캔`);
  console.log(`정정 대상: ${changed.length}행\n`);

  const byWeek = new Map<string, { n: number; snap: number }>();
  for (const r of changed) {
    const k = `${r.org}|${r.weekLabel}`;
    const v = byWeek.get(k) ?? { n: 0, snap: 0 };
    v.n++; if (r.hasCardSnapshot) v.snap++;
    byWeek.set(k, v);
  }
  console.log("── 조직 × 주차별 집계 ──");
  console.log("  " + pad("조직", 9) + pad("주차", 18) + padS("정정 행", 8) + padS("카드 snapshot 보유", 20));
  for (const [k, v] of [...byWeek.entries()].sort()) {
    const [org, wk] = k.split("|");
    console.log("  " + pad(org, 9) + pad(wk, 18) + padS(v.n, 8) + padS(v.snap, 20));
  }

  console.log("\n── 행 상세 ──");
  console.log(
    "  " + pad("조직", 9) + pad("주차", 16) + pad("run", 10) + pad("사용자", 14) +
      padS("전 건수", 8) + padS("전 성공", 8) + padS("전 체크율", 10) +
      padS("후 건수", 8) + padS("후 성공", 8) + padS("후 체크율", 10) +
      padS("Δ건수", 7) + padS("Δ체크율", 9) + padS("snapshot", 10),
  );
  for (const r of changed) {
    const dTotal = r.afterTotal - (r.beforeTotal ?? 0);
    const dRate = r.afterRate == null || r.beforeRate == null ? "—" : String(r.afterRate - r.beforeRate);
    console.log(
      "  " + pad(r.org, 9) + pad(r.weekLabel, 16) + pad(r.runId.slice(0, 8), 10) + pad(r.userName, 14) +
        padS(r.beforeTotal, 8) + padS(r.beforeSuccess, 8) + padS(r.beforeRate ?? "-", 10) +
        padS(r.afterTotal, 8) + padS(r.afterSuccess, 8) + padS(r.afterRate ?? "-", 10) +
        padS(dTotal >= 0 ? `+${dTotal}` : dTotal, 7) + padS(dRate, 9) + padS(r.hasCardSnapshot ? "보유" : "미보유", 10),
    );
  }

  if (!APPLY) {
    console.log(`\n▶ DRY-RUN 종료 — DB write 0. 적용하려면 --apply.`);
    console.log(`  적용 시 정확히 ${changed.length}행의 act_completion_rate_percent / act_total_count / act_success_count 만 갱신됩니다.`);
    return;
  }

  // ── 적용(3개 컬럼만) ────────────────────────────────────────────────────
  let updated = 0;
  for (const r of changed) {
    const { error, data } = await supabaseAdmin
      .from("cluster4_week_finalize_run_crew_results")
      .update({
        act_completion_rate_percent: r.afterRate,
        act_total_count: r.afterTotal,
        act_success_count: r.afterSuccess,
      })
      .eq("id", r.id)
      .select("id");
    if (error) {
      console.error(`  ❌ ${r.userName} (${r.id}) — ${error.message}`);
      continue;
    }
    updated += (data ?? []).length;
  }
  console.log(`\n적용 완료 — ${updated}행 갱신(대상 ${changed.length}행).`);
  console.log(`  ${updated === changed.length ? "✅" : "❌"} 변경 행 수 == 대상 행 수`);
  console.log("  ※ 재실행하면 정정 대상 0 행이어야 합니다(멱등성 확인).");
}

main().catch((e) => { console.error(e); process.exit(1); });
