/**
 * 진단 — [섹션.1] 2026 봄 14~17주차 "-" 원인 + Oldest 활동시작주차 누락 원인.
 * Usage: npx tsx --env-file=.env.local scripts/diag-info-stats-issues.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";

async function main() {
  // ── 1) 2026-spring 14~17주차 메타 ──
  const { data: weeks } = await supabaseAdmin
    .from("weeks")
    .select("id, season_key, week_number, start_date, end_date, is_official_rest, result_published_at")
    .eq("season_key", "2026-spring")
    .gte("week_number", 13)
    .lte("week_number", 17)
    .order("week_number", { ascending: true });

  console.log("══════ 2026-spring W13~17 주차 메타 ══════");
  const sw = await loadSeasonWeeks();
  for (const w of (weeks ?? []) as any[]) {
    const dto = sw.rows.find((r) => r.week_id === w.id);
    console.log(`\n[W${w.week_number}] week_id=${w.id}`);
    console.log(`  시즌/주차      : 2026-spring ${w.week_number}주차 (${w.start_date}~${w.end_date})`);
    console.log(`  is_official_rest: ${w.is_official_rest} · is_transition(dto)=${dto?.is_transition} · 휴식판정(dto)=${dto?.is_official_rest}`);
    console.log(`  클럽 상태       : ${dto?.is_official_rest || dto?.is_transition ? "공식 휴식" : "공식 활동"}`);
    console.log(`  result_published_at: ${w.result_published_at ?? "NULL (미확정)"}`);

    // snapshot 카드 분포 — encre 로스터 표본으로 이 week_id 카드의 userWeekStatus 집계.
    // (전체 snapshot 을 스캔하면 무겁다 → encre 활동 로스터 200명 표본)
    const { data: roster } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("organization_slug", "encre")
      .not("activity_started_at", "is", null)
      .limit(400);
    const ids = (roster ?? []).map((r: any) => r.user_id);
    const dist: Record<string, number> = {};
    let cardsForWeek = 0;
    const CH = 50;
    for (let i = 0; i < ids.length; i += CH) {
      const { data } = await supabaseAdmin
        .from("cluster4_weekly_card_snapshots")
        .select("cards")
        .in("user_id", ids.slice(i, i + CH));
      for (const row of (data ?? []) as any[]) {
        if (!Array.isArray(row.cards)) continue;
        for (const c of row.cards) {
          if (c.weekId === w.id) {
            cardsForWeek++;
            dist[c.userWeekStatus] = (dist[c.userWeekStatus] ?? 0) + 1;
          }
        }
      }
    }
    console.log(`  snapshot 카드 존재(encre표본 ${ids.length}명 중): ${cardsForWeek}개`);
    console.log(`  userWeekStatus 분포: ${JSON.stringify(dist)}`);
    const finalizedStatuses = (dist.success ?? 0) + (dist.fail ?? 0) + (dist.personal_rest ?? 0) + (dist.official_rest ?? 0);
    console.log(`  → 확정성 카드(success/fail/personal_rest/official_rest): ${finalizedStatuses} · 미확정(running/tallying): ${(dist.running ?? 0) + (dist.tallying ?? 0)}`);
    console.log(`  → 왜 "-": result_published_at ${w.result_published_at ? "있음 → 집계 표시" : "NULL → 미확정 게이트로 전부 null"}`);
  }

  // ── 2) Oldest 후보(황수아/윤채영) activity_started_at + 주차 변환 ──
  console.log("\n\n══════ Oldest 후보 activity_started_at ══════");
  const names = ["황수아", "윤채영"];
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, organization_slug, activity_started_at, status, growth_status")
    .in("display_name", names);
  for (const p of (profs ?? []) as any[]) {
    console.log(`\n[${p.display_name}] (${p.organization_slug}) user_id=${p.user_id}`);
    console.log(`  activity_started_at: ${p.activity_started_at ?? "NULL"}`);
    console.log(`  status=${p.status} · growth_status=${p.growth_status}`);
    if (p.activity_started_at) {
      const date = p.activity_started_at.slice(0, 10);
      const w = sw.rows.find(
        (r) => r.week_start_date != null && r.week_end_date != null && r.week_start_date <= date && date <= r.week_end_date,
      );
      if (w) {
        console.log(`  → 포함 주차: ${w.season_key} ${w.week_number}주차 (${w.week_start_date}~${w.week_end_date})`);
      } else {
        // 가장 가까운 주차 경계 확인.
        const sorted = sw.rows.filter((r) => r.week_start_date).sort((a, b) => (a.week_start_date! < b.week_start_date! ? -1 : 1));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        console.log(`  → 포함 주차 없음! weeks 범위: ${first?.week_start_date} ~ ${last?.week_end_date}`);
        console.log(`     activity_started_at(${date})가 어떤 week_start~week_end 구간에도 안 들어감(결번/경계).`);
        // 근처 주차 표시.
        const near = sorted.filter((r) => r.week_start_date! <= date).slice(-2).concat(sorted.filter((r) => r.week_start_date! > date).slice(0, 2));
        for (const n of near) {
          console.log(`     근처: ${n.season_key} W${n.week_number} ${n.week_start_date}~${n.week_end_date}`);
        }
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
