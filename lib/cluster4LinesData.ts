import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import type {
  Cluster4ExperienceCategory,
  Cluster4LineDetailDto,
  Cluster4LinePartType,
  Cluster4LineSubmissionDto,
  Cluster4LineSubmissionInput,
  Cluster4VisibleLineDto,
} from "@/lib/cluster4LinesTypes";
import {
  PART_TYPE_TO_EDIT_WINDOW_KEY,
  evaluateCluster4HubEdit,
  type Cluster4EditWindowSnapshot,
  type Cluster4HubEditDecisionReason,
} from "@/lib/cluster4LinePermission";
import {
  resolveOutputLinks,
  outputLinksToLegacySlots,
} from "@/lib/cluster4OutputLinks";
import {
  outputImageUrls,
  outputImageCaptions as outputImageCaptionList,
} from "@/lib/cluster4OutputImages";
import {
  type CareerGrade,
  type CareerRatingStatus,
  careerRatingStatusFromGrade,
} from "@/lib/careerGrade";

export class Cluster4PublicLineError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "Cluster4PublicLineError";
    this.status = status;
  }
}

type Cluster4LineTargetJoinedRow = {
  id: string;
  line_id: string;
  week_id: string;
  target_mode: "user" | "rule";
  target_user_id: string | null;
  target_rule: Record<string, unknown> | null;
  cluster4_lines: {
    id: string;
    part_type: Cluster4LinePartType;
    main_title: string;
    output_link_1: string | null;
    output_links: unknown;
    submission_opens_at: string;
    submission_closes_at: string;
    is_active: boolean;
    // experience 5슬롯 분류 조인용 (experience part 라인에만 값 존재).
    experience_line_master_id: string | null;
  } | null;
};

type Cluster4SubmissionRow = {
  id: string;
  line_target_id: string;
  subtitle: string | null;
  growth_point: string | null;
  output_link_2: string | null;
  output_link_3: string | null;
  output_link_4: string | null;
  output_link_5: string | null;
  output_links: unknown;
  // 레거시 string[] · 신규 [{url,caption}] 혼재 가능 → unknown 으로 받아 정규화.
  output_images: unknown;
  submitted_at: string;
  updated_at: string;
};

// 제출 SELECT — growth_point/output_images 공통 제출 컬럼 포함.
const SUBMISSION_SELECT =
  "id,line_target_id,subtitle,growth_point,output_link_2,output_link_3,output_link_4,output_link_5,output_links,output_images,submitted_at,updated_at";

const TARGET_WITH_LINE_SELECT = `
  id,
  line_id,
  week_id,
  target_mode,
  target_user_id,
  target_rule,
  cluster4_lines!inner(
    id,
    part_type,
    main_title,
    output_link_1,
    output_links,
    submission_opens_at,
    submission_closes_at,
    is_active,
    experience_line_master_id
  )
`;

function toVisibleLine(row: Cluster4LineTargetJoinedRow): Cluster4VisibleLineDto {
  const line = row.cluster4_lines;
  if (!line) {
    throw new Cluster4PublicLineError(500, "cluster4 line join missing");
  }
  return {
    lineId: line.id,
    lineTargetId: row.id,
    partType: line.part_type,
    targetMode: row.target_mode,
    mainTitle: line.main_title,
    outputLink1: line.output_link_1,
    outputLinks: resolveOutputLinks(line.output_links, [line.output_link_1]),
    submissionOpensAt: line.submission_opens_at,
    submissionClosesAt: line.submission_closes_at,
  };
}

