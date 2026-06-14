/**
 * diag-experience-open-not-visible.ts  (READ-ONLY · write 0 · snapshot 재계산 0)
 * "개설 완료 떴는데 고객 앱에 안 보임" 원인 진단.
 *
 * 실행: npx tsx --env-file=.env.local scripts/diag-experience-open-not-visible.ts [overallId?]
 *   인자 없으면 가장 최근 opened 팀 총괄을 자동 선택.
 *
 * ⚠ 라이브 HTTP /api/cluster4/weekly-cards 호출은 stale snapshot 을 lazy 재계산(=write)하므로
 *   금지. 대신 저장 snapshot 직접 read + getCluster4WeeklyCardsForProfileUser(순수 compute, 미저장)로
 *   "재계산하면 내려올지"를 write 없이 확인한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const argId = process.argv[2]?.trim() || null;

async function main() {
  // ── 0. 대상 개설(최근 opened 팀 총괄) ──
  let overall: { id: string; organization_slug: string; week_id: string; team_id: string; opened_at: string | null; status: string } | null = null;
  if (argId) {
    const { data } = await sb.from("cluster4_experience_team_overall").select("id,organization_slug,week_id,team_id,opened_at,status").eq("id", argId).maybeSingle();
    overall = data as any;
  } else {
    const { data } = await sb.from("cluster4_experience_team_overall").select("id,organization_slug,week_id,team_id,opened_at,status").eq("status", "opened").order("opened_at", { ascending: false }).limit(1).maybeSingle();
    overall = data as any;
  }
  if (!overall) { console.log("opened 팀 총괄 없음"); return; }
  const teamName = (await sb.from("cluster4_teams").select("team_name").eq("id", overall.team_id).maybeSingle()).data?.team_name ?? "?";
  const week = (await sb.from("weeks").select("id,week_number,start_date,end_date,season_key,is_official_rest").eq("id", overall.week_id).maybeSingle()).data as any;
  console.log(`\n=== 대상 개설 ===`);
  console.log(`overallId=${overall.id} org=${overall.organization_slug} team=${teamName}(${overall.team_id})`);
  console.log(`week=${week?.season_key} W${week?.week_number} ${week?.start_date}~${week?.end_date} (id=${overall.week_id}) status=${overall.status} opened_at=${overall.opened_at}`);

  // ── 1~4. 라인/타깃/유저 ──
  const { data: oLines } = await sb.from("cluster4_experience_team_overall_opened_lines").select("line_id,category").eq("overall_id", overall.id);
  const lineIds = (oLines ?? []).map((r: any) => r.line_id);
  const catByLine = new Map((oLines ?? []).map((r: any) => [r.line_id, r.category]));
  const { data: lineRows } = await sb.from("cluster4_lines").select("id,line_code,main_title,team_id,is_active,part_type,submission_opens_at,submission_closes_at,created_at").in("id", lineIds.length ? lineIds : ["x"]);
  const { data: tgtRows } = await sb.from("cluster4_line_targets").select("id,line_id,week_id,target_user_id,target_mode").in("line_id", lineIds.length ? lineIds : ["x"]);
  const tgts = (tgtRows ?? []) as any[];

  console.log(`\n=== [2] 생성 라인 ${lineIds.length}개 ===`);
  for (const l of (lineRows ?? []) as any[]) {
    const n = tgts.filter((t) => t.line_id === l.id).length;
    console.log(`  ${catByLine.get(l.id)} | ${l.line_code} | active=${l.is_active} team=${l.team_id} | targets=${n} | sub ${l.submission_opens_at?.slice(0,10)}~${l.submission_closes_at?.slice(0,10)}`);
  }

  console.log(`\n=== [3] 라인별 target_user_id ===`);
  for (const l of (lineRows ?? []) as any[]) {
    const us = tgts.filter((t) => t.line_id === l.id).map((t) => t.target_user_id);
    console.log(`  ${catByLine.get(l.id)}/${l.line_code} (${us.length}): ${us.join(", ")}`);
  }

  const uniqUsers = Array.from(new Set(tgts.map((t) => t.target_user_id)));
  console.log(`\n=== [1·4] 집계 ===`);
  console.log(`  cluster4_line_targets row 수 = ${tgts.length}  ← 메시지 "대상 N명" = 이 row 수(중복 유저 포함)`);
  console.log(`  unique target_user_id = ${uniqUsers.length}`);
  const weekIds = Array.from(new Set(tgts.map((t) => t.week_id)));
  console.log(`  타깃 week_id 종류 = ${weekIds.length} (${weekIds.join(",")}) — 개설 week=${overall.week_id} 일치=${weekIds.length === 1 && weekIds[0] === overall.week_id}`);

  // ── 5. evaluations ──
  const targetIds = tgts.map((t) => t.id);
  const { count: evalCount } = await sb.from("cluster4_experience_line_evaluations").select("*", { count: "exact", head: true }).in("line_target_id", targetIds.length ? targetIds : ["x"]);
  console.log(`\n=== [5] evaluations ===`);
  console.log(`  cluster4_experience_line_evaluations row 수 = ${evalCount} (line_target_id FK)`);

  // ── 6. 관리 라인 제외(일반) ──
  const mgmtLineIds = (lineRows ?? []).filter((l: any) => catByLine.get(l.id) === "management").map((l: any) => l.id);
  const nonMgmtLineIds = (lineRows ?? []).filter((l: any) => catByLine.get(l.id) !== "management").map((l: any) => l.id);
  const mgmtUsers = new Set(tgts.filter((t) => mgmtLineIds.includes(t.line_id)).map((t) => t.target_user_id));
  const nonMgmtUsers = new Set(tgts.filter((t) => nonMgmtLineIds.includes(t.line_id)).map((t) => t.target_user_id));
  const excludedFromMgmt = Array.from(nonMgmtUsers).filter((u) => !mgmtUsers.has(u));
  console.log(`\n=== [6] 관리 라인 제외 크루(=경고 후보) ===`);
  console.log(`  비관리 라인엔 있고 관리 라인엔 없는 유저 = ${excludedFromMgmt.length}명: ${excludedFromMgmt.join(", ")}`);
  // 이들의 등급(membership_level) 확인 — 일반인지.
  if (excludedFromMgmt.length) {
    const { data: mems } = await sb.from("user_memberships").select("user_id,membership_level,part_name,is_current").in("user_id", excludedFromMgmt);
    const { data: profs } = await sb.from("user_profiles").select("user_id,role,display_name").in("user_id", excludedFromMgmt);
    const roleBy = new Map((profs ?? []).map((p: any) => [p.user_id, p]));
    const memBy = new Map<string, any>();
    for (const m of (mems ?? []) as any[]) { const e = memBy.get(m.user_id); if (!e || (m.is_current && !e.is_current)) memBy.set(m.user_id, m); }
    for (const u of excludedFromMgmt) {
      const p = roleBy.get(u); const m = memBy.get(u);
      console.log(`    ${p?.display_name ?? u}: role=${p?.role ?? "-"} level=${m?.membership_level ?? "-"} part=${m?.part_name ?? "-"}`);
    }
  }

  // ── 7. 타깃 테스트유저 여부 ──
  const { data: markers } = await sb.from("test_user_markers").select("user_id").in("user_id", uniqUsers);
  const testSet = new Set((markers ?? []).map((m: any) => m.user_id));
  const realTargets = uniqUsers.filter((u) => !testSet.has(u));
  console.log(`\n=== [7] 타깃 테스트/실유저 ===`);
  console.log(`  test_user_markers 등재 = ${testSet.size}/${uniqUsers.length}, 실유저 = ${realTargets.length}`);
  if (realTargets.length) console.log(`  ⚠ 실유저 타깃: ${realTargets.join(", ")}`);

  // ── 8·9. snapshot 상태(stale/computed_at) ──
  const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,is_stale,computed_at,card_count,dto_version").in("user_id", uniqUsers);
  const snapBy = new Map((snaps ?? []).map((s: any) => [s.user_id, s]));
  let stale = 0, fresh = 0, missing = 0, preOpen = 0;
  for (const u of uniqUsers) {
    const s = snapBy.get(u);
    if (!s) { missing++; continue; }
    if (s.is_stale) stale++; else fresh++;
    if (overall.opened_at && s.computed_at && Date.parse(s.computed_at) < Date.parse(overall.opened_at)) preOpen++;
  }
  console.log(`\n=== [8·9] 타깃 snapshot 상태 ===`);
  console.log(`  행 있음=${uniqUsers.length - missing} (stale=${stale}, fresh=${fresh}), 행 없음(miss)=${missing}`);
  console.log(`  computed_at < opened_at (개설 전 계산 = 라인 미반영본) = ${preOpen}명`);
  console.log(`  → markStale 는 기존 행만 is_stale=true. 다음 고객 read 시 lazy 재계산되어 반영 예정.`);

  // ── 10·13·14. 저장본 vs 순수 compute(미저장) 한 명 표본 ──
  const sample = uniqUsers[0];
  if (sample) {
    console.log(`\n=== [10·13·14] 표본 유저 ${sample} — 저장 snapshot vs 재계산(read-only) ===`);
    const stored = snapBy.get(sample);
    const storedCards = (stored?.cards ?? null);
    // 순수 compute (미저장).
    let computed: any[] = [];
    try { computed = await getCluster4WeeklyCardsForProfileUser(sample); }
    catch (e) { console.log("  compute 실패:", e instanceof Error ? e.message : e); }
    const wkCard = computed.find((c: any) => c.weekId === overall.week_id) ?? null;
    const expLines = wkCard ? (wkCard.lines ?? []).filter((l: any) => l.partType === "experience") : [];
    console.log(`  재계산 카드 수=${computed.length}, 개설주차 카드 존재=${!!wkCard}`);
    if (wkCard) {
      console.log(`    개설주차 experience lineBreakdown: ${JSON.stringify(wkCard.lineBreakdown?.experience ?? null)}`);
      console.log(`    개설주차 experience 라인(개설반영): ${expLines.length}건 → ${JSON.stringify(expLines.map((l: any) => ({ num: l.numerator, den: l.denominator, rate: l.rate })))}`);
    }
    console.log(`  ※ 저장 snapshot 은 stale=${stored?.is_stale} (미반영본일 수 있음). 재계산 결과가 곧 고객 HTTP 응답.`);
  }

  console.log(`\n=== 결론 요약 ===`);
  console.log(`  DB 생성: 라인 ${lineIds.length} / 타깃 row ${tgts.length} / 평가 ${evalCount} / unique 유저 ${uniqUsers.length}`);
  console.log(`  타깃: 테스트유저 ${testSet.size} / 실유저 ${realTargets.length}`);
  console.log(`  snapshot 미반영(stale/preOpen/miss): stale=${stale} preOpen=${preOpen} miss=${missing}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
