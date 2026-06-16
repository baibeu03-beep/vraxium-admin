// Server-only admin data layer for cluster4_line_submissions.
//
// 목적: 어드민 ActivityTab 이 user_activity_details 대신 cluster4_line_submissions 를
// SoT 로 편집하도록 하는 list/upsert/delete 경로. 고객 포털 경로(cluster4LinesData.ts)와
// 달리 submission window(submission_closes_at)를 검사하지 않는다 — 운영자는 작성기간과
// 무관하게 수정/삭제할 수 있다(서비스롤 supabaseAdmin 사용, DB 트리거는 ownership 만 강제).
//
// 정책:
//   - source = cluster4_line_submissions, 편집 단위 = line_target_id.
//   - user-mode target 만 허용. target_user_id === userId ownership 강제.
//   - rule-mode target 은 불허(트리거가 user-mode 만 매칭 + 정책상 미구현).
//   - submission_closes_at / submission_opens_at 미검사.
//   - 정규화 규칙은 고객 제출(buildSubmissionPayload)과 동일: output_links jsonb canonical +
//     레거시 output_link_2~5 mirror, output_images jsonb([{url,caption}]).
//   - rating 은 이번 단계 제외(컬럼 자체가 submissions 에 없음).
//
// 주의: user_activity_details / 고객 포털 제출 경로(cluster4LinesData.ts) / info 읽기 DTO 는
// 일절 건드리지 않는다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import type {
  Cluster4AdminSubmissionRow,
  Cluster4AdminSubmissionUpsertInput,
} from "@/lib/adminCluster4Types";
import type { Cluster4LinePartType } from "@/lib/cluster4LinesTypes";
import {
  normalizeOutputLinks,
  outputLinksToLegacySlots,
  OUTPUT_LINK_LABEL_MAX_LENGTH,
} from "@/lib/cluster4OutputLinks";
import {
  normalizeOutputImages,
  OUTPUT_IMAGE_CAPTION_MAX_LENGTH,
} from "@/lib/cluster4OutputImages";

export class AdminCluster4SubmissionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminCluster4SubmissionError";
    this.status = status;
  }
}

// line target + 조인된 line 컬럼. 고객 포털 SELECT 와 별개로 admin 이 필요한 컬럼만.
const ADMIN_TARGET_WITH_LINE_SELECT = `
  id,
  line_id,
  week_id,
  target_mode,
  target_user_id,
  cluster4_lines!inner(
    id,
    part_type,
    main_title,
    activity_type_id,
    submission_opens_at,
    submission_closes_at,
    is_active
  )
`;

const ADMIN_SUBMISSION_SELECT =
  "id,line_target_id,user_id,subtitle,growth_point,output_link_2,output_link_3,output_link_4,output_link_5,output_links,output_images,submitted_at,updated_at";

type AdminTargetJoinedRow = {
  id: string;
  line_id: string;
  week_id: string;
  target_mode: "user" | "rule";
  target_user_id: string | null;
  cluster4_lines: {
    id: string;
    part_type: Cluster4LinePartType;
    main_title: string;
    activity_type_id: string | null;
    submission_opens_at: string;
    submission_closes_at: string;
    is_active: boolean;
  } | null;
};

type AdminSubmissionDbRow = {
  id: string;
  line_target_id: string;
  user_id: string;
  subtitle: string | null;
  growth_point: string | null;
  output_link_2: string | null;
  output_link_3: string | null;
  output_link_4: string | null;
  output_link_5: string | null;
  output_links: unknown;
  output_images: unknown;
  submitted_at: string;
  updated_at: string;
};

function isMissingRelationError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return typeof error.message === "string" && /does not exist/i.test(error.message);
}

function normalizeNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const stringValue = typeof value === "string" ? value : String(value);
  const trimmed = stringValue.trim();
  return trimmed === "" ? null : trimmed;
}