function toSubmissionDto(row: Cluster4SubmissionRow): Cluster4LineSubmissionDto {
  return {
    id: row.id,
    lineTargetId: row.line_target_id,
    subtitle: row.subtitle,
    growthPoint: row.growth_point ?? null,
    outputLink2: row.output_link_2,
    outputLink3: row.output_link_3,
    outputLink4: row.output_link_4,
    outputLink5: row.output_link_5,
    outputLinks: resolveOutputLinks(row.output_links, [
      row.output_link_2,
      row.output_link_3,
      row.output_link_4,
      row.output_link_5,
    ]),
    outputImages: outputImageUrls(row.output_images),
    outputImageCaptions: outputImageCaptionList(row.output_images),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

function isSubmissionClosed(closesAt: string, now = new Date()) {
  return now.getTime() > new Date(closesAt).getTime();
}

// Maps the unified hub edit reason to the HTTP status this API previously emitted.
// Preserves the existing 4xx/501 contract. ok_override 는 운영자 user_edit_windows
// override 가 OPEN 인 경우로, ok 와 동일하게 200 으로 처리한다.
function hubReasonToHttp(
  reason: Cluster4HubEditDecisionReason,
): { status: number; message: string } {
  switch (reason) {
    case "target_missing":
      return { status: 404, message: "Line target not found." };
    case "unsupported_target_mode":
      return {
        status: 501,
        message: "Rule-based line targets are not implemented yet.",
      };
    case "line_inactive":
      return { status: 410, message: "Line is not active." };
    case "not_owner":
      return { status: 403, message: "This line target is not accessible." };
    case "window_not_open":
      return { status: 410, message: "Submission window is not open yet." };
    case "window_closed":
      return { status: 410, message: "Submission window is closed." };
    case "ok":
    case "ok_override":
      return { status: 200, message: "ok" };
  }
}

// 해당 part_type 의 cluster4.work_* override 스냅샷을 조회한다. 없으면 null.
async function fetchHubEditWindow(
  profileUserId: string,
  partType: Cluster4LinePartType,
): Promise<Cluster4EditWindowSnapshot> {
  const resourceKey = PART_TYPE_TO_EDIT_WINDOW_KEY[partType];
  const { data, error } = await supabaseAdmin
    .from("user_edit_windows")
    .select("opened_at,expires_at")
    .eq("user_id", profileUserId)
    .eq("resource_key", resourceKey)
    .maybeSingle();
  if (error) {
    // 누락 테이블 등은 strict 정책으로 폴백.
    console.warn("[cluster4/lines] user_edit_windows lookup failed", {
      message: error.message,
      resourceKey,
    });
    return null;
  }
  if (!data) return null;
  return {
    openedAt: (data as { opened_at: string }).opened_at,
    expiresAt: (data as { expires_at: string }).expires_at,
  };
}

function toPermissionTarget(row: Cluster4LineTargetJoinedRow) {
  return {
    target_mode: row.target_mode,
    target_user_id: row.target_user_id,
    line: row.cluster4_lines
      ? {
          is_active: row.cluster4_lines.is_active,
          submission_opens_at: row.cluster4_lines.submission_opens_at,
          submission_closes_at: row.cluster4_lines.submission_closes_at,
        }
      : null,
  };
}

async function resolveAuthenticatedProfileUserId(authUserId: string, authEmail?: string | null) {
  const profileUserId = await resolveProfileUserId(authUserId, authEmail);
  if (!profileUserId) {
    throw new Cluster4PublicLineError(404, "User profile not found.");
  }
  return profileUserId;
}

async function listCandidateTargetsForUser(
  profileUserId: string,
  weekId: string,
  partType: Cluster4LinePartType,
) {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(TARGET_WITH_LINE_SELECT)
    .eq("week_id", weekId)
    .eq("cluster4_lines.part_type", partType)
    .eq("cluster4_lines.is_active", true)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }

  const rows = (data ?? []) as unknown as Cluster4LineTargetJoinedRow[];
  const supported = rows.filter((row) => row.target_mode === "user");
  const matched = supported.find((row) => row.target_user_id === profileUserId) ?? null;
  const hasRuleTargets = rows.some((row) => row.target_mode === "rule");
  return { matched, hasRuleTargets };
}

async function getSubmissionForTargetAndUser(lineTargetId: string, profileUserId: string) {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .select(SUBMISSION_SELECT)
    .eq("line_target_id", lineTargetId)
    .eq("user_id", profileUserId)
    .maybeSingle();
  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }
  return (data ?? null) as Cluster4SubmissionRow | null;
}

