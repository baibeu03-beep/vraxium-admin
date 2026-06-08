/**
 * encre/phalanx 테스터 60명 — uws vs 신(자기 org) read-time verdict mismatch 전수 조사 (read-only).
 *
 *   npx tsx --env-file=.env.local scripts/diag-owt-tester-mismatch-census.ts
 *
 * 분류 (B8류 정합 재작업 설계 입력):
 *   A-shift  : uws=success, 평점 ok, points ∈ [T_old, T_new) → points += (T_new−T_old) 로 케이스 보존
 *   B-shift  : uws=fail,    평점 ok, points ∈ [T_new, T_old) → points = max(0, T_new−(T_old−points)) 로 보존
 *   B-thr0   : uws=fail, 평점 ok, T_new=0 → 게이트 불실패 — 보존 불가 (uws flip 후보)
 *   anomaly  : uws=success 인데 구기준에서도 gate fail 등 — 전제 불일치 (수동 확인)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import {
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  fetchLegacyUnifiedExperienceByWeek,
  reduceLegacyUnifiedVerdict,
} from "@/lib/lineAvailability";
import { EXPERIENCE_RATING_FAIL_THRESHOLD } from "@/lib/cluster4Enhancement";
import type { OrganizationSlug } from "@/lib/organizations";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const OUT = "claudedocs/owt-tester-mismatch-census-20260607.json";

async function main() {
  // 대상 60명: enforced(checks_migrated=true) ∧ org ∈ {encre, phalanx} ∧ 테스터 마커
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("user_weekly_points")
      .select("user_id")
      .eq("checks_migrated", true)
      .order("id", { ascending: true })
      .range(from, from + 999);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  const { data: markers } = await sb
    .from("test_user_markers")
    .select("user_id")
    .order("user_id", { ascending: true })
    .range(0, 4999);
  const markerSet = new Set(((markers ?? []) as { user_id: string }[]).map((m) => m.user_id));
  const targets: Array<{ user_id: string; org: OrganizationSlug; name: string | null }> = [];
  for (const uid of ids) {
    const { data: p } = await sb
      .from("user_profiles")
      .select("organization_slug,display_name")
      .eq("user_id", uid)
      .maybeSingle();
    const org = (p as { organization_slug: string | null } | null)?.organization_slug;
    if ((org === "encre" || org === "phalanx") && markerSet.has(uid)) {
      targets.push({ user_id: uid, org, name: (p as { display_name: string | null } | null)?.display_name ?? null });
    }
  }
  console.log("대상 테스터:", targets.length, "(encre", targets.filter((t) => t.org === "encre").length, "/ phalanx", targets.filter((t) => t.org === "phalanx").length, ")");

  // 레거시 주차 + uws
  type WeekRow = { id: string; start_date: string | null; iso_year: number | null; iso_week: number | null; check_threshold: number | null; season_key: string | null; week_number: number | null };
  const weeks: WeekRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("weeks")
      .select("id,start_date,iso_year,iso_week,check_threshold,season_key,week_number")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    weeks.push(...((data ?? []) as WeekRow[]));
    if ((data ?? []).length < 1000) break;
  }
  const legacyWeeks = weeks.filter((w) => w.start_date && w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);
  const weekById = new Map(legacyWeeks.map((w) => [w.id, w]));
  const legacyIds = legacyWeeks.map((w) => w.id);

  const census = {
    aShift: [] as Array<Record<string, unknown>>,
    bShift: [] as Array<Record<string, unknown>>,
    bThr0: [] as Array<Record<string, unknown>>,
    anomaly: [] as Array<Record<string, unknown>>,
    alreadyAligned: 0,
    skippedNoUws: 0,
    skippedRestEtc: 0,
  };
  const now = Date.now();
  let done = 0;
  for (const t of targets) {
    const { data: uwsData } = await sb
      .from("user_week_statuses")
      .select("week_start_date,status")
      .eq("user_id", t.user_id)
      .order("week_start_date", { ascending: true })
      .range(0, 4999);
    const uwsByStart = new Map(
      ((uwsData ?? []) as { week_start_date: string; status: string }[]).map((r) => [r.week_start_date, r.status]),
    );
    const [oldStates, newStates] = await Promise.all([
      fetchLegacyUnifiedExperienceByWeek(t.user_id, legacyIds, now, { organizationSlug: null }),
      fetchLegacyUnifiedExperienceByWeek(t.user_id, legacyIds, now, { organizationSlug: t.org }),
    ]);
    for (const [weekId, ns] of newStates) {
      const os = oldStates.get(weekId);
      const w = weekById.get(weekId);
      if (!os || !w || !w.start_date) continue;
      const uws = uwsByStart.get(w.start_date);
      if (!uws) { census.skippedNoUws++; continue; }
      if (uws !== "success" && uws !== "fail") { census.skippedRestEtc++; continue; }
      if (!ns.checkDataMigrated) { census.alreadyAligned++; continue; } // 비강제 — 게이트 무관
      const tOld = os.checkThreshold;
      const tNew = ns.checkThreshold;
      const verdictNew = reduceLegacyUnifiedVerdict(ns).status;
      const ratingOk = !(ns.hasTarget && ns.rating != null && ns.rating <= EXPERIENCE_RATING_FAIL_THRESHOLD);
      const aligned = (uws === "success" && verdictNew !== "fail") || (uws === "fail" && verdictNew === "fail");
      if (aligned) { census.alreadyAligned++; continue; }
      const rec = {
        user: t.user_id, name: t.name, org: t.org,
        week: `${w.season_key} W${w.week_number} (${w.start_date})`,
        uws, verdictNew, tOld, tNew, points: ns.checkCount, rating: ns.rating,
      };
      if (!ratingOk) { census.anomaly.push({ ...rec, why: "평점 fail 인데 mismatch — 게이트 외 요인" }); continue; }
      if (uws === "success" && ns.checkCount >= tOld && ns.checkCount < tNew) census.aShift.push(rec);
      else if (uws === "fail" && ns.checkCount < tOld && ns.checkCount >= tNew && tNew > 0) census.bShift.push(rec);
      else if (uws === "fail" && tNew === 0) census.bThr0.push(rec);
      else census.anomaly.push({ ...rec, why: "분류 규칙 밖" });
    }
    done++;
    if (done % 20 === 0) console.log(`  …${done}/${targets.length}`);
  }

  const summary = {
    targets: targets.length,
    aShift: census.aShift.length,
    bShift: census.bShift.length,
    bThr0: census.bThr0.length,
    anomaly: census.anomaly.length,
    alreadyAligned: census.alreadyAligned,
    skippedNoUws: census.skippedNoUws,
    skippedRestEtc: census.skippedRestEtc,
  };
  writeFileSync(OUT, JSON.stringify({ summary, targets, ...census }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log("→", OUT);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
