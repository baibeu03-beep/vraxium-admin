// 4허브 라인 개설 매니저가 POST 직전에 console.log 하는 payload 를 재현한다.
// 어드민 UI 인증 없이도 페이로드 형상이 올바른지 (week_id 가 UUID 인지) 검증한다.
//
// 사용: node --env-file=.env.local scripts/verify-line-open-payloads.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(url, key, { auth: { persistSession: false } });

const DAY_MS = 86_400_000;

const SEASON_KO_BY_KEY = {
  "winter": "겨울",
  "spring": "봄",
  "summer": "여름",
  "fall": "가을",
};

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

function buildWeekOption(row, isCurrent) {
  const seasonName = `${SEASON_KO_BY_KEY[row.season_key?.split("-")?.[1]] ?? row.season_key} 시즌`;
  const year = Number(row.season_key?.split("-")?.[0]) || new Date(row.start_date).getUTCFullYear();
  const label = `${year}년도 ${seasonName} ${row.week_number}w`;
  const window = deriveSubmissionWindow(row.start_date);
  const isOfficialRest = !!row.is_official_rest;
  return {
    id: row.id,
    label,
    seasonKey: row.season_key,
    seasonName,
    year,
    weekNumber: row.week_number,
    startDate: row.start_date,
    endDate: row.end_date,
    isOfficialRest,
    canOpen: !isOfficialRest,
    isCurrent,
    submissionOpensAt: isOfficialRest ? null : window.submissionOpensAt,
    submissionClosesAt: isOfficialRest ? null : window.submissionClosesAt,
  };
}

async function loadWeeksOptions() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("weeks")
    .select("id,start_date,end_date,iso_year,iso_week,is_official_rest,season_key,week_number")
    .lte("start_date", today)
    .order("start_date", { ascending: false })
    .limit(3);
  if (error) throw new Error(`weeks: ${error.message}`);
  return (data ?? []).map((row, idx) => buildWeekOption(row, idx === 0));
}

async function pickProfileUser() {
  const { data, error } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .not("organization_slug", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`user: ${error.message}`);
  return data?.[0];
}

async function pickActivityType() {
  const { data } = await sb
    .from("activity_types")
    .select("id,name")
    .eq("cluster_id", "practical_info")
    .eq("is_active", true)
    .limit(1);
  return data?.[0];
}

async function pickExperienceMaster() {
  const { data } = await sb
    .from("cluster4_experience_line_masters")
    .select("id,line_code,line_name,main_title")
    .eq("is_active", true)
    .limit(1);
  return data?.[0];
}

async function pickCompetencyMaster() {
  const { data } = await sb
    .from("cluster4_competency_line_masters")
    .select("id,line_code,line_name,main_title")
    .eq("is_active", true)
    .limit(1);
  return data?.[0];
}

async function pickCareerProject() {
  const { data } = await sb
    .from("career_projects")
    .select("id,line_code,line_name,default_main_title")
    .not("line_code", "is", null)
    .limit(1);
  return data?.[0];
}

function sectionHeader(title) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(title);
  console.log("═".repeat(70));
}

async function main() {
  sectionHeader("weeks-options (simulated)");
  const opts = await loadWeeksOptions();
  for (const o of opts) console.log(JSON.stringify(o));

  const weekN = opts[0];
  const weekPrev = opts[1];

  const user = await pickProfileUser();
  const userId = user?.user_id;
  console.log("\nfixed sample crew:", userId, user?.display_name);

  // ── INFO ──
  sectionHeader("INFO — payload for N-1 line opening (=== /api/admin/cluster4/info-lines)");
  const actType = await pickActivityType();
  const infoBody = {
    activity_type_id: actType?.id,
    main_title: "test info line",
    output_link_1: "https://example.com",
    output_link_2: null,
    output_images: [],
    target_user_ids: [userId],
    week_id: weekPrev?.id,
    submission_opens_at: weekPrev?.submissionOpensAt,
    submission_closes_at: weekPrev?.submissionClosesAt,
  };
  console.log("[info line open payload]", JSON.stringify({
    selectedWeekId: weekPrev?.id,
    selectedWeekOption: weekPrev,
    body: infoBody,
  }, null, 2));
  console.log("→ POST /api/admin/cluster4/info-lines (week_id is UUID:", isUuid(infoBody.week_id), ")");

  // ── COMPETENCY ──
  sectionHeader("COMPETENCY — payload for N-1 line opening (=== /api/admin/cluster4/competency-lines)");
  const cMaster = await pickCompetencyMaster();
  const competencyBody = {
    competency_line_master_id: cMaster?.id,
    output_link_1: "https://example.com",
    output_link_2: null,
    output_images: [],
    target_user_ids: [userId],
    week_id: weekPrev?.id,
    submission_opens_at: weekPrev?.submissionOpensAt,
    submission_closes_at: weekPrev?.submissionClosesAt,
  };
  console.log("[competency line open payload]", JSON.stringify({
    selectedWeekId: weekPrev?.id,
    selectedWeekOption: weekPrev,
    body: competencyBody,
  }, null, 2));
  console.log("→ POST /api/admin/cluster4/competency-lines (week_id is UUID:", isUuid(competencyBody.week_id), ")");

  // ── EXPERIENCE (draft creation) ──
  sectionHeader("EXPERIENCE — payload for N-1 draft create (=== /api/admin/cluster4/experience-drafts)");
  const eMaster = await pickExperienceMaster();
  const experienceBody = {
    week_id: weekPrev?.id,
    organization_slug: user?.organization_slug ?? "oranke",
    team_id: null,
    part_name: null,
    target_user_id: userId,
    experience_line_master_id: eMaster?.id,
    line_code: eMaster?.line_code,
    main_title: eMaster?.main_title ?? eMaster?.line_name ?? "experience",
    output_link_1: "https://example.com",
    output_link_2: null,
    output_images: [],
    rating: 4,
    memo: null,
    input_status: "draft",
  };
  console.log("[experience draft create payload]", JSON.stringify({
    selectedWeekId: weekPrev?.id,
    selectedWeekOption: weekPrev,
    body: experienceBody,
  }, null, 2));
  console.log("→ POST /api/admin/cluster4/experience-drafts (week_id is UUID:", isUuid(experienceBody.week_id), ")");

  // ── CAREER ──
  sectionHeader("CAREER — payload for N-1 line opening (=== /api/admin/cluster4/career-lines)");
  const project = await pickCareerProject();
  const careerBody = {
    career_project_id: project?.id,
    main_title: project?.default_main_title ?? project?.line_name ?? "career",
    output_link_1: "https://example.com",
    output_link_2: null,
    output_images: [],
    target_user_ids: [userId],
    week_id: weekPrev?.id,
    submission_opens_at: weekPrev?.submissionOpensAt,
    submission_closes_at: weekPrev?.submissionClosesAt,
  };
  console.log("[career line open payload]", JSON.stringify({
    selectedWeekId: weekPrev?.id,
    selectedWeekOption: weekPrev,
    body: careerBody,
  }, null, 2));
  console.log("→ POST /api/admin/cluster4/career-lines (week_id is UUID:", isUuid(careerBody.week_id), ")");

  // ── Summary ──
  sectionHeader("summary — N (current) vs N-1");
  console.log("N    :", weekN ? { id: weekN.id, label: weekN.label } : "none");
  console.log("N-1  :", weekPrev ? { id: weekPrev.id, label: weekPrev.label } : "none");
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