// 실무 경험 평점 — cluster4_experience_line_evaluations.rating (운영자/평가값).
// (line_target_id + user_id) 단위로 현재 대상자의 평점만 조회. 미평가/조회 실패 시 null.
// 사용자 제출(submission)과 무관하며 experience part 에서만 호출한다.
async function getExperienceRatingForTargetAndUser(
  lineTargetId: string,
  profileUserId: string,
): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_evaluations")
    .select("rating")
    .eq("line_target_id", lineTargetId)
    .eq("user_id", profileUserId)
    .maybeSingle();
  if (error) {
    console.warn("[cluster4/lines/detail] experience evaluation lookup failed", {
      message: error.message,
    });
    return null;
  }
  return (data as { rating: number } | null)?.rating ?? null;
}

// 실무 경험 5슬롯 분류 — cluster4_experience_line_masters (experience_line_master_id 단건 조회).
// experience part 에서만 호출. 미분류/조회 실패 시 {category:null, slotOrder:null}.
async function getExperienceMasterMeta(
  experienceLineMasterId: string | null,
): Promise<{ category: Cluster4ExperienceCategory | null; slotOrder: number | null }> {
  if (!experienceLineMasterId) return { category: null, slotOrder: null };
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .select("experience_category,experience_slot_order")
    .eq("id", experienceLineMasterId)
    .maybeSingle();
  if (error) {
    console.warn("[cluster4/lines/detail] experience master lookup failed", {
      message: error.message,
    });
    return { category: null, slotOrder: null };
  }
  const row = data as {
    experience_category: Cluster4ExperienceCategory | null;
    experience_slot_order: number | null;
  } | null;
  return {
    category: row?.experience_category ?? null,
    slotOrder: row?.experience_slot_order ?? null,
  };
}

// 실무 경력 평점 — cluster4_career_line_evaluations.grade / grade_points (운영자/평가값).
// (line_target_id + user_id) 단위로 현재 대상자의 평점만 조회. 미평가/조회 실패 시 null.
// 사용자 제출(submission)과 무관하며 career part 에서만 호출한다. weekly-cards 와 동일 값.
async function getCareerGradeForTargetAndUser(
  lineTargetId: string,
  profileUserId: string,
): Promise<{ grade: CareerGrade; points: number } | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_career_line_evaluations")
    .select("grade,grade_points")
    .eq("line_target_id", lineTargetId)
    .eq("user_id", profileUserId)
    .maybeSingle();
  if (error) {
    console.warn("[cluster4/lines/detail] career evaluation lookup failed", {
      message: error.message,
    });
    return null;
  }
  const row = data as { grade: CareerGrade; grade_points: number } | null;
  if (!row) return null;
  return { grade: row.grade, points: row.grade_points };
}

// Fetches the target row by id; ownership / window checks are handled separately by
// the unified canEditCluster4Line helper so admin and portal paths agree on policy.
async function fetchTargetById(lineTargetId: string) {
  if (!isUuid(lineTargetId)) {
    throw new Cluster4PublicLineError(400, "lineTargetId must be a UUID");
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(TARGET_WITH_LINE_SELECT)
    .eq("id", lineTargetId)
    .maybeSingle();
  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4PublicLineError(404, "Line target not found.");
  }

  return data as unknown as Cluster4LineTargetJoinedRow;
}

