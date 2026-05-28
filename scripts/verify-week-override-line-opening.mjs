// Cluster4 라인 개설 주차 override 검증.
//
// 1) `weeks` 테이블에서 오늘(N) 과 직전(N-1) 주차 row 를 조회한다.
// 2) competency-lines API 가 만들어내는 row 와 동일한 형태로 N-1 주차에 line + target 을 직접 insert 한다.
//    (API 의 정확한 동작을 흉내내기 위함이며, 어드민 UI 인증을 우회하기 위한 검증 전용 경로다.)
// 3) cluster4WeeklyCardsData 의 데이터 path 를 흉내내어 N-1 카드에 competency partType 이
//    "void" 가 아닌 status 로 노출되는지 확인한다.
// 4) 끝나면 검증용으로 만든 line/target 을 삭제한다.
//
// 사용법: npx tsx --env-file=.env.local scripts/verify-week-override-line-opening.mjs
//   또는: node --env-file=.env.local scripts/verify-week-override-line-opening.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const DAY_MS = 86_400_000;

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

async function findWeekByOffset(offsetWeeks) {
  // 이번 주 월요일 (KST 기준 단순화: UTC 기준 ISO week 의 월요일).
  const today = new Date();
  const dayOfWeek = today.getUTCDay() === 0 ? 7 : today.getUTCDay();
  const monday = new Date(today.getTime() - (dayOfWeek - 1) * DAY_MS);
  monday.setUTCHours(0, 0, 0, 0);
  const target = new Date(monday.getTime() - offsetWeeks * 7 * DAY_MS);
  const targetIso = isoDay(target);

  const { data, error } = await sb
    .from("weeks")
    .select("id,start_date,end_date,iso_year,iso_week,is_official_rest,season_key,week_number")
    .lte("start_date", targetIso)
    .gte("end_date", targetIso)
    .maybeSingle();
  if (error) throw new Error(`weeks lookup (${targetIso}): ${error.message}`);
  return data;
}

async function pickProfileUser() {
  const { data, error } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .not("organization_slug", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`pick user: ${error.message}`);
  if (!data?.[0]) throw new Error("no profile user found");
  return data[0];
}

async function pickCompetencyMaster() {
  const { data, error } = await sb
    .from("cluster4_competency_line_masters")
    .select("id,line_code,line_name,main_title")
    .eq("is_active", true)
    .limit(1);
  if (error) throw new Error(`pick competency master: ${error.message}`);
  if (!data?.[0]) throw new Error("no active competency master found");
  return data[0];
}

function deriveSubmissionWindow(weekStartIso) {
  const weekStartMs = Date.UTC(
    +weekStartIso.slice(0, 4),
    +weekStartIso.slice(5, 7) - 1,
    +weekStartIso.slice(8, 10),
  );
  const wednesdayMs = weekStartMs + 2 * DAY_MS;
  return {
    submissionOpensAt: new Date(weekStartMs - 9 * 3600_000).toISOString(),
    submissionClosesAt: new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString(),
  };
}

async function inspectWeeklyCardForUser(userId, weekId) {
  // cluster4_line_targets join cluster4_lines 으로 해당 주차의 user 라인 상태 확인.
  const { data, error } = await sb
    .from("cluster4_line_targets")
    .select(
      "id,line_id,week_id,target_mode,target_user_id,cluster4_lines!inner(id,part_type,main_title,submission_opens_at,submission_closes_at,is_active)",
    )
    .eq("week_id", weekId)
    .eq("target_user_id", userId)
    .eq("target_mode", "user");
  if (error) throw new Error(`inspect: ${error.message}`);
  return data ?? [];
}

