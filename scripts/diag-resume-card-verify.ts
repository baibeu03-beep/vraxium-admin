/**
 * Resume Card 실데이터 검증 — 진짜 direct function(getCluster1Resume) 호출 +
 * 고객 /api/profile completionRate 공식 재현(weekly_activities + activity_records).
 *
 *   npx tsx --env-file=.env.local scripts/diag-resume-card-verify.ts
 */
import { createClient } from "@supabase/supabase-js";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// 고객 /api/profile route.ts:1448-1480 completionRate 공식 1:1 재현.
async function customerCompletionRate(userId: string): Promise<{
  rate: number | null;
  totalP: number;
  totalR: number;
  growthStartDate: string | null;
}> {
  const { data: profile } = await sb
    .from("user_profiles")
    .select("activity_started_at,onboarding_week_id")
    .eq("user_id", userId)
    .maybeSingle();

  // growthStartDate ≈ resolveGrowthStartWeek: activity_started_at 가 속한 주차 start_date.
  let growthStartDate: string | null = null;
  const actStart = profile?.activity_started_at
    ? String(profile.activity_started_at).split("T")[0]
    : null;
  if (actStart) {
    const { data: wk } = await sb
      .from("weeks")
      .select("start_date")
      .lte("start_date", actStart)
      .gte("end_date", actStart)
      .maybeSingle();
    growthStartDate = wk?.start_date ?? actStart;
  }

  if (!growthStartDate) return { rate: null, totalP: 0, totalR: 0, growthStartDate };

  // break 시즌 season_key 집합
  const { data: seasons } = await sb
    .from("season_definitions")
    .select("season_key,season_type");
  const breakSeasonIds = new Set(
    (seasons ?? [])
      .filter((s: any) => String(s.season_type ?? "").toLowerCase().includes("break"))
      .map((s: any) => s.season_key),
  );

  const { data: allWeeks } = await sb
    .from("weeks")
    .select("id,start_date,season_key");
  const validWeekIds = new Set(
    (allWeeks ?? [])
      .filter((w: any) => {
        if (w.start_date < growthStartDate!) return false;
        if (w.season_key && breakSeasonIds.has(w.season_key)) return false;
        return true;
      })
      .map((w: any) => w.id),
  );

  // P = weekly_activities(is_active) 전체(유저 무관) 중 validWeek
  const { data: wact } = await sb
    .from("weekly_activities")
    .select("week_id")
    .eq("is_active", true);
  const totalP = (wact ?? []).filter((w: any) => validWeekIds.has(w.week_id)).length;

  // R = 이 유저 activity_records.is_completed=true 중 validWeek
  const { data: arec } = await sb
    .from("activity_records")
    .select("week_id,is_completed")
    .eq("user_id", userId);
  const totalR = (arec ?? []).filter(
    (a: any) => a.is_completed && validWeekIds.has(a.week_id),
  ).length;

  const rate = totalP > 0 ? Math.min(100, Math.round((totalR / totalP) * 100)) : null;
  return { rate, totalP, totalR, growthStartDate };
}

async function main() {
  // cluster4 라인 데이터가 있는 유저 우선(스냅샷 테이블 기준), 없으면 이름 매칭.
  const { data: snap } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id");
  const snapUsers = [...new Set((snap ?? []).map((r: any) => r.user_id))].slice(0, 4);

  const targets: string[] = [...snapUsers];

  for (const name of ["신서윤", "안다현", "이유나"]) {
    const { data: p } = await sb
      .from("user_profiles")
      .select("user_id")
      .ilike("display_name", `%${name}%`)
      .maybeSingle();
    if (p?.user_id && !targets.includes(p.user_id)) targets.push(p.user_id);
  }

  for (const uid of targets.slice(0, 6)) {
    const { data: prof } = await sb
      .from("user_profiles")
      .select("display_name,organization_slug,growth_status")
      .eq("user_id", uid)
      .maybeSingle();
    console.log(`\n${"═".repeat(70)}`);
    console.log(
      `[${prof?.display_name ?? "?"}] org=${prof?.organization_slug} growth=${prof?.growth_status}`,
    );
    console.log(`user_id=${uid}`);
    console.log("═".repeat(70));

    // 1) REAL direct function (admin DTO)
    let dto: any = null;
    try {
      dto = await getCluster1Resume(uid);
    } catch (e) {
      console.log("  getCluster1Resume ERROR:", (e as Error).message);
    }
    if (dto) {
      const ac = dto.activityCompletion;
      const sr = dto.scheduleReliability;
      const ps = dto.practicalStats;
      console.log("  [ADMIN DTO  getCluster1Resume]");
      console.log(`    resumeStatus      : ${dto.resumeStatus.label} (dimmed=${dto.resumeStatus.isBadgeDimmed})`);
      console.log(`    scheduleReliability: rate=${sr.rate}%  a=${sr.physicalWeeks} b=${sr.preRestWeeks} c=${sr.unapprovedActiveWeeks} d=${sr.approvedActiveWeeks} e=${sr.officialRestWeeks}`);
      console.log(`    activityCompletion : rate=${ac.rate}%  분모(available)=${ac.availableActivities} 분자(completed)=${ac.completedActivities}`);
      console.log(`    practicalStats     : info=${ps.infoCount} exp=${ps.experienceCount} ability=${ps.abilityUnitCount} career=${ps.careerProjectCount}`);
      console.log(`    seasonRecords      : ${dto.seasonRecords.length}건`);
    }

    // 2) 고객 /api/profile completionRate 재현 (브라우저 표시값)
    const cust = await customerCompletionRate(uid);
    console.log("  [CUSTOMER /api/profile completionRate (브라우저)]");
    console.log(`    completionRate=${cust.rate}%  P(개설 weekly_activities)=${cust.totalP}  R(완료 activity_records)=${cust.totalR}  growthStart=${cust.growthStartDate}`);

    // 3) 비교
    if (dto) {
      const adminRate = dto.activityCompletion.rate;
      console.log("  [비교] 활동완료율");
      console.log(`    admin DTO  = ${adminRate}%  (cluster4 라인 target/success)`);
      console.log(`    customer   = ${cust.rate}%  (weekly_activities/activity_records)`);
      console.log(`    일치? ${adminRate === cust.rate ? "✅" : "❌ 불일치 — source/공식 자체가 다름"}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