// 포털 submit/update 게이트. ownership 은 항상 강제하되, submission window 가 닫혀 있어도
// user_edit_windows.cluster4.work_<hub> override 가 OPEN 이면 ok_override 로 저장을 허용한다.
// 어드민 ActivityTab(evaluateCluster4HubEdit) 과 동일한 정책. canEdit=true 인 weekly-cards
// DTO 와 실제 저장 API 결과가 일치하도록 한다.
async function requireEditableTarget(
  lineTargetId: string,
  profileUserId: string,
): Promise<Cluster4LineTargetJoinedRow> {
  const row = await fetchTargetById(lineTargetId);
  const partType = row.cluster4_lines?.part_type ?? null;
  const editWindow = partType
    ? await fetchHubEditWindow(profileUserId, partType)
    : null;
  const decision = evaluateCluster4HubEdit({
    target: toPermissionTarget(row),
    editWindow,
    profileUserId,
  });
  if (!decision.canEdit) {
    const http = hubReasonToHttp(decision.reason);
    throw new Cluster4PublicLineError(http.status, http.message);
  }
  return row;
}

function buildSubmissionPayload(input: Cluster4LineSubmissionInput) {
  // output_links 가 canonical. 레거시 output_link_2~5 는 backward-compat mirror.
  // 제출 슬롯은 4개(2~5) 이므로 jsonb 의 앞 4개 url 을 mirror 한다.
  const [link2, link3, link4, link5] = outputLinksToLegacySlots(input.outputLinks, 4);
  return {
    subtitle: input.subtitle,
    growth_point: input.growthPoint,
    output_link_2: link2,
    output_link_3: link3,
    output_link_4: link4,
    output_link_5: link5,
    output_links: input.outputLinks,
    output_images: input.outputImages,
  };
}

export async function getCluster4LineDetailForAuthUser(
  authUserId: string,
  authEmail: string | null | undefined,
  weekId: string,
  partType: Cluster4LinePartType,
): Promise<Cluster4LineDetailDto> {
  const profileUserId = await resolveAuthenticatedProfileUserId(authUserId, authEmail);
  return getCluster4LineDetailForProfileUser(profileUserId, weekId, partType);
}

// 데모/어드민 경로: profile.user_id 를 직접 받아 라인 상세를 조회한다.
// auth 변형(getCluster4LineDetailForAuthUser)은 세션 → profile 해소 후 이 함수에 위임한다.
export async function getCluster4LineDetailForProfileUser(
  profileUserId: string,
  weekId: string,
  partType: Cluster4LinePartType,
): Promise<Cluster4LineDetailDto> {
  if (!isUuid(weekId)) {
    throw new Cluster4PublicLineError(400, "weekId must be a UUID");
  }
  const { matched, hasRuleTargets } = await listCandidateTargetsForUser(
    profileUserId,
    weekId,
    partType,
  );

  if (!matched) {
    if (hasRuleTargets) {
      console.warn(
        "[cluster4/lines/detail] rule target candidates exist but evaluator is not implemented",
        { profileUserId, weekId, partType },
      );
    }
    // 미배정(void): 타깃이 없으므로 평점·분류도 없다.
    return {
      status: "void",
      partType,
      line: null,
      submission: null,
      experienceRating: null,
      experienceCategory: null,
      experienceSlotOrder: null,
      careerGrade: null,
      careerGradePoints: null,
      careerRatingStatus: null,
    };
  }

  const line = toVisibleLine(matched);
  // 실무 경험 평점·5슬롯 분류는 experience part 에서만 조회. 그 외 part 는 null.
  const isExperience = partType === "experience";
  const experienceRating = isExperience
    ? await getExperienceRatingForTargetAndUser(matched.id, profileUserId)
    : null;
  const experienceMeta = isExperience
    ? await getExperienceMasterMeta(matched.cluster4_lines?.experience_line_master_id ?? null)
    : { category: null, slotOrder: null };
  // 실무 경력 평점은 career part 에서만 조회. 그 외 part 는 null → careerRatingStatus 도 null.
  const isCareer = partType === "career";
  const careerEval = isCareer
    ? await getCareerGradeForTargetAndUser(matched.id, profileUserId)
    : null;
  const careerGrade: CareerGrade | null = careerEval?.grade ?? null;
  const careerGradePoints: number | null = careerEval?.points ?? null;
  const careerRatingStatus: CareerRatingStatus | null = isCareer
    ? careerRatingStatusFromGrade(careerGrade)
    : null;
  const submission = await getSubmissionForTargetAndUser(matched.id, profileUserId);
  if (submission) {
    return {
      status: "success",
      partType,
      line,
      submission: toSubmissionDto(submission),
      experienceRating,
      experienceCategory: experienceMeta.category,
      experienceSlotOrder: experienceMeta.slotOrder,
      careerGrade,
      careerGradePoints,
      careerRatingStatus,
    };
  }

  const status = isSubmissionClosed(line.submissionClosesAt) ? "fail" : "pending";
  return {
    status,
    partType,
    line,
    submission: null,
    experienceRating,
    experienceCategory: experienceMeta.category,
    experienceSlotOrder: experienceMeta.slotOrder,
    careerGrade,
    careerGradePoints,
    careerRatingStatus,
  };
}

