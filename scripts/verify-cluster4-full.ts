/**
 * Cluster4 전체 데이터 흐름 검증.
 * 1) weekly-growth DTO 전체 출력
 * 2) cluster4 bundle의 seasons/weeks 출력
 * 3) 활동 데이터 확인
 * 4) Resume Card에 필요한 값 식별
 *
 * npx tsx --env-file=.env.local scripts/verify-cluster4-full.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

// ─── helpers ───
type Row = Record<string, unknown>;

async function pickTestUsers(): Promise<{ userId: string; org: string; name: string }[]> {
  const { data } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug,growth_status")
    .not("organization_slug", "is", null)
    .not("growth_status", "is", null)
    .order("created_at", { ascending: false })
    .limit(30);
  if (!data) return [];
  const rows = data as { user_id: string; display_name: string | null; organization_slug: string; growth_status: string }[];
  // 다양한 상태 포함하도록
  const picked: typeof rows = [];
  const seenStatus = new Set<string>();
  for (const r of rows) {
    if (!seenStatus.has(r.growth_status)) {
      picked.push(r);
      seenStatus.add(r.growth_status);
    }
    if (picked.length >= 3) break;
  }
  if (picked.length === 0 && rows.length > 0) picked.push(rows[0]);
  return picked.map(r => ({ userId: r.user_id, org: r.organization_slug, name: r.display_name ?? r.user_id.slice(0, 8) }));
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 1: Cluster4 weekly-growth DTO 시뮬레이션
// ═══════════════════════════════════════════════════════════════════════
async function verifyWeeklyGrowth(userId: string, label: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`[${label}] weekly-growth DTO`);
  console.log("═".repeat(70));

  // --- currentWeekInfo ---
  // (calendar-based, same for all users)

  // --- growthSummary ---
  const { data: uwsAll } = await sb
    .from("user_week_statuses")
    .select("year,week_number,week_start_date,status,season_key")
    .eq("user_id", userId)
    .order("year", { ascending: false })
    .order("week_number", { ascending: false });

  const uws = (uwsAll ?? []) as { year: number; week_number: number; week_start_date: string; status: string; season_key: string | null }[];
  console.log(`  총 주차: ${uws.length}개`);

  if (uws.length === 0) {
    console.log("  (주차 데이터 없음)");
    return;
  }

  // status 분포
  const statusCounts: Record<string, number> = {};
  for (const w of uws) {
    statusCounts[w.status] = (statusCounts[w.status] ?? 0) + 1;
  }
  console.log("  상태 분포:", JSON.stringify(statusCounts));

  // --- weeklyCards (최근 5개) ---
  const recentUws = uws.slice(0, 5);
  const dates = recentUws.map(r => r.week_start_date);

  // weeks JOIN
  const { data: weeksData } = await sb
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name")
    .in("start_date", dates);

  const weeksByDate = new Map<string, Row>();
  for (const w of (weeksData ?? []) as Row[]) {
    weeksByDate.set(w.start_date as string, w);
  }

  // season_definitions
  const seasonKeys = [...new Set(recentUws.map(r => r.season_key).filter(Boolean) as string[])];
  const { data: sdData } = await sb
    .from("season_definitions")
    .select("season_key,season_label,year")
    .in("season_key", seasonKeys);
  const sdMap = new Map<string, { season_label: string; year: number }>();
  for (const sd of (sdData ?? []) as { season_key: string; season_label: string; year: number }[]) {
    sdMap.set(sd.season_key, sd);
  }

  // points
  const { data: ptsData } = await sb
    .from("user_weekly_points")
    .select("year,week_number,points,advantages,penalty")
    .eq("user_id", userId);
  const ptsMap = new Map<string, { points: number; advantages: number; penalty: number }>();
  for (const p of (ptsData ?? []) as { year: number; week_number: number; points: number; advantages: number; penalty: number }[]) {
    ptsMap.set(`${p.year}-${p.week_number}`, p);
  }

  // reputation count per week_card_id
  const weekCardIds = [...weeksByDate.values()].map(w => w.id as string);
  const repMap = new Map<string, number>();
  if (weekCardIds.length > 0) {
    const { data: repData } = await sb
      .from("weekly_reputations")
      .select("week_card_id")
      .eq("target_user_id", userId)
      .in("week_card_id", weekCardIds);
    for (const r of (repData ?? []) as { week_card_id: string }[]) {
      repMap.set(r.week_card_id, (repMap.get(r.week_card_id) ?? 0) + 1);
    }
  }

  // colleague count
  const colMap = new Map<string, number>();
  if (weekCardIds.length > 0) {
    const { data: colData } = await sb
      .from("weekly_colleagues")
      .select("week_card_id")
      .eq("user_id", userId)
      .in("week_card_id", weekCardIds);
    for (const c of (colData ?? []) as { week_card_id: string }[]) {
      colMap.set(c.week_card_id, (colMap.get(c.week_card_id) ?? 0) + 1);
    }
  }

  // activity details per week
  const actMap = new Map<string, { info: number; ability: number; experience: number; career: number }>();
  if (weekCardIds.length > 0) {
    const { data: actData } = await sb
      .from("user_activity_details")
      .select("week_id,activity_type_id")
      .eq("user_id", userId)
      .in("week_id", weekCardIds);
    const { data: atData } = await sb.from("activity_types").select("id,cluster_id");
    const clusterMap = new Map<string, string>();
    for (const t of (atData ?? []) as { id: string; cluster_id: string | null }[]) {
      if (t.cluster_id) clusterMap.set(t.id, t.cluster_id);
    }
    for (const a of (actData ?? []) as { week_id: string; activity_type_id: string }[]) {
      if (!actMap.has(a.week_id)) actMap.set(a.week_id, { info: 0, ability: 0, experience: 0, career: 0 });
      const c = clusterMap.get(a.activity_type_id) ?? "";
      if (c === "practical_competency" || c.startsWith("comp-")) actMap.get(a.week_id)!.ability++;
      else if (c === "practical_experience" || c.startsWith("exp-")) actMap.get(a.week_id)!.experience++;
      else if (c === "practical_career" || c.startsWith("car-")) actMap.get(a.week_id)!.career++;
      else actMap.get(a.week_id)!.info++;
    }
  }

  // 누적 성공
  const sorted = [...uws].sort((a, b) => a.year - b.year || a.week_number - b.week_number);
  let cumSuccess = 0;
  const accMap = new Map<string, number>();
  for (const w of sorted) {
    if (w.status === "success") cumSuccess++;
    accMap.set(`${w.year}-${w.week_number}`, cumSuccess);
  }

  const STATUS_LABELS: Record<string, string> = {
    success: "성장(성공)", fail: "성장(실패)",
    personal_rest: "휴식(개인)", official_rest: "휴식(공식)",
  };

  console.log("\n  --- 최근 5주 카드 ---");
  for (const u of recentUws) {
    const wk = weeksByDate.get(u.week_start_date);
    const sd = u.season_key ? sdMap.get(u.season_key) : null;
    const weekId = wk?.id as string | undefined;
    const pts = ptsMap.get(`${u.year}-${u.week_number}`);
    const act = weekId ? actMap.get(weekId) : null;
    const isRest = u.status === "personal_rest" || u.status === "official_rest";
    const lineAvail = isRest ? { info: 0, ability: 0, experience: 0, career: 0 }
      : { info: 7, ability: 1, experience: 2, career: 2 };

    const card = {
      seasonKey: u.season_key,
      seasonName: sd?.season_label ?? u.season_key,
      seasonYear: sd?.year ?? u.year,
      weekNumber: (wk?.week_number as number | null) ?? u.week_number,
      startDate: (wk?.start_date as string | null) ?? u.week_start_date,
      endDate: wk?.end_date ?? null,
      resultStatus: u.status,
      resultLabel: STATUS_LABELS[u.status] ?? u.status,
      is_official_rest: wk?.is_official_rest ?? null,
      holiday_name: wk?.holiday_name ?? null,
      accumulatedApproved: accMap.get(`${u.year}-${u.week_number}`) ?? 0,
      points: pts?.points ?? 0,
      advantages: pts?.advantages ?? 0,
      penalty: pts?.penalty ?? 0,
      reputationCount: weekId ? (repMap.get(weekId) ?? 0) : 0,
      colleagueCount: weekId ? (colMap.get(weekId) ?? 0) : 0,
      lineBreakdown: {
        info: { completed: act?.info ?? 0, available: lineAvail.info },
        ability: { completed: act?.ability ?? 0, available: lineAvail.ability },
        experience: { completed: act?.experience ?? 0, available: lineAvail.experience },
        career: { completed: act?.career ?? 0, available: lineAvail.career },
      },
    };
    console.log(`\n    [${card.seasonName} W${card.weekNumber}] ${card.resultLabel}`);
    console.log(`      기간: ${card.startDate} ~ ${card.endDate}`);
    console.log(`      공식휴식: ${card.is_official_rest}  명절: ${card.holiday_name ?? "-"}`);
    console.log(`      누적성공: ${card.accumulatedApproved}  포인트: ${card.points}/${card.advantages}/${card.penalty}`);
    console.log(`      평판: ${card.reputationCount}  동료: ${card.colleagueCount}`);
    console.log(`      라인: info=${act?.info ?? 0}/${lineAvail.info} ability=${act?.ability ?? 0}/${lineAvail.ability} exp=${act?.experience ?? 0}/${lineAvail.experience} career=${act?.career ?? 0}/${lineAvail.career}`);
  }

  return { uws, statusCounts, weeksByDate, actMap, ptsMap };
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 2: Cluster4 bundle 검증 (seasons/weeks)
// ═══════════════════════════════════════════════════════════════════════
async function verifyBundle(userId: string, label: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`[${label}] Cluster4 bundle — seasons + weeks`);
  console.log("═".repeat(70));

  const { data: sd } = await sb.from("season_definitions").select("*").order("start_date", { ascending: false }).limit(3);
  console.log("\n  season_definitions (최근 3개):");
  for (const s of (sd ?? []) as Row[]) {
    console.log(`    ${s.season_key}: ${s.season_label} (year=${s.year}, ${s.start_date} ~ ${s.end_date})`);
  }

  const { data: wk } = await sb.from("weeks")
    .select("id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name,iso_year,iso_week")
    .not("season_key", "is", null)
    .order("start_date", { ascending: false })
    .limit(5);

  console.log("\n  weeks (최근 5개):");
  for (const w of (wk ?? []) as Row[]) {
    const rest = w.is_official_rest ? `✓ 공식휴식(${w.holiday_name ?? "캘린더"})` : "";
    console.log(`    ${w.season_key} W${w.week_number}: ${w.start_date} ~ ${w.end_date} [ISO ${w.iso_year}-W${w.iso_week}] ${rest}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 3: Resume Card에 필요한 값 식별
// ═══════════════════════════════════════════════════════════════════════
async function identifyResumeCardValues(userId: string, label: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`[${label}] Resume Card 필요 값 — Cluster4 데이터에서 추출`);
  console.log("═".repeat(70));

  // 전체 주차
  const { data: uwsAll } = await sb
    .from("user_week_statuses")
    .select("year,week_number,week_start_date,status")
    .eq("user_id", userId);
  const uws = (uwsAll ?? []) as { year: number; week_number: number; week_start_date: string; status: string }[];

  const totalWeeks = uws.length;
  const successWeeks = uws.filter(w => w.status === "success").length;
  const failWeeks = uws.filter(w => w.status === "fail").length;
  const personalRest = uws.filter(w => w.status === "personal_rest").length;
  const officialRest = uws.filter(w => w.status === "official_rest").length;
  const growableWeeks = totalWeeks - officialRest; // 성장 가능 주차

  // 활동 완료율 p/r = 성공 주차 / 성장 가능 주차
  const completionRate = growableWeeks > 0 ? (successWeeks / growableWeeks * 100).toFixed(1) : "0.0";

  console.log(`\n  활동 완료율 p/r = ${successWeeks}/${growableWeeks} = ${completionRate}%`);
  console.log(`    (성공=${successWeeks}, 실패=${failWeeks}, 개인휴식=${personalRest}, 공식휴식=${officialRest}, 총=${totalWeeks})`);

  // 주차별 활동 라인 누적
  const weekDates = uws.filter(w => w.status === "success").map(w => w.week_start_date);
  const { data: weeksData } = await sb
    .from("weeks")
    .select("id,start_date")
    .in("start_date", weekDates);
  const weekIdsByDate = new Map<string, string>();
  for (const w of (weeksData ?? []) as { id: string; start_date: string }[]) {
    weekIdsByDate.set(w.start_date, w.id);
  }
  const weekIds = [...weekIdsByDate.values()];

  let infoTotal = 0, abilityTotal = 0, expTotal = 0, careerTotal = 0;
  if (weekIds.length > 0) {
    const { data: actData } = await sb
      .from("user_activity_details")
      .select("week_id,activity_type_id")
      .eq("user_id", userId)
      .in("week_id", weekIds);

    const { data: atData } = await sb.from("activity_types").select("id,cluster_id");
    const clusterMap = new Map<string, string>();
    for (const t of (atData ?? []) as { id: string; cluster_id: string | null }[]) {
      if (t.cluster_id) clusterMap.set(t.id, t.cluster_id);
    }

    for (const a of (actData ?? []) as { week_id: string; activity_type_id: string }[]) {
      const c = clusterMap.get(a.activity_type_id) ?? "";
      if (c === "practical_competency" || c.startsWith("comp-")) abilityTotal++;
      else if (c === "practical_experience" || c.startsWith("exp-")) expTotal++;
      else if (c === "practical_career" || c.startsWith("car-")) careerTotal++;
      else infoTotal++;
    }
  }

  // 라인별 누적 완료율
  const infoMax = successWeeks * 7;
  const abilityMax = successWeeks * 1;
  const expMax = successWeeks * 2;
  const careerMax = successWeeks * 2;

  console.log(`\n  실무 정보 습득: ${infoTotal}/${infoMax} (${infoMax > 0 ? (infoTotal / infoMax * 100).toFixed(1) : 0}%)`);
  console.log(`  실무 역량 성장: ${abilityTotal}/${abilityMax} (${abilityMax > 0 ? (abilityTotal / abilityMax * 100).toFixed(1) : 0}%)`);
  console.log(`  실무 경험 축적: ${expTotal}/${expMax} (${expMax > 0 ? (expTotal / expMax * 100).toFixed(1) : 0}%)`);
  console.log(`  실무 경력 누적: ${careerTotal}/${careerMax} (${careerMax > 0 ? (careerTotal / careerMax * 100).toFixed(1) : 0}%)`);

  return {
    completionRate: parseFloat(completionRate),
    successWeeks,
    growableWeeks,
    lines: { info: infoTotal, ability: abilityTotal, experience: expTotal, career: careerTotal },
    lineMax: { info: infoMax, ability: abilityMax, experience: expMax, career: careerMax },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 4: 기존 Resume Card 타입/API 확인
// ═══════════════════════════════════════════════════════════════════════
async function checkExistingResumeApi() {
  console.log(`\n${"═".repeat(70)}`);
  console.log("Resume Card API/타입 현황");
  console.log("═".repeat(70));
  console.log("  (코드 레벨 분석 — 스크립트에서는 파일 시스템 접근 불가)");
  console.log("  lib/cluster1ResumeData.ts, lib/cluster1ResumeTypes.ts 확인 필요");
}

// ═══════════════════════════════════════════════════════════════════════
async function main() {
  console.log("Cluster4 → Resume Card 연결 검증\n");

  const users = await pickTestUsers();
  if (users.length === 0) {
    console.log("테스트 사용자 없음");
    return;
  }

  // 대표 사용자 1명으로 전체 검증
  const u = users[0];
  const label = `${u.name} (${u.org})`;
  console.log(`대표 사용자: ${label} [${u.userId}]`);

  await verifyBundle(u.userId, label);
  await verifyWeeklyGrowth(u.userId, label);
  const resumeValues = await identifyResumeCardValues(u.userId, label);

  console.log(`\n${"═".repeat(70)}`);
  console.log("SUMMARY: Resume Card에 필요한 값 → Cluster4 DB에서의 출처");
  console.log("═".repeat(70));
  console.log(`
  ┌─────────────────────┬──────────────────────────────────────┐
  │ Resume Card 필드     │ Cluster4 DB 출처                     │
  ├─────────────────────┼──────────────────────────────────────┤
  │ 활동 완료율 p/r      │ user_week_statuses.status 집계       │
  │                     │ success / (total - official_rest)     │
  │                     │ = ${resumeValues.successWeeks}/${resumeValues.growableWeeks} = ${resumeValues.completionRate}%              │
  ├─────────────────────┼──────────────────────────────────────┤
  │ 실무 정보 습득       │ user_activity_details (work_info)    │
  │                     │ ${resumeValues.lines.info}/${resumeValues.lineMax.info} lines                         │
  ├─────────────────────┼──────────────────────────────────────┤
  │ 실무 역량 성장       │ user_activity_details (work_ability) │
  │                     │ ${resumeValues.lines.ability}/${resumeValues.lineMax.ability} lines                          │
  ├─────────────────────┼──────────────────────────────────────┤
  │ 실무 경험 축적       │ user_activity_details (work_exp)     │
  │                     │ ${resumeValues.lines.experience}/${resumeValues.lineMax.experience} lines                          │
  ├─────────────────────┼──────────────────────────────────────┤
  │ 실무 경력 누적       │ user_activity_details (work_career)  │
  │                     │ ${resumeValues.lines.career}/${resumeValues.lineMax.career} lines                          │
  └─────────────────────┴──────────────────────────────────────┘
  `);

  await checkExistingResumeApi();
}

main().catch(console.error);
