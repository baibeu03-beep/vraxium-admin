import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { lazyEnsureCrewCode } from "@/lib/adminCrewCodeData";
import { getGrowthRosterBatchFast } from "@/lib/cluster3GrowthData";
import { statusBucket, statusBucketLabel } from "@/lib/memberStatusBucket";
import { classLabel } from "@/lib/adminMembersTypes";
import { isTestUser as isMarkedTestUser } from "@/lib/testUsers";

// 크루 상세 페이지(/admin/members/[userId]) 단건 DTO — 인적사항 + 클럽 소속.
// ──────────────────────────────────────────────────────────────────────────
//   · 프론트는 임의 계산하지 않는다 — 표시값(상태/활동 시작·종료일·주차/대표 학력/크루 코드/클래스 등)을
//     모두 백엔드에서 확정해 내려준다.
//   · 프로필 사진 = user_profiles.profile_photo_url(Cluster2 사진 첫 번째 슬롯=sidebar, 고객앱 동일 SoT).
//   · 대표 학력 = user_educations 의 is_primary(=sort_order 0) 행(고객앱 /api/educations 동일 선택).
//   · 상태 = 표시 성장상태(getGrowthRosterBatchFast) → 버킷 라벨(목록 표와 동일 SoT).
//   · 활동 주차 기준 = weeks(월요일 start_date ~ 일요일 end_date). 시작=시작일 포함 주차의 월요일,
//     종료=종료일 포함 주차의 일요일. 종료는 상태가 엘리트/활동 중단일 때만 존재.
//   · snapshot/포인트 무접촉(읽기 전용 — 크루 코드 lazy 생성만 user_profiles.crew_code write, freeze).
// ──────────────────────────────────────────────────────────────────────────

const SEASON_TYPE_KO: Record<string, string> = {
  winter: "겨울",
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
};

type WeekRow = {
  id: string;
  start_date: string | null;
  end_date: string | null;
  season_key: string | null;
  week_number: number | null;
};

type EducationRow = {
  school_name: string | null;
  major_name_1: string | null;
  admission_year: string | number | null;
  admission_month: string | null;
  sort_order: number | null;
  is_primary: boolean | null;
  updated_at: string | null;
};

type ProfileExtraRow = {
  address: string | null;
  activity_started_at: string | null;
  activity_ended_at: string | null;
  suspended_week_id: string | null;
};

export type CrewDetailData = {
  userId: string;
  displayName: string | null;
  organizationSlug: string | null;
  // 테스트 유저 여부(test_user_markers SoT). 커리어레쥬메 이동 시 demoUserId+mode=test(테스트)
  // vs userId(운영) 분기에 사용 — 일반 크루에 "테스트 유저 모드" 배너가 뜨지 않게 한다.
  isTestUser: boolean;
  // 인적사항
  profilePhotoUrl: string | null; // Cluster2 사진 첫 번째 슬롯(profile_photo_url)
  gender: string | null;
  birthDate: string | null;
  age: number | null;
  address: string | null; // 거주지
  contactPhone: string | null;
  contactEmail: string | null;
  schoolName: string | null; // 대표 학력 — 학교
  departmentName: string | null; // 대표 학력 — 전공
  admissionPeriod: string | null; // 대표 학력 — 입학 시기 ("2024. 03")
  // 클럽 소속
  crewCode: string | null;
  statusLabel: string; // 상태(활동 중/엘리트/시즌 휴식/주차 휴식/활동 중단/온보딩/바사노스/-)
  activityStartDate: string; // 월요일 "26. 06. 15" | "-"
  activityStartWeek: string; // "25년, 여름, 2주차" | "-"
  activityEndDate: string; // 일요일 "26. 06. 21" | "~ing" | "-"
  activityEndWeek: string; // "26년, 봄, 13주차" | "~ing" | "-"
  classLabel: string; // 클래스
  teamName: string | null; // 소속 팀
  partName: string | null; // 파트
};