export async function createCluster4LineSubmissionForAuthUser(
  authUserId: string,
  authEmail: string | null | undefined,
  lineTargetId: string,
  input: Cluster4LineSubmissionInput,
): Promise<Cluster4LineSubmissionDto> {
  const profileUserId = await resolveAuthenticatedProfileUserId(authUserId, authEmail);
  return createCluster4LineSubmissionForProfileUser(profileUserId, lineTargetId, input);
}

// 데모/어드민 경로: profile.user_id 를 직접 받아 제출을 생성한다.
// auth 변형은 세션 → profile 해소 후 이 함수에 위임한다.
// 작성 기간(edit window) 검증(requireEditableTarget)과 소유자(user_id=profileUserId)는
// 일반 고객 흐름과 동일하게 적용된다 → 데모라고 무조건 허용되지 않으며, 저장 row 는
// 항상 해당 테스트 유저 소유다.
export async function createCluster4LineSubmissionForProfileUser(
  profileUserId: string,
  lineTargetId: string,
  input: Cluster4LineSubmissionInput,
): Promise<Cluster4LineSubmissionDto> {
  await requireEditableTarget(lineTargetId, profileUserId);

  const existing = await getSubmissionForTargetAndUser(lineTargetId, profileUserId);
  if (existing) {
    throw new Cluster4PublicLineError(409, "Submission already exists.");
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .insert({
      line_target_id: lineTargetId,
      user_id: profileUserId,
      ...buildSubmissionPayload(input),
    })
    .select(SUBMISSION_SELECT)
    .single();
  if (error || !data) {
    throw new Cluster4PublicLineError(
      500,
      error?.message ?? "Failed to create submission.",
    );
  }
  return toSubmissionDto(data as unknown as Cluster4SubmissionRow);
}

export async function updateCluster4LineSubmissionForAuthUser(
  authUserId: string,
  authEmail: string | null | undefined,
  lineTargetId: string,
  input: Cluster4LineSubmissionInput,
): Promise<Cluster4LineSubmissionDto> {
  const profileUserId = await resolveAuthenticatedProfileUserId(authUserId, authEmail);
  return updateCluster4LineSubmissionForProfileUser(profileUserId, lineTargetId, input);
}

// 데모/어드민 경로: profile.user_id 를 직접 받아 제출을 수정한다 (위 create 와 동일 정책).
export async function updateCluster4LineSubmissionForProfileUser(
  profileUserId: string,
  lineTargetId: string,
  input: Cluster4LineSubmissionInput,
): Promise<Cluster4LineSubmissionDto> {
  await requireEditableTarget(lineTargetId, profileUserId);

  const existing = await getSubmissionForTargetAndUser(lineTargetId, profileUserId);
  if (!existing) {
    throw new Cluster4PublicLineError(404, "Submission not found.");
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .update(buildSubmissionPayload(input))
    .eq("id", existing.id)
    .eq("user_id", profileUserId)
    .select(SUBMISSION_SELECT)
    .maybeSingle();
  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4PublicLineError(404, "Submission not found.");
  }
  return toSubmissionDto(data as unknown as Cluster4SubmissionRow);
}
