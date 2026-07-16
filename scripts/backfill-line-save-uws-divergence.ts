/**
 * 라인 저장 §5.5 이전 stale uws 백필 스윕 (dry-run 기본 · --apply 시 실제 반영).
 *   dry-run : npx tsx --env-file=.env.local scripts/backfill-line-save-uws-divergence.ts
 *   apply   : npx tsx --env-file=.env.local scripts/backfill-line-save-uws-divergence.ts --apply
 *
 * 스코프 = 진단(diag-line-save-uws-divergence)과 동일: 테스트 유저 × 공표 성장주차.
 *   불일치 = predict(라이브 라인/포인트 판정) ≠ 저장된 user_week_statuses.status (skip 제외).
 *   수정 = recomputeDerivedAfterActMutation({userId,weekId}) — 라인 저장 §5.5 와 동일 체인
 *          (rejudgeWeekStatusForUser→snapshot→성장통계→품계). 새 판정 공식 없음.
 *   무손실 계약: predict 는 finalize 와 동일 엔진이라, 백필은 "라인 데이터가 말하는 값"으로만 수렴한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { predictWeekStatusForUser, recomputeDerivedAfterActMutation } from "@/lib/crewWeekGrowthRejudge";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import { adminWeekStatusLabel, formatWeekFull } from "@/lib/adminCrewWeeklyResults";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

const APPLY = process.argv.includes("--apply");

type Div = {
  userId: string;
  displayName: string | null;
  weekId: string;
  weekStart: string;
  weekLabel: string;
  current: string;
  predicted: string;
  org: OrganizationSlug | null;
};

async function collectDivergences(): Promise<Div[]> {
  const { data: mk } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const test = new Set(((mk ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,is_official_rest,result_published_at")
    .not("result_published_at", "is", null);
  const weeks = ((wk ?? []) as Array<{ id: string; start_date: string | null; is_official_rest: boolean | null }>)
    .filter((w) => w.start_date && w.start_date >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM && w.is_official_rest !== true);
  const orgCache = new Map<string, OrganizationSlug | null>();
  const orgOf = async (u: string) => {
    if (orgCache.has(u)) return orgCache.get(u)!;
    const { data } = await supabaseAdmin.from("user_profiles").select("organization_slug").eq("user_id", u).maybeSingle();
    const s = (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
    const org = s && isOrganizationSlug(s) ? s : null;
    orgCache.set(u, org);
    return org;
  };

  const out: Div[] = [];
  for (const w of weeks) {
    const { data: uwsRows } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,status")
      .eq("week_start_date", w.start_date as string)
      .in("status", ["success", "fail"]);
    const rows = ((uwsRows ?? []) as Array<{ user_id: string; status: string }>).filter((r) => test.has(r.user_id));
    for (const r of rows) {
      const org = await orgOf(r.user_id);
      const pred = await predictWeekStatusForUser({ userId: r.user_id, weekId: w.id, organizationSlug: org });
      if (pred.skipped || !pred.targetStatus || pred.targetStatus === r.status) continue;
      const card = await resolveCrewWeekCard(r.user_id, w.id);
      const displayName = card.ok ? card.crew.displayName ?? null : null;
      const weekLabel = card.ok ? (formatWeekFull(card.card.seasonKey, card.card.weekNumber) ?? card.card.weekLabel ?? "-") : "-";
      out.push({
        userId: r.user_id,
        displayName,
        weekId: w.id,
        weekStart: w.start_date as string,
        weekLabel,
        current: r.status,
        predicted: pred.targetStatus,
        org,
      });
    }
  }
  return out;
}

async function readSurfaces(userId: string, weekId: string, weekStart: string) {
  const { data: uws } = await supabaseAdmin.from("user_week_statuses").select("status").eq("week_start_date", weekStart).eq("user_id", userId).maybeSingle();
  const card = await resolveCrewWeekCard(userId, weekId);
  const { data: gs } = await supabaseAdmin.from("user_growth_stats").select("approved_weeks").eq("user_id", userId).maybeSingle();
  const { data: gr } = await supabaseAdmin.from("user_grade_stats").select("grade_label").eq("user_id", userId).maybeSingle();
  return {
    uws: (uws as { status: string } | null)?.status ?? null,
    card: card.ok ? card.card.userWeekStatus : null,
    approved: (gs as { approved_weeks: number } | null)?.approved_weeks ?? null,
    grade: (gr as { grade_label: string | null } | null)?.grade_label ?? null,
    rankingReadsStatus: (uws as { status: string } | null)?.status ?? null, // weekly-league 는 이 값을 라이브로 읽음
  };
}

async function main() {
  console.log(`모드: ${APPLY ? "APPLY (실제 백필)" : "DRY-RUN (읽기만)"}\n`);
  const divs = await collectDivergences();

  console.log("──────────────────────────────────────────────────────────────");
  console.log(`불일치(stale uws) 건수: ${divs.length}`);
  console.log("──────────────────────────────────────────────────────────────");
  for (const d of divs) {
    console.log(`  • 사용자명 : ${d.displayName ?? "(이름없음)"}`);
    console.log(`    userId   : ${d.userId}`);
    console.log(`    주차명   : ${d.weekLabel}  (start ${d.weekStart})`);
    console.log(`    weekId   : ${d.weekId}`);
    console.log(`    현재 uws : ${d.current} (${adminWeekStatusLabel(d.current)})`);
    console.log(`    재판정   : ${d.predicted} (${adminWeekStatusLabel(d.predicted)})`);
    console.log(`    변경사유 : 라인 강화 결과(라이브 판정)와 저장 uws 불일치 — §5.5 이전 라인 저장이 uws 미갱신`);
    console.log("");
  }

  if (!APPLY) {
    console.log("DRY-RUN 종료 — 실제 반영하려면 --apply 로 재실행하세요.");
    return;
  }
  if (divs.length === 0) {
    console.log("불일치 0건 — 백필할 항목 없음.");
    return;
  }

  console.log("APPLY 실행 — 불일치 건만 recomputeDerivedAfterActMutation(§5.5 동일 체인) 호출...\n");
  for (const d of divs) {
    const before = await readSurfaces(d.userId, d.weekId, d.weekStart);
    await recomputeDerivedAfterActMutation({ userId: d.userId, weekId: d.weekId, organizationSlug: d.org });
    const after = await readSurfaces(d.userId, d.weekId, d.weekStart);
    console.log(`  ✔ ${d.displayName ?? d.userId} / ${d.weekLabel}`);
    console.log(`     user_week_statuses : ${before.uws} → ${after.uws}`);
    console.log(`     weekly-card snapshot: ${before.card} → ${after.card}`);
    console.log(`     성장 성공 주차      : ${before.approved} → ${after.approved}`);
    console.log(`     품계                : ${before.grade} → ${after.grade}`);
    console.log(`     위클리 랭킹(uws 라이브 소비): ${before.rankingReadsStatus} → ${after.rankingReadsStatus}`);
    console.log("");
  }

  // 재검증 — 동일 스코프 재스캔.
  const remain = await collectDivergences();
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`백필 후 불일치 재검증: ${remain.length}건`);
  console.log("──────────────────────────────────────────────────────────────");
  if (remain.length > 0) {
    for (const d of remain) console.log(`  남음: ${d.displayName ?? d.userId} / ${d.weekLabel} : uws=${d.current} predict=${d.predicted}`);
  } else {
    console.log("  ✅ 불일치 0건 — 전 표면(uws/snapshot/성장주차/품계/위클리랭킹) 수렴 완료.");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
