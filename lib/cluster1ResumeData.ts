import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import type {
  Cluster1ResumeDto,
  ResumeStatus,
  ResumeStatusCode,
  ResumeStatusLabel,
  ScheduleReliability,
  ActivityCompletion,
  SeasonRecord,
  PracticalStats,
  PositionLabel,
} from "@/lib/cluster1ResumeTypes";

// ─────────────────────────────────────────────────────────────────────
// Status mapping: user_profiles.status → Resume badge
// ─────────────────────────────────────────────────────────────────────
const STATUS_MAP: Record<
  string,
  { status: ResumeStatusCode; label: ResumeStatusLabel }
> = {
  active: { status: "running", label: "Running" },
  graduated: { status: "complete", label: "Complete" },
  weekly_rest: { status: "on_rest", label: "On Rest" },
  seasonal_rest: { status: "recharging", label: "Recharging" },
  paused: { status: "next_challenge", label: "Next Challenge" },
  suspended: { status: "next_challenge", label: "Next Challenge" },
};

function resolveResumeStatus(profileStatus: string | null): ResumeStatus {
  const mapped = STATUS_MAP[profileStatus ?? ""] ?? {
    status: "next_challenge" as const,
    label: "Next Challenge" as const,
  };
  return {
    ...mapped,
    isBadgeDimmed: mapped.status !== "complete",
  };
}