function toSubmissionPart(
  row: AdminSubmissionDbRow | null,
): Cluster4AdminSubmissionRow["submission"] {
  if (!row) return null;
  return {
    id: row.id,
    subtitle: row.subtitle,
    growthPoint: row.growth_point ?? null,
    // 읽기: output_links jsonb canonical, 비어 있으면 레거시 컬럼 fallback.
    outputLinks: (() => {
      const fromJson = normalizeOutputLinks(row.output_links);
      if (fromJson.length > 0) return fromJson;
      return normalizeOutputLinks(
        [row.output_link_2, row.output_link_3, row.output_link_4, row.output_link_5]
          .filter((u): u is string => typeof u === "string" && u.trim() !== "")
          .map((url) => ({ url })),
      );
    })(),
    outputImages: normalizeOutputImages(row.output_images),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

function toAdminSubmissionRow(
  target: AdminTargetJoinedRow,
  submission: AdminSubmissionDbRow | null,
): Cluster4AdminSubmissionRow {
  const line = target.cluster4_lines;
  if (!line) {
    throw new AdminCluster4SubmissionError(500, "cluster4 line join missing");
  }
  return {
    lineTargetId: target.id,
    lineId: target.line_id,
    weekId: target.week_id,
    partType: line.part_type,
    mainTitle: line.main_title,
    activityTypeId: line.activity_type_id,
    submissionOpensAt: line.submission_opens_at,
    submissionClosesAt: line.submission_closes_at,
    isActive: line.is_active,
    submission: toSubmissionPart(submission),
  };
}

// 폼/페이로드 입력 → 저장용 payload. buildSubmissionPayload(고객 경로)와 동일 규칙:
// output_links jsonb canonical + 레거시 output_link_2~5 mirror, output_images jsonb.
// rating 미포함(컬럼 부재).
function buildAdminSubmissionPayload(input: Cluster4AdminSubmissionUpsertInput) {
  const outputLinks = normalizeOutputLinks(input.outputLinks);
  const outputImages = normalizeOutputImages(input.outputImages);
  // 정책: 아웃풋 링크 설명(label)≤30자 / 이미지 설명(caption)≤20자. 위반 시 400 — DB write 금지.
  for (const link of outputLinks) {
    if (link.label && link.label.length > OUTPUT_LINK_LABEL_MAX_LENGTH) {
      throw new AdminCluster4SubmissionError(
        400,
        `링크 설명은 최대 ${OUTPUT_LINK_LABEL_MAX_LENGTH}자까지 입력 가능합니다 (현재 ${link.label.length}자).`,
      );
    }
  }
  for (const image of outputImages) {
    if (image.caption && image.caption.length > OUTPUT_IMAGE_CAPTION_MAX_LENGTH) {
      throw new AdminCluster4SubmissionError(
        400,
        `이미지 설명은 최대 ${OUTPUT_IMAGE_CAPTION_MAX_LENGTH}자까지 입력 가능합니다 (현재 ${image.caption.length}자).`,
      );
    }
  }
  const [link2, link3, link4, link5] = outputLinksToLegacySlots(outputLinks, 4);
  return {
    subtitle: normalizeNullableText(input.subtitle),
    growth_point: normalizeNullableText(input.growthPoint),
    output_link_2: link2,
    output_link_3: link3,
    output_link_4: link4,
    output_link_5: link5,
    output_links: outputLinks,
    output_images: outputImages,
  };
}

// user-mode target 을 조회하고 ownership(target_user_id === userId)을 강제한다.
// rule-mode / 타인 소유 / 부재는 모두 에러. 작성기간은 검사하지 않는다.
async function requireOwnedUserTarget(
  lineTargetId: string,
  userId: string,
): Promise<AdminTargetJoinedRow> {
  if (!isUuid(lineTargetId)) {
    throw new AdminCluster4SubmissionError(400, "lineTargetId must be a UUID.");
  }
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(ADMIN_TARGET_WITH_LINE_SELECT)
    .eq("id", lineTargetId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error)) {
      throw new AdminCluster4SubmissionError(404, "Line target not found.");
    }
    throw new AdminCluster4SubmissionError(500, error.message);
  }
  const target = (data ?? null) as unknown as AdminTargetJoinedRow | null;
  if (!target) {
    throw new AdminCluster4SubmissionError(404, "Line target not found.");
  }
  if (target.target_mode !== "user") {
    throw new AdminCluster4SubmissionError(
      400,
      "Only user-mode line targets support submissions.",
    );
  }
  if (!target.target_user_id || target.target_user_id !== userId) {
    throw new AdminCluster4SubmissionError(
      403,
      "Line target does not belong to this crew.",
    );
  }
  return target;
}

