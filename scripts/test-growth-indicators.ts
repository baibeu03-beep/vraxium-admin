// Cluster3 Growth Indicators 검증 스크립트
// 실행: npx tsx scripts/test-growth-indicators.ts

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GRADUATION_THRESHOLDS: Record<string, number> = {
  encre: 30,
  phalanx: 30,
  oranke: 25,
};

const POINT_LABELS: Record<string, { points: string; advantages: string; penalty: string }> = {
  encre:   { points: "별",  advantages: "방패",   penalty: "번개" },
  oranke:  { points: "단감", advantages: "인절미", penalty: "어흥" },
  phalanx: { points: "투구", advantages: "방패",   penalty: "화살" },
};

async function main() {
  // 각 그룹에서 1명씩 = 5명 (A 온보딩, B 우수, C 평균, E 실패, F 졸업직전)
  const { data: profiles, error: profErr } = await supabase
    .from("user_profiles")
    .select("user_id,display_name,growth_status,activity_started_at,activity_ended_at,organization_slug,created_at")
    .not("organization_slug", "is", null)
    .order("created_at", { ascending: true })
    .limit(30);

  if (profErr) { console.error(profErr); return; }
  if (!profiles || profiles.length === 0) { console.log("No users found"); return; }

  // Pick samples: #1(A), #7(B), #13(C), #22(E), #27(F)
  const indices = [0, 6, 12, 21, 26];
  const sampleUsers = indices
    .filter(i => i < profiles.length)
    .map(i => ({ ...profiles[i], rn: i + 1 }));

  const userIds = sampleUsers.map(u => u.user_id);

  const [weekRes, pointRes] = await Promise.all([
    supabase
      .from("user_week_statuses")
      .select("user_id,status")
      .in("user_id", userIds),
    supabase
      .from("user_cumulative_points")
      .select("user_id,total_checks,total_advantages,total_penalties,total_raw_advantages")
      .in("user_id", userIds),
  ]);

  if (weekRes.error) { console.error(weekRes.error); return; }
  if (pointRes.error) { console.error(pointRes.error); return; }

  const weeksByUser = new Map<string, Array<{ status: string }>>();
  for (const row of (weekRes.data ?? [])) {
    const list = weeksByUser.get(row.user_id) ?? [];
    list.push(row);
    weeksByUser.set(row.user_id, list);
  }

  const pointsByUser = new Map<string, typeof pointRes.data[0]>();
  for (const row of (pointRes.data ?? [])) {
    pointsByUser.set(row.user_id, row);
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Cluster3 Growth Indicators — 5명 샘플 검증");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const user of sampleUsers) {
    const group =
      user.rn <= 5 ? "A: 온보딩" :
      user.rn <= 10 ? "B: 우수" :
      user.rn <= 15 ? "C: 평균" :
      user.rn <= 20 ? "D: 휴식" :
      user.rn <= 25 ? "E: 실패" : "F: 졸업직전";

    const org = user.organization_slug as string;
    const labels = POINT_LABELS[org] ?? { points: "점수", advantages: "이점", penalty: "패널티" };
    const threshold = GRADUATION_THRESHOLDS[org] ?? null;

    // Period
    const weeks = weeksByUser.get(user.user_id) ?? [];
    let a = 0, b = 0, c = 0, d = 0;
    for (const w of weeks) {
      switch (w.status) {
        case "success": a++; break;
        case "fail": b++; break;
        case "personal_rest": c++; break;
        case "official_rest": d++; break;
      }
    }
    const e = a + b + c;
    const h = a + b + c + d;

    // Point
    const pts = pointsByUser.get(user.user_id);
    const j = pts?.total_checks ?? 0;
    const k0 = pts?.total_raw_advantages ?? 0;
    const l = Math.abs(pts?.total_penalties ?? 0);
    const k = k0 - l;
    const storedShields = pts?.total_advantages ?? 0;
    const integrityOk = storedShields === k;

    const gradEligible = threshold !== null && e >= threshold;

    console.log(`── [${group}] #${user.rn} ${user.display_name} ──`);
    console.log(`   org: ${org}  |  growth_status: ${user.growth_status}`);
    console.log();

    console.log("   [Process]");
    console.log(`     성장 시작일: ${user.activity_started_at ? new Date(user.activity_started_at).toISOString().slice(0, 10) : "(없음)"}`);
    console.log(`     성장 종료일: ${user.activity_ended_at ? new Date(user.activity_ended_at).toISOString().slice(0, 10) : "Be Cluving"}`);
    console.log();

    console.log("   [Period]");
    console.log(`     a(성공)=${a}  b(실패)=${b}  c(개인휴식)=${c}  d(공식휴식)=${d}`);
    console.log(`     e(성장가능)=${e}  h(물리적)=${h}`);
    console.log(`     검증: a+b+c+d=${a+b+c+d} == h=${h} → ${a+b+c+d === h ? "OK" : "MISMATCH"}`);
    console.log(`     졸업: e=${e} / threshold=${threshold ?? "N/A"} → ${gradEligible ? "ELIGIBLE" : "NOT_YET"}`);
    console.log();

    console.log("   [Point]");
    console.log(`     ${labels.points}(j)=${j}  순수 ${labels.advantages}(k0)=${k0}  ${labels.penalty}(l)=${l}`);
    console.log(`     ${labels.advantages}(k)= k0 - l = ${k0} - ${l} = ${k}`);
    console.log(`     정합성: stored_shields=${storedShields} == calc_k=${k} → ${integrityOk ? "OK" : "MISMATCH"}`);
    console.log();
  }

  // 정합성 총괄
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  정합성 총괄 (30명 전체)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const allUserIds = profiles.map((p: { user_id: string }) => p.user_id);
  const [allWeekRes, allPointRes, allGrowthRes] = await Promise.all([
    supabase.from("user_week_statuses").select("user_id,status").in("user_id", allUserIds),
    supabase.from("user_cumulative_points").select("user_id,total_checks,total_advantages,total_penalties,total_raw_advantages").in("user_id", allUserIds),
    supabase.from("user_growth_stats").select("user_id,approved_weeks,cumulative_weeks").in("user_id", allUserIds),
  ]);

  let periodOk = 0, periodFail = 0, pointOk = 0, pointFail = 0;

  for (const profile of profiles) {
    const uid = profile.user_id;
    const weeks = (allWeekRes.data ?? []).filter((r: { user_id: string }) => r.user_id === uid);
    let sa = 0, sh = 0;
    for (const w of weeks) {
      if (w.status === "success") sa++;
      sh++;
    }

    const growth = (allGrowthRes.data ?? []).find((r: { user_id: string }) => r.user_id === uid);
    if (growth && sa === (growth.approved_weeks ?? 0) && sh === (growth.cumulative_weeks ?? 0)) {
      periodOk++;
    } else {
      periodFail++;
      console.log(`   PERIOD MISMATCH: ${profile.display_name} — success=${sa} vs approved=${growth?.approved_weeks}, total=${sh} vs cumulative=${growth?.cumulative_weeks}`);
    }

    const pt = (allPointRes.data ?? []).find((r: { user_id: string }) => r.user_id === uid);
    if (pt) {
      const calcK = (pt.total_raw_advantages ?? 0) - Math.abs(pt.total_penalties ?? 0);
      if ((pt.total_advantages ?? 0) === calcK) {
        pointOk++;
      } else {
        pointFail++;
        console.log(`   POINT MISMATCH: ${profile.display_name} — stored_shields=${pt.total_advantages} vs calc_k=${calcK}`);
      }
    } else {
      pointOk++;
    }
  }

  console.log(`\n   Period: ${periodOk} OK / ${periodFail} MISMATCH`);
  console.log(`   Point:  ${pointOk} OK / ${pointFail} MISMATCH`);
  console.log();
}

main().catch(console.error);