// timestamptz/date → "YYYY-MM-DD"(KST 기준, 앞 10자리). 파싱 불가 시 null.
function toDateOnly(value: string | null): string | null {
  if (!value) return null;
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// "YYYY-MM-DD" → "YY. MM. DD"(6자리 표기). 파싱 불가 시 null.
function formatSixDigitDate(dateOnly: string | null | undefined): string | null {
  if (!dateOnly) return null;
  const m = String(dateOnly).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1].slice(2)}. ${m[2]}. ${m[3]}`;
}

// season_key("2026-summer") + week_number → "26년, 여름, 2주차". 파싱 불가 시 null.
function formatWeekLabel(
  seasonKey: string | null,
  weekNumber: number | null,
): string | null {
  if (!seasonKey || weekNumber == null) return null;
  const m = seasonKey.toLowerCase().match(/^(\d{4})-(winter|spring|summer|autumn|fall)$/);
  if (!m) return null;
  const yy = String(Number(m[1]) % 100).padStart(2, "0");
  const ko = SEASON_TYPE_KO[m[2]];
  if (!ko) return null;
  return `${yy}년, ${ko}, ${weekNumber}주차`;
}

// date(YYYY-MM-DD) 를 포함하는 주차(start_date ≤ date ≤ end_date). 미일치 null.
function matchWeekByDate(weeks: WeekRow[], dateOnly: string): WeekRow | null {
  for (const w of weeks) {
    if (!w.start_date || !w.end_date) continue;
    if (dateOnly >= w.start_date && dateOnly <= w.end_date) return w;
  }
  return null;
}

// 대표 학력 선택 — is_primary 우선, sort_order 오름차순, updated_at 최신(고객앱 동일 규칙).
function pickPrimaryEducation(rows: EducationRow[]): EducationRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const primaryDelta = Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
    if (primaryDelta !== 0) return primaryDelta;
    const sortDelta =
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER);
    if (sortDelta !== 0) return sortDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

// 입학 시기 — admission_year(+ admission_month) → "2024. 03" | "2024". 연도 없으면 null.
function formatAdmissionPeriod(
  year: string | number | null,
  month: string | null,
): string | null {
  const y = year == null ? "" : String(year).trim().match(/(\d{4})/)?.[1] ?? "";
  if (!y) return null;
  const m = (month ?? "").trim();
  if (!m || m === "-") return y;
  const mm = /^\d$/.test(m) ? `0${m}` : m;
  return `${y}. ${mm}`;
}

// 단건 크루 상세 DTO. 매칭 행 없으면 null(라우트가 404 처리).
//   generatedBy = 크루 코드 lazy 생성 로그의 작성자(관리자 userId).
export async function getCrewDetailDto(
  userId: string,
  options: { generatedBy?: string | null } = {},
): Promise<CrewDetailData | null> {
  const crew = await getAdminCrewDtoByLegacyUserId(userId);
  if (!crew) return null;

  const id = crew.userId;

  const [profileRes, eduRes, weeksRes, growthRows, crewCode, isTestUser] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("address,activity_started_at,activity_ended_at,suspended_week_id")
      .eq("user_id", id)
      .maybeSingle(),
    supabaseAdmin
      .from("user_educations")
      .select("school_name,major_name_1,admission_year,admission_month,sort_order,is_primary,updated_at")
      .eq("user_id", id),
    supabaseAdmin
      .from("weeks")
      .select("id,start_date,end_date,season_key,week_number")
      .not("start_date", "is", null)
      .order("start_date", { ascending: true })
      .range(0, 9999),
    getGrowthRosterBatchFast([id]),
    lazyEnsureCrewCode(id, options.generatedBy ?? null),
    isMarkedTestUser(id),
  ]);

  if (profileRes.error) throw new Error(`user_profiles load failed: ${profileRes.error.message}`);
  if (eduRes.error) throw new Error(`user_educations load failed: ${eduRes.error.message}`);
  if (weeksRes.error) throw new Error(`weeks load failed: ${weeksRes.error.message}`);

  const profile = (profileRes.data ?? null) as ProfileExtraRow | null;
  const weeks = (weeksRes.data ?? []) as unknown as WeekRow[];

  // 대표 학력 — 학교/전공/입학 시기는 동일 행에서.
  const primaryEdu = pickPrimaryEducation((eduRes.data ?? []) as unknown as EducationRow[]);
  const schoolName = primaryEdu?.school_name ?? crew.schoolName ?? null;
  const departmentName = primaryEdu?.major_name_1 ?? crew.departmentName ?? null;
  const admissionPeriod = primaryEdu
    ? formatAdmissionPeriod(primaryEdu.admission_year, primaryEdu.admission_month)
    : null;

  // 상태 — 표시 성장상태 → 버킷(라벨/종료 노출 판정 공용).
  const displayStatus = growthRows[0]?.displayGrowthStatus ?? null;
  const bucket = statusBucket(displayStatus);
  const statusLabel = statusBucketLabel(displayStatus);

  // 활동 시작 — 시작일 포함 주차의 월요일(start_date) + 주차 라벨.
  const startDateOnly = toDateOnly(profile?.activity_started_at ?? null);
  const startWeek = startDateOnly ? matchWeekByDate(weeks, startDateOnly) : null;
  const activityStartDate =
    formatSixDigitDate(startWeek?.start_date ?? startDateOnly) ?? "-";
  const activityStartWeek = startWeek
    ? formatWeekLabel(startWeek.season_key, startWeek.week_number) ?? "-"
    : "-";

  // 활동 종료 — 종료일(activity_ended_at) 포함 주차의 일요일, 없으면 suspended_week_id 주차.
  //   엘리트/활동 중단일 때만 노출. 그 외 진행 상태=~ing, 미상(-)=-.
  const endDateOnly = toDateOnly(profile?.activity_ended_at ?? null);
  let endWeek = endDateOnly ? matchWeekByDate(weeks, endDateOnly) : null;
  if (!endWeek && profile?.suspended_week_id) {
    endWeek = weeks.find((w) => w.id === profile.suspended_week_id) ?? null;
  }
  const hasEnd = bucket === "elite" || bucket === "suspended";
  let activityEndDate: string;
  let activityEndWeek: string;
  if (hasEnd) {
    activityEndDate = formatSixDigitDate(endWeek?.end_date) ?? "-";
    activityEndWeek = endWeek
      ? formatWeekLabel(endWeek.season_key, endWeek.week_number) ?? "-"
      : "-";
  } else if (bucket === "none") {
    activityEndDate = "-";
    activityEndWeek = "-";
  } else {
    activityEndDate = "~ing";
    activityEndWeek = "~ing";
  }

  return {
    userId: id,
    displayName: crew.displayName,
    organizationSlug: crew.organizationSlug,
    isTestUser,
    profilePhotoUrl: crew.profilePhotoUrl,
    gender: crew.gender,
    birthDate: crew.birthDate,
    age: crew.age,
    address: profile?.address ?? null,
    contactPhone: crew.contactPhone,
    contactEmail: crew.contactEmail,
    schoolName,
    departmentName,
    admissionPeriod,
    crewCode,
    statusLabel,
    activityStartDate,
    activityStartWeek,
    activityEndDate,
    activityEndWeek,
    classLabel: classLabel(crew.role, crew.membershipLevel),
    teamName: crew.teamName,
    partName: crew.partName,
  };
}