// ─────────────────────────────────────────────────────────────────────
// Schedule Reliability computation
//   a = 가입 이후 물리적 주차, b = 사전 휴식 신청, c = 미인정 활동,
//   d = 인정 활동, e = 공식 휴식
//   rate = ((d + b) / (a - e)) * 100
// ─────────────────────────────────────────────────────────────────────
async function computeScheduleReliability(
  userId: string,
): Promise<ScheduleReliability> {
  const [weekRes, profileRes] = await Promise.all([
    supabaseAdmin
      .from("user_week_statuses")
      .select("status")
      .eq("user_id", userId),
    supabaseAdmin
      .from("user_profiles")
      .select("activity_started_at")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (weekRes.error || !weekRes.data || profileRes.error) {
    return dummyScheduleReliability();
  }

  const activityStart = profileRes.data?.activity_started_at as
    | string
    | null;
  if (!activityStart) return dummyScheduleReliability();

  const startDate = new Date(activityStart);
  const now = new Date();
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const physicalWeeks = Math.max(
    1,
    Math.floor((now.getTime() - startDate.getTime()) / msPerWeek),
  );

  const rows = weekRes.data as Array<{ status: string }>;
  let preRestWeeks = 0;
  let unapprovedActiveWeeks = 0;
  let approvedActiveWeeks = 0;
  let officialRestWeeks = 0;

  for (const row of rows) {
    switch (row.status) {
      case "success":
        approvedActiveWeeks++;
        break;
      case "fail":
        unapprovedActiveWeeks++;
        break;
      case "personal_rest":
        preRestWeeks++;
        break;
      case "official_rest":
        officialRestWeeks++;
        break;
    }
  }

  const denominator = physicalWeeks - officialRestWeeks;
  const rate =
    denominator > 0
      ? Math.round(((approvedActiveWeeks + preRestWeeks) / denominator) * 100)
      : 0;

  return {
    physicalWeeks,
    preRestWeeks,
    unapprovedActiveWeeks,
    approvedActiveWeeks,
    officialRestWeeks,
    rate,
  };
}

function dummyScheduleReliability(): ScheduleReliability {
  return {
    physicalWeeks: 35,
    preRestWeeks: 2,
    unapprovedActiveWeeks: 1,
    approvedActiveWeeks: 30,
    officialRestWeeks: 3,
    rate: 94,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Activity Completion — Cluster4 user_activity_details 기반
//   available = 성장 가능 주차 × 12 (info 7 + ability 1 + exp 2 + career 2)
//   completed = user_activity_details 총 row 수
// ─────────────────────────────────────────────────────────────────────
const LINES_PER_WEEK = 7 + 1 + 2 + 2; // info + ability + experience + career

async function computeActivityCompletion(
  userId: string,
): Promise<ActivityCompletion> {
  const [weekRes, actRes] = await Promise.all([
    supabaseAdmin
      .from("user_week_statuses")
      .select("status")
      .eq("user_id", userId),
    supabaseAdmin
      .from("user_activity_details")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId),
  ]);

  if (weekRes.error || !weekRes.data) {
    return { availableActivities: 0, completedActivities: 0, rate: 0 };
  }

  const growableWeeks = (weekRes.data as { status: string }[]).filter(
    (w) => w.status !== "official_rest",
  ).length;
  const availableActivities = growableWeeks * LINES_PER_WEEK;
  const completedActivities = actRes.count ?? 0;
  const rate =
    availableActivities > 0
      ? Math.round((completedActivities / availableActivities) * 1000) / 10
      : 0;

  return { availableActivities, completedActivities, rate };
}

// ─────────────────────────────────────────────────────────────────────
// Season Records — season_definitions + user_week_statuses
// ─────────────────────────────────────────────────────────────────────
const POSITION_RANK: Record<string, number> = {
  "운영진(클럽장)": 6,
  "운영진(앰배서더)": 5,
  "운영진(팀장)": 4,
  "심화(파트장)": 3,
  "심화(에이전트)": 2,
  "일반(정규)": 1,
};

const SEASON_LABEL_MAP: Record<string, string> = {
  spring: "봄 시즌",
  summer: "여름 시즌",
  autumn: "가을 시즌",
  winter: "겨울 시즌",
};

async function computeSeasonRecords(
  userId: string,
): Promise<SeasonRecord[]> {
  const [seasonRes, weekRes] = await Promise.all([
    supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,season_type,start_date,end_date")
      .order("start_date", { ascending: false }),
    supabaseAdmin
      .from("user_week_statuses")
      .select("year,week_number,status,season_key")
      .eq("user_id", userId),
  ]);

  if (seasonRes.error || !seasonRes.data || weekRes.error || !weekRes.data) {
    return dummySeasonRecords();
  }

  type SeasonDef = {
    season_key: string;
    season_label: string;
    season_type: string;
    start_date: string;
    end_date: string;
  };
  type WeekRow = {
    year: number;
    week_number: number;
    status: string;
    season_key: string | null;
  };

  const seasons = seasonRes.data as SeasonDef[];
  const weeks = weekRes.data as WeekRow[];

  if (seasons.length === 0) return dummySeasonRecords();

  const weeksBySeason = new Map<string, WeekRow[]>();
  for (const w of weeks) {
    const key = w.season_key;
    if (!key) continue;
    const arr = weeksBySeason.get(key) ?? [];
    arr.push(w);
    weeksBySeason.set(key, arr);
  }

  const membershipRes = await supabaseAdmin
    .from("user_memberships")
    .select("membership_level,created_at,updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  const records: SeasonRecord[] = [];

  for (const season of seasons) {
    const seasonWeeks = weeksBySeason.get(season.season_key);
    if (!seasonWeeks || seasonWeeks.length === 0) continue;

    const totalWeeks = seasonWeeks.length;
    const approvedWeeks = seasonWeeks.filter(
      (w) => w.status === "success",
    ).length;

    const endDate = new Date(season.end_date);
    const now = new Date();
    const twoWeeksAfterEnd = new Date(endDate);
    twoWeeksAfterEnd.setDate(twoWeeksAfterEnd.getDate() + 14);

    const isOngoing = now <= endDate;
    const isReviewPeriod = now > endDate && now <= twoWeeksAfterEnd;

    let progressStatus: SeasonRecord["progressStatus"];
    const hasRest = seasonWeeks.some((w) => w.status === "personal_rest");
    const hasFail = seasonWeeks.some((w) => w.status === "fail");

    if (isOngoing) {
      progressStatus = "진행 중";
    } else if (hasRest && !hasFail) {
      progressStatus = "통합 휴식";
    } else if (hasFail && approvedWeeks < totalWeeks / 2) {
      progressStatus = "활동 중단";
    } else {
      progressStatus = approvedWeeks >= totalWeeks - 1
        ? "정상 졸업"
        : "정상 완료";
    }

    const reviewStatus: SeasonRecord["reviewStatus"] =
      isOngoing || isReviewPeriod ? "검수 중" : "승인 완료";

    const yearStr = season.season_key.slice(2, 4);
    const seasonName =
      SEASON_LABEL_MAP[season.season_type] ?? season.season_label;

    const position = resolvePosition(membershipRes.data ?? []);

    records.push({
      year: yearStr,
      seasonName,
      position,
      progressStatus,
      approvedWeeks,
      totalWeeks,
      reviewStatus,
    });
  }

  return records.length > 0 ? records : dummySeasonRecords();
}

function resolvePosition(
  memberships: Array<Record<string, unknown>>,
): PositionLabel {
  if (!memberships || memberships.length === 0) return "일반(정규)";

  const level = memberships[0]?.membership_level as string | null;
  if (level && level in POSITION_RANK) return level as PositionLabel;
  return "일반(정규)";
}

function dummySeasonRecords(): SeasonRecord[] {
  return [
    {
      year: "25",
      seasonName: "여름 시즌",
      position: "심화(에이전트)",
      progressStatus: "진행 중",
      approvedWeeks: 7,
      totalWeeks: 8,
      reviewStatus: "검수 중",
    },
    {
      year: "25",
      seasonName: "봄 시즌",
      position: "일반(정규)",
      progressStatus: "정상 완료",
      approvedWeeks: 11,
      totalWeeks: 12,
      reviewStatus: "승인 완료",
    },
    {
      year: "24",
      seasonName: "겨울 시즌",
      position: "일반(정규)",
      progressStatus: "정상 졸업",
      approvedWeeks: 12,
      totalWeeks: 12,
      reviewStatus: "승인 완료",
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Practical Stats — Cluster4 user_activity_details + career_records
//   activity_types.cluster_id 기반 분류:
//     work_info: cluster_id 없음 또는 기타
//     work_ability: practical_competency / comp-*
//     work_exp: practical_experience / exp-*
//     work_career: practical_career / car-* 또는 career_records
// ─────────────────────────────────────────────────────────────────────
async function computePracticalStats(
  userId: string,
): Promise<PracticalStats> {
  const [detailsRes, typesRes, careerRes] = await Promise.all([
    supabaseAdmin
      .from("user_activity_details")
      .select("activity_type_id")
      .eq("user_id", userId),
    supabaseAdmin.from("activity_types").select("id,cluster_id"),
    supabaseAdmin
      .from("career_records")
      .select("project_id")
      .eq("user_id", userId),
  ]);

  const clusterMap = new Map<string, string>();
  if (typesRes.data) {
    for (const t of typesRes.data as { id: string; cluster_id: string | null }[]) {
      if (t.cluster_id) clusterMap.set(t.id, t.cluster_id);
    }
  }

  let infoCount = 0;
  let experienceCount = 0;
  let abilityUnitCount = 0;
  let careerActivityCount = 0;

  if (detailsRes.data) {
    for (const d of detailsRes.data as { activity_type_id: string }[]) {
      const c = clusterMap.get(d.activity_type_id) ?? "";
      if (c === "practical_competency" || c.startsWith("comp-"))
        abilityUnitCount++;
      else if (c === "practical_experience" || c.startsWith("exp-"))
        experienceCount++;
      else if (c === "practical_career" || c.startsWith("car-"))
        careerActivityCount++;
      else infoCount++;
    }
  }

  const distinctProjects = new Set(
    ((careerRes.data ?? []) as { project_id: string }[]).map(
      (r) => r.project_id,
    ),
  );
  const careerProjectCount = Math.max(careerActivityCount, distinctProjects.size);

  return { infoCount, experienceCount, abilityUnitCount, careerProjectCount };
}

// ─────────────────────────────────────────────────────────────────────
// Main: Cluster1 Resume DTO
// ─────────────────────────────────────────────────────────────────────
export async function getCluster1Resume(
  legacyUserId: string,
): Promise<Cluster1ResumeDto | null> {
  const crew = await getAdminCrewDtoByLegacyUserId(legacyUserId);
  if (!crew) return null;

  const userId = crew.userId;

  if (!userId) {
    return {
      resumeStatus: resolveResumeStatus(null),
      scheduleReliability: dummyScheduleReliability(),
      activityCompletion: { availableActivities: 0, completedActivities: 0, rate: 0 },
      seasonRecords: dummySeasonRecords(),
      practicalStats: { infoCount: 0, experienceCount: 0, abilityUnitCount: 0, careerProjectCount: 0 },
    };
  }

  const profileRes = await supabaseAdmin
    .from("user_profiles")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();

  const profileStatus = (profileRes.data?.status as string | null) ?? null;

  const [scheduleReliability, seasonRecords, activityCompletion, practicalStats] =
    await Promise.all([
      computeScheduleReliability(userId),
      computeSeasonRecords(userId),
      computeActivityCompletion(userId),
      computePracticalStats(userId),
    ]);

  return {
    resumeStatus: resolveResumeStatus(profileStatus),
    scheduleReliability,
    activityCompletion,
    seasonRecords,
    practicalStats,
  };
}
