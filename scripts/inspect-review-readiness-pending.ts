/**
 * READ-ONLY 조사: 주차 검수 준비 상태의 "프로세스 활동 점수 확인 — 미완료 N건" 정체 규명.
 *   assertWeekAccrualComplete 는 process_check_statuses(status=pending) + process_irregular_acts
 *   (kind=review_request, status=pending) 를 week_id 만으로 센다 — act 의 is_active/check_target,
 *   org/hub/mode 무필터. 이 스크립트는 그 pending 행들을 act 마스터와 조인해 실제 정체를 출력한다.
 *
 *   운영 DB 미변경(SELECT 만). npx tsx --env-file=.env.local scripts/inspect-review-readiness-pending.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  // 1) 모든 pending 정규 체크 상태 행.
  const { data: pendRows, error: pendErr } = await supabaseAdmin
    .from("process_check_statuses")
    .select(
      "id, organization_slug, hub, week_id, line_group_id, act_id, status, review_link, scheduled_check_at, requested_at, created_at",
    )
    .eq("status", "pending");
  if (pendErr) {
    console.error("process_check_statuses query error:", pendErr.message);
    process.exit(1);
  }
  const pend = pendRows ?? [];
  console.log(`\n=== pending process_check_statuses: ${pend.length}건 ===`);

  // 관련 act / week 를 배치 조회.
  const actIds = [...new Set(pend.map((r: any) => r.act_id).filter(Boolean))];
  const weekIds = [...new Set(pend.map((r: any) => r.week_id).filter(Boolean))];

  const actById = new Map<string, any>();
  if (actIds.length > 0) {
    const { data: acts } = await supabaseAdmin
      .from("process_acts")
      .select("id, hub, line_group_id, act_type, is_active, check_target, point_check, point_advantage, point_penalty, cafe, occur_week")
      .in("id", actIds);
    for (const a of acts ?? []) actById.set((a as any).id, a);
  }
  // act 이름은 어디에? process_acts 컬럼 확인용 별도 조회(전체 컬럼).
  if (actIds.length > 0) {
    const { data: full } = await supabaseAdmin.from("process_acts").select("*").in("id", actIds).limit(1);
    console.log(`\n[process_acts 컬럼]: ${full && full[0] ? Object.keys(full[0]).join(", ") : "(없음)"}`);
  }

  const weekById = new Map<string, any>();
  if (weekIds.length > 0) {
    const { data: weeks } = await supabaseAdmin
      .from("weeks")
      .select("id, start_date, end_date, season_key, iso_year, iso_week, is_official_rest")
      .in("id", weekIds);
    for (const w of weeks ?? []) weekById.set((w as any).id, w);
  }

  for (const r of pend as any[]) {
    const a = actById.get(r.act_id);
    const w = weekById.get(r.week_id);
    console.log(`\n─ status.id=${r.id}`);
    console.log(`  org=${r.organization_slug} hub=${r.hub} week_id=${r.week_id}`);
    console.log(`  week: start=${w?.start_date} season=${w?.season_key} iso=${w?.iso_year}/${w?.iso_week} official_rest=${w?.is_official_rest}`);
    console.log(`  act_id=${r.act_id}`);
    if (a) {
      console.log(`  act: name=${(a as any).name ?? (a as any).act_name ?? "?"} hub=${a.hub} type=${a.act_type} is_active=${a.is_active} check_target=${a.check_target} A/B/C=${a.point_check}/${a.point_advantage}/${a.point_penalty} cafe=${a.cafe}`);
    } else {
      console.log(`  act: (process_acts 행 없음 — 삭제/고아?)`);
    }
    console.log(`  review_link=${r.review_link ?? "(없음)"} scheduled_check_at=${r.scheduled_check_at ?? "(없음)"} requested_at=${r.requested_at ?? "(없음)"}`);
  }

  // 2) pending 변동(review_request) 액트.
  const { data: irrRows, error: irrErr } = await supabaseAdmin
    .from("process_irregular_acts")
    .select("id, organization_slug, week_id, kind, act_name, target_user_id, target_user_name, status, review_link, scheduled_check_at, created_at")
    .eq("kind", "review_request")
    .eq("status", "pending");
  if (irrErr) console.error("irregular query error:", irrErr.message);
  const irr = irrRows ?? [];
  console.log(`\n\n=== pending process_irregular_acts(review_request): ${irr.length}건 ===`);
  for (const r of irr as any[]) {
    const w = weekById.get(r.week_id);
    console.log(`\n─ irr.id=${r.id} org=${r.organization_slug} week_id=${r.week_id} (start=${w?.start_date ?? "?"})`);
    console.log(`  act_name=${r.act_name} target=${r.target_user_name}(${r.target_user_id}) review_link=${r.review_link ?? "(없음)"} scheduled=${r.scheduled_check_at ?? "(없음)"}`);
  }

  // 3) week 별 pending 요약(어느 주차에 미완료가 몰렸는지).
  console.log(`\n\n=== week_id 별 pending 요약 ===`);
  const byWeek = new Map<string, { reg: number; irr: number }>();
  for (const r of pend as any[]) {
    const k = r.week_id;
    const e = byWeek.get(k) ?? { reg: 0, irr: 0 };
    e.reg++;
    byWeek.set(k, e);
  }
  for (const r of irr as any[]) {
    const k = r.week_id;
    const e = byWeek.get(k) ?? { reg: 0, irr: 0 };
    e.irr++;
    byWeek.set(k, e);
  }
  for (const [k, v] of byWeek) {
    const w = weekById.get(k);
    console.log(`  week=${k} start=${w?.start_date ?? "?"} season=${w?.season_key ?? "?"} → pending 정규 ${v.reg} · 변동 ${v.irr}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