// 그 유저에게 배정된 user-mode active 라인 target + (있으면) submission 본문 슬롯 목록.
// info DTO / 고객 경로와 무관한 어드민 편집 전용 read.
export async function listCluster4LineSubmissionsForUser(
  userId: string,
): Promise<{ rows: Cluster4AdminSubmissionRow[]; available: boolean }> {
  const trimmed = String(userId ?? "").trim();
  if (!trimmed) {
    throw new AdminCluster4SubmissionError(400, "userId is required.");
  }

  const { data: targetData, error: targetError } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(ADMIN_TARGET_WITH_LINE_SELECT)
    .eq("target_mode", "user")
    .eq("target_user_id", trimmed)
    .eq("cluster4_lines.is_active", true)
    .order("week_id", { ascending: true });

  if (targetError) {
    if (isMissingRelationError(targetError)) {
      console.warn(
        '[cluster4] table "cluster4_line_targets" not found; returning empty submissions.',
        { message: targetError.message },
      );
      return { rows: [], available: false };
    }
    console.error("[cluster4] query failed (admin submissions targets)", {
      message: targetError.message,
    });
    throw new AdminCluster4SubmissionError(500, targetError.message);
  }

  const targets = ((targetData ?? []) as unknown as AdminTargetJoinedRow[]).filter(
    (t) => t.cluster4_lines !== null,
  );
  const targetIds = targets.map((t) => t.id);

  const submissionByTargetId = new Map<string, AdminSubmissionDbRow>();
  if (targetIds.length > 0) {
    const { data: submissionData, error: submissionError } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select(ADMIN_SUBMISSION_SELECT)
      .eq("user_id", trimmed)
      .in("line_target_id", targetIds);

    if (submissionError) {
      console.error("[cluster4] query failed (admin submissions body)", {
        message: submissionError.message,
      });
      throw new AdminCluster4SubmissionError(500, submissionError.message);
    }

    for (const row of (submissionData ?? []) as AdminSubmissionDbRow[]) {
      submissionByTargetId.set(row.line_target_id, row);
    }
  }

  const rows = targets.map((target) =>
    toAdminSubmissionRow(target, submissionByTargetId.get(target.id) ?? null),
  );
  return { rows, available: true };
}

// line_target_id 기준 full-payload upsert(고객 update 와 동일 의미 — 폼 전체를 보낸다).
// (line_target_id, user_id) UNIQUE 키로 존재→update / 부재→insert. 작성기간 미검사.
export async function adminUpsertCluster4LineSubmission(
  userId: string,
  input: Cluster4AdminSubmissionUpsertInput,
): Promise<Cluster4AdminSubmissionRow> {
  const trimmedUser = String(userId ?? "").trim();
  if (!trimmedUser) {
    throw new AdminCluster4SubmissionError(400, "userId is required.");
  }
  const lineTargetId = String(input.lineTargetId ?? "").trim();
  if (!lineTargetId) {
    throw new AdminCluster4SubmissionError(400, "lineTargetId is required.");
  }

  const target = await requireOwnedUserTarget(lineTargetId, trimmedUser);
  const payload = buildAdminSubmissionPayload(input);

  // 기존 submission 조회 (UNIQUE line_target_id + user_id).
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .select("id")
    .eq("line_target_id", lineTargetId)
    .eq("user_id", trimmedUser)
    .maybeSingle();

  if (existingError) {
    console.error("[cluster4] admin submission lookup failed", {
      message: existingError.message,
    });
    throw new AdminCluster4SubmissionError(500, existingError.message);
  }

  let saved: AdminSubmissionDbRow;
  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .update(payload)
      .eq("id", (existing as { id: string }).id)
      .eq("user_id", trimmedUser)
      .select(ADMIN_SUBMISSION_SELECT)
      .single();
    if (error || !data) {
      throw new AdminCluster4SubmissionError(
        500,
        error?.message ?? "Failed to update submission.",
      );
    }
    saved = data as AdminSubmissionDbRow;
  } else {
    const { data, error } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .insert({
        line_target_id: lineTargetId,
        user_id: trimmedUser,
        ...payload,
      })
      .select(ADMIN_SUBMISSION_SELECT)
      .single();
    if (error || !data) {
      throw new AdminCluster4SubmissionError(
        500,
        error?.message ?? "Failed to create submission.",
      );
    }
    saved = data as AdminSubmissionDbRow;
  }

  return toAdminSubmissionRow(target, saved);
}

// submission id + user_id 스코프 삭제. ownership 검증 후 삭제. 작성기간 미검사.
export async function adminDeleteCluster4LineSubmission(
  userId: string,
  submissionId: string,
): Promise<string> {
  const trimmedUser = String(userId ?? "").trim();
  const id = String(submissionId ?? "").trim();
  if (!trimmedUser) {
    throw new AdminCluster4SubmissionError(400, "userId is required.");
  }
  if (!id) {
    throw new AdminCluster4SubmissionError(
      400,
      "cluster4_line_submission id is required.",
    );
  }

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();

  if (lookupError) {
    if (isMissingRelationError(lookupError)) {
      throw new AdminCluster4SubmissionError(404, "Submission not found.");
    }
    throw new AdminCluster4SubmissionError(500, lookupError.message);
  }
  if (!existing) {
    throw new AdminCluster4SubmissionError(404, "Submission not found.");
  }
  if ((existing as { user_id?: string }).user_id !== trimmedUser) {
    throw new AdminCluster4SubmissionError(
      403,
      "Submission does not belong to this crew.",
    );
  }

  const { error } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .delete()
    .eq("id", id)
    .eq("user_id", trimmedUser);

  if (error) {
    throw new AdminCluster4SubmissionError(500, error.message);
  }

  return id;
}
