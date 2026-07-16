/**
 * 운영 실사용자 전체 uws 불일치 dry-run (READ-ONLY, 쓰기 없음).
 *   run: npx tsx --env-file=.env.local scripts/dryrun-realuser-uws-divergence.ts
 *
 * 스코프 = 재판정 대상(신정책 시행일 이후 · 공표된 비공식휴식 성장주차)의 uws(success/fail) 중
 *          테스트 유저(test_user_markers)를 제외한 실사용자.
 *   불일치 = predict(라이브 라인/포인트 판정, finalize 동일 엔진) ≠ 저장 uws.status (skip 제외).
 *   레거시(신정책 이전) 주차는 predict 가 skip(legacy_week) → 재판정 대상 아님(확정결과 보존).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { predictWeekStatusForUser } from "@/lib/crewWeekGrowthRejudge";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import { adminWeekStatusLabel, formatWeekFull } from "@/lib/adminCrewWeeklyResults";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

async function main() {
  const { data: mk } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const test = new Set(((mk ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));

  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,is_official_rest,result_published_at")
    .not("result_published_at", "is", null);
  const weeks = ((wk ?? []) as Array<{ id: string; start_date: string | null; is_official_rest: boolean | null }>)
    .filter((w) => w.start_date && w.start_date >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM && w.is_official_rest !== true);

  console.log(`재판정 스코프(≥${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}, 공표 성장주차): ${weeks.map((w) => w.start_date).join(", ") || "(없음)"}`);

  const orgCache = new Map<string, OrganizationSlug | null>();
  const orgOf = async (u: string) => {
    if (orgCache.has(u)) return orgCache.get(u)!;
    const { data } = await supabaseAdmin.from("user_profiles").select("organization_slug").eq("user_id", u).maybeSingle();
    const s = (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
    const org = s && isOrganizationSlug(s) ? s : null;
    orgCache.set(u, org);
    return org;
  };

  let scannedReal = 0;
  const diffs: Array<{ userId: string; name: string | null; weekId: string; weekLabel: string; cur: string; pred: string }> = [];

  for (const w of weeks) {
    // 실유저 uws 전량(페이징) — success/fail 만.
    let from = 0; const PAGE = 1000;
    const realRows: Array<{ user_id: string; status: string }> = [];
    for (;;) {
      const { data } = await supabaseAdmin
        .from("user_week_statuses")
        .select("user_id,status")
        .eq("week_start_date", w.start_date as string)
        .in("status", ["success", "fail"])
        .order("user_id")
        .range(from, from + PAGE - 1);
      const rows = (data ?? []) as Array<{ user_id: string; status: string }>;
      for (const r of rows) if (!test.has(r.user_id)) realRows.push(r);
      if (rows.length < PAGE) break; from += PAGE;
    }

    for (const r of realRows) {
      scannedReal++;
      const org = await orgOf(r.user_id);
      const pred = await predictWeekStatusForUser({ userId: r.user_id, weekId: w.id, organizationSlug: org });
      if (pred.skipped || !pred.targetStatus || pred.targetStatus === r.status) continue;
      const card = await resolveCrewWeekCard(r.user_id, w.id);
      diffs.push({
        userId: r.user_id,
        name: card.ok ? card.crew.displayName ?? null : null,
        weekId: w.id,
        weekLabel: card.ok ? (formatWeekFull(card.card.seasonKey, card.card.weekNumber) ?? card.card.weekLabel ?? "-") : "-",
        cur: r.status,
        pred: pred.targetStatus,
      });
    }
  }

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`실사용자 스캔 행수: ${scannedReal}`);
  console.log(`실사용자 불일치 건수: ${diffs.length}`);
  console.log("══════════════════════════════════════════════════════════════");
  for (const d of diffs) {
    console.log(`  • 사용자명 : ${d.name ?? "(이름없음)"}`);
    console.log(`    userId   : ${d.userId}`);
    console.log(`    주차명   : ${d.weekLabel}`);
    console.log(`    weekId   : ${d.weekId}`);
    console.log(`    현재값   : ${d.cur} (${adminWeekStatusLabel(d.cur)})`);
    console.log(`    예상값   : ${d.pred} (${adminWeekStatusLabel(d.pred)})`);
    console.log("");
  }
  if (diffs.length === 0) console.log("  ✅ 실사용자 불일치 0건 — 백필 대상 없음.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