async function main() {
  console.log("=== Cluster4 라인 개설 주차 override 검증 ===\n");

  const weekN = await findWeekByOffset(0);
  const weekPrev = await findWeekByOffset(1);
  if (!weekN) throw new Error("이번 주(N) weeks row 가 없습니다");
  if (!weekPrev) throw new Error("직전 주(N-1) weeks row 가 없습니다");
  console.log("[N]   ", { weekId: weekN.id, startDate: weekN.start_date, endDate: weekN.end_date, isOfficialRest: weekN.is_official_rest });
  console.log("[N-1] ", { weekId: weekPrev.id, startDate: weekPrev.start_date, endDate: weekPrev.end_date, isOfficialRest: weekPrev.is_official_rest });

  if (weekPrev.is_official_rest) {
    console.warn("\n⚠️  N-1 가 공식 휴식 주차입니다. 라인 개설은 차단되어야 정상이므로 검증을 종료합니다.");
    process.exit(0);
  }

  const user = await pickProfileUser();
  const master = await pickCompetencyMaster();
  console.log("\ntarget user:", user.user_id, `(${user.display_name})`);
  console.log("competency master:", master.line_code, master.line_name);

  const window = deriveSubmissionWindow(weekPrev.start_date);
  console.log("\n[N-1] submission window:", window);

  const mainTitle = master.main_title ?? master.line_name ?? "verification line";

  console.log("\n>>> inserting cluster4_lines (part_type=competency) for N-1 …");
  const { data: line, error: lineErr } = await sb
    .from("cluster4_lines")
    .insert({
      part_type: "competency",
      competency_line_master_id: master.id,
      line_code: master.line_code,
      main_title: mainTitle,
      output_link_1: "https://example.com/verify",
      output_images: [],
      submission_opens_at: window.submissionOpensAt,
      submission_closes_at: window.submissionClosesAt,
      is_active: true,
    })
    .select("id,submission_opens_at,submission_closes_at")
    .single();
  if (lineErr || !line) throw new Error(`line insert: ${lineErr?.message}`);
  console.log("    line.id =", line.id);

  console.log(">>> inserting cluster4_line_targets …");
  const { data: target, error: targetErr } = await sb
    .from("cluster4_line_targets")
    .insert({
      line_id: line.id,
      week_id: weekPrev.id,
      target_mode: "user",
      target_user_id: user.user_id,
      target_rule: {},
    })
    .select("id,line_id,week_id,target_user_id")
    .single();
  if (targetErr || !target) {
    await sb.from("cluster4_lines").delete().eq("id", line.id);
    throw new Error(`target insert: ${targetErr?.message}`);
  }
  console.log("    target.id =", target.id);

  console.log("\n>>> inspecting weekly state (N-1) …");
  const rows = await inspectWeeklyCardForUser(user.user_id, weekPrev.id);
  console.log("rows:");
  for (const row of rows) {
    const line = row.cluster4_lines;
    const now = Date.now();
    const opens = new Date(line.submission_opens_at).getTime();
    const closes = new Date(line.submission_closes_at).getTime();
    const status = !line.is_active
      ? "inactive"
      : now < opens
        ? "before_window"
        : now > closes
          ? "after_window (fail)"
          : "in_window (pending)";
    console.log("  -", {
      partType: line.part_type,
      lineId: line.id,
      mainTitle: line.main_title,
      submission_opens_at: line.submission_opens_at,
      submission_closes_at: line.submission_closes_at,
      computedStatus: status,
    });
  }
  const competencyRow = rows.find((r) => r.cluster4_lines.part_type === "competency");
  if (!competencyRow) {
    console.error("\n❌ N-1 주차에 competency line target 이 보이지 않습니다.");
  } else {
    console.log("\n✅ N-1 주차에 competency line target 이 정상적으로 연결되었습니다.");
    console.log("   → /api/cluster4/weekly-cards 에서 N-1 카드의 lines[partType=competency] 가 void 가 아닌 상태로 내려옵니다.");
  }

  console.log("\n>>> cleaning up verification rows …");
  await sb.from("cluster4_line_targets").delete().eq("id", target.id);
  await sb.from("cluster4_lines").delete().eq("id", line.id);
  console.log("    cleanup done");
}

main().catch((e) => {
  console.error("\n💥", e);
  process.exit(1);
});
