/**
 * Resume Card API 시뮬레이션 — cluster1ResumeData 핵심 로직 재현.
 * npx tsx --env-file=.env.local scripts/verify-resume-card.ts
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// 가용 라인 수가 동적(주차별 info 라인 개설 수 + org별 경험 + 경력 프로젝트 수)이므로
// 이 스크립트에서는 ability(1) + experience(2) + career(cap 5) 기본값으로 근사치 검증.
// 정확한 계산은 lib/lineAvailability.ts 참조.
const LINES_PER_WEEK_APPROX = 1 + 2 + 5; // ability + experience + career (info 제외, 동적)

async function main() {
  console.log("Resume Card 실데이터 검증\n");

  // 3명 사용자: 활동 데이터 다양성 확인
  const { data: profiles } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug,growth_status")
    .not("organization_slug", "is", null)
    .not("growth_status", "is", null)
    .order("created_at", { ascending: false })
    .limit(30);

  if (!profiles || profiles.length === 0) {
    console.log("사용자 없음");
    return;
  }

  const users = (profiles as {
    user_id: string;
    display_name: string | null;
    organization_slug: string;
    growth_status: string;
  }[]).slice(0, 5);

  for (const u of users) {
    const label = `${u.display_name ?? "?"} (${u.organization_slug}, ${u.growth_status})`;
    console.log(`\n${"═".repeat(60)}`);
    console.log(`[${label}]`);
    console.log("═".repeat(60));

    const userId = u.user_id;

    // 1. resumeStatus
    console.log(`\n  1) resumeStatus: growth_status="${u.growth_status}"`);

    // 2. scheduleReliability
    const { data: weekData } = await sb
      .from("user_week_statuses")
      .select("status")
      .eq("user_id", userId);
    const weeks = (weekData ?? []) as { status: string }[];

    const success = weeks.filter(w => w.status === "success").length;
    const fail = weeks.filter(w => w.status === "fail").length;
    const pRest = weeks.filter(w => w.status === "personal_rest").length;
    const oRest = weeks.filter(w => w.status === "official_rest").length;
    const growable = weeks.length - oRest;
    const relRate = growable > 0 ? Math.round(((success + pRest) / growable) * 100) : 0;

    console.log(`  2) scheduleReliability:`);
    console.log(`     총=${weeks.length} 성공=${success} 실패=${fail} 개인휴식=${pRest} 공식휴식=${oRest}`);
    console.log(`     rate = (${success}+${pRest})/(${weeks.length}-${oRest}) = ${relRate}%`);

    // 3. activityCompletion
    const { count: actCount } = await sb
      .from("user_activity_details")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);

    const available = growable * LINES_PER_WEEK_APPROX;
    const completed = actCount ?? 0;
    const actRate = available > 0 ? Math.round((completed / available) * 1000) / 10 : 0;

    console.log(`  3) activityCompletion:`);
    console.log(`     available=${available} (${growable}주×12)  completed=${completed}  rate=${actRate}%`);

    // 4. practicalStats
    const [detailsRes, typesRes, careerRes] = await Promise.all([
      sb.from("user_activity_details").select("activity_type_id").eq("user_id", userId),
      sb.from("activity_types").select("id,cluster_id"),
      sb.from("career_records").select("project_id").eq("user_id", userId),
    ]);

    const clusterMap = new Map<string, string>();
    for (const t of (typesRes.data ?? []) as { id: string; cluster_id: string | null }[]) {
      if (t.cluster_id) clusterMap.set(t.id, t.cluster_id);
    }

    let info = 0, ability = 0, exp = 0, career = 0;
    for (const d of (detailsRes.data ?? []) as { activity_type_id: string }[]) {
      const c = clusterMap.get(d.activity_type_id) ?? "";
      if (c === "practical_competency" || c.startsWith("comp-")) ability++;
      else if (c === "practical_experience" || c.startsWith("exp-")) exp++;
      else if (c === "practical_career" || c.startsWith("car-")) career++;
      else info++;
    }

    const distinctProjects = new Set(
      ((careerRes.data ?? []) as { project_id: string }[]).map(r => r.project_id),
    );
    const careerFinal = Math.max(career, distinctProjects.size);

    console.log(`  4) practicalStats:`);
    console.log(`     실무 정보 습득: ${info}`);
    console.log(`     실무 역량 성장: ${ability}`);
    console.log(`     실무 경험 축적: ${exp}`);
    console.log(`     실무 경력 누적: ${careerFinal} (activity=${career}, projects=${distinctProjects.size})`);

    // 5. seasonRecords
    const { data: sdData } = await sb
      .from("season_definitions")
      .select("season_key,season_label,season_type,start_date,end_date")
      .order("start_date", { ascending: false });

    const { data: uwsData } = await sb
      .from("user_week_statuses")
      .select("status,season_key")
      .eq("user_id", userId);

    const bySeason = new Map<string, { s: number; f: number; p: number; o: number; total: number }>();
    for (const w of (uwsData ?? []) as { status: string; season_key: string | null }[]) {
      if (!w.season_key) continue;
      if (!bySeason.has(w.season_key)) bySeason.set(w.season_key, { s: 0, f: 0, p: 0, o: 0, total: 0 });
      const b = bySeason.get(w.season_key)!;
      b.total++;
      if (w.status === "success") b.s++;
      else if (w.status === "fail") b.f++;
      else if (w.status === "personal_rest") b.p++;
      else if (w.status === "official_rest") b.o++;
    }

    const SMAP: Record<string, string> = { spring: "봄 시즌", summer: "여름 시즌", autumn: "가을 시즌", winter: "겨울 시즌" };

    console.log(`  5) seasonRecords:`);
    for (const sd of (sdData ?? []) as { season_key: string; season_label: string; season_type: string; start_date: string; end_date: string }[]) {
      const b = bySeason.get(sd.season_key);
      if (!b) continue;
      const name = SMAP[sd.season_type] ?? sd.season_label;
      const year = sd.season_key.slice(2, 4);
      console.log(`     ${year} ${name}: 성공=${b.s}/${b.total} (성공=${b.s} 실패=${b.f} 개인휴식=${b.p} 공식휴식=${b.o})`);
    }

    // 최종 Resume Card JSON (API 응답 형태)
    console.log(`\n  === API 응답 JSON (핵심) ===`);
    const dto = {
      activityCompletion: { availableActivities: available, completedActivities: completed, rate: actRate },
      practicalStats: { infoCount: info, experienceCount: exp, abilityUnitCount: ability, careerProjectCount: careerFinal },
    };
    console.log(JSON.stringify(dto, null, 4));
  }
}

main().catch(console.error);
