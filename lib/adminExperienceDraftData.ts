import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import type {
  ExperienceDraftDto,
  ExperienceDraftRow,
  ExperienceDraftCreateInput,
  ExperienceDraftPatchInput,
  ExperienceDraftReviewInput,
  InputStatus,
} from "@/lib/adminExperienceDraftTypes";
import { resolveOutputLinks } from "@/lib/cluster4OutputLinks";
import {
  outputImageUrls,
  outputImageCaptions as toOutputImageCaptions,
} from "@/lib/cluster4OutputImages";
import { insertExperienceOpeningLog } from "@/lib/adminExperienceOpeningLogs";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";
import { collectLineOrgAudience } from "@/lib/adminCluster4LinesData";

// ── Row → DTO mapping ─────────────────────────────────────

const DRAFT_SELECT = [
  "*",
  "cluster4_teams(team_name)",
  "user_profiles!cluster4_experience_line_drafts_target_user_id_fkey(display_name)",
  "cluster4_experience_line_masters!cluster4_experience_line_drafts_experience_line_master_id_fkey(line_name)",
].join(",");

function toDraftDto(row: ExperienceDraftRow): ExperienceDraftDto {
  return {
    id: row.id,
    weekId: row.week_id,
    organizationSlug: row.organization_slug,
    teamId: row.team_id,
    teamName: row.cluster4_teams?.team_name ?? null,
    partName: row.part_name,
    targetUserId: row.target_user_id,
    targetUserName: row.user_profiles?.display_name ?? null,
    experienceLineMasterId: row.experience_line_master_id,
    lineCode: row.line_code,
    lineName: row.cluster4_experience_line_masters?.line_name ?? null,
    mainTitle: row.main_title,
    outputLink1: row.output_link_1,
    outputLink2: row.output_link_2,
    outputLinks: resolveOutputLinks(row.output_links, [
      row.output_link_1,
      row.output_link_2,
    ]),
    // output_images 는 레거시 string[] · 신규 [{url,caption}] 혼재 가능 → 정규화.
    outputImages: outputImageUrls(row.output_images),
    outputImageCaptions: toOutputImageCaptions(row.output_images),
    rating: row.rating,
    memo: row.memo,
    inputStatus: row.input_status,
    reviewStatus: row.review_status,
    openStatus: row.open_status,
    rejectionReason: row.rejection_reason,
    enteredBy: row.entered_by,
    enteredAt: row.entered_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    openedLineId: row.opened_line_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── List drafts ────────────────────────────────────────────

export async function listExperienceDrafts(filters: {
  weekId: string;
  organizationSlug?: string | null;
  team?: string | null;
  part?: string | null;
  inputStatus?: string | null;
  reviewStatus?: string | null;
  openStatus?: string | null;
  mode?: ScopeMode;
}): Promise<ExperienceDraftDto[]> {
  let query = supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .select(DRAFT_SELECT)
    .eq("week_id", filters.weekId)
    .order("created_at", { ascending: true });

  if (filters.organizationSlug) {
    query = query.eq("organization_slug", filters.organizationSlug);
  }
  if (filters.inputStatus) {
    query = query.eq("input_status", filters.inputStatus);
  }
  if (filters.reviewStatus) {
    query = query.eq("review_status", filters.reviewStatus);
  }
  if (filters.openStatus) {
    query = query.eq("open_status", filters.openStatus);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  let rows = (data ?? []) as unknown as ExperienceDraftRow[];

  if (filters.team) {
    rows = rows.filter((r) => r.cluster4_teams?.team_name === filters.team);
  }
  if (filters.part) {
    rows = rows.filter((r) => r.part_name === filters.part);
  }

  const scope = await resolveUserScope(filters.mode ?? "operating", null);
  return rows.filter((row) => scope.includes(row.target_user_id)).map(toDraftDto);
}

// ── Create draft ───────────────────────────────────────────

export async function createExperienceDraft(
  input: ExperienceDraftCreateInput,
  adminId: string,
): Promise<ExperienceDraftDto> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .insert({
      week_id: input.weekId,
      organization_slug: input.organizationSlug,
      team_id: input.teamId,
      part_name: input.partName,
      target_user_id: input.targetUserId,
      experience_line_master_id: input.experienceLineMasterId,
      line_code: input.lineCode,
      main_title: input.mainTitle,
      output_link_1: input.outputLink1,
      output_link_2: input.outputLink2,
      output_links: input.outputLinks,
      output_images: input.outputImages,
      rating: input.rating,
      memo: input.memo,
      input_status: input.inputStatus,
      review_status: "pending",
      open_status: "pending",
      entered_by: adminId,
      entered_at: new Date().toISOString(),
    })
    .select(DRAFT_SELECT)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw Object.assign(
        new Error("이미 해당 주차에 동일 사용자·라인 조합의 초안이 존재합니다"),
        { status: 409 },
      );
    }
    throw new Error(error.message);
  }

  const dto = toDraftDto(data as unknown as ExperienceDraftRow);
  // 행동 이력: 신규 작성이 곧 제출(submitted)이면 [개설 신청] 로그(best-effort).
  if (dto.inputStatus === "submitted") {
    await insertExperienceOpeningLog({
      action: "apply",
      weekId: dto.weekId,
      organizationSlug: dto.organizationSlug,
      actorUserId: adminId,
      teamId: dto.teamId,
      teamName: dto.teamName,
      partName: dto.partName,
      isTeamLevel: false,
      draftId: dto.id,
      targetUserId: dto.targetUserId,
    });
  }
  return dto;
}

// ── Update draft ───────────────────────────────────────────

export async function updateExperienceDraft(
  id: string,
  input: ExperienceDraftPatchInput,
  adminId: string,
): Promise<ExperienceDraftDto> {
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .select("id,input_status,review_status,open_status")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) {
    throw Object.assign(new Error("Draft를 찾을 수 없습니다"), { status: 404 });
  }

  const row = existing as { id: string; input_status: string; review_status: string; open_status: string };

  if (row.open_status === "opened") {
    throw Object.assign(new Error("개설 완료된 항목은 수정할 수 없습니다"), { status: 400 });
  }
  if (row.review_status === "approved") {
    throw Object.assign(new Error("검수 승인된 항목은 수정할 수 없습니다"), { status: 400 });
  }

  const patch: Record<string, unknown> = {};

  if (input.teamId !== undefined) patch.team_id = input.teamId;
  if (input.partName !== undefined) patch.part_name = input.partName;
  if (input.experienceLineMasterId !== undefined) patch.experience_line_master_id = input.experienceLineMasterId;
  if (input.lineCode !== undefined) patch.line_code = input.lineCode;
  if (input.mainTitle !== undefined) patch.main_title = input.mainTitle;
  if (input.outputLink1 !== undefined) patch.output_link_1 = input.outputLink1;
  if (input.outputLink2 !== undefined) patch.output_link_2 = input.outputLink2;
  if (input.outputLinks !== undefined) patch.output_links = input.outputLinks;
  if (input.outputImages !== undefined) patch.output_images = input.outputImages;
  if (input.rating !== undefined) patch.rating = input.rating;
  if (input.memo !== undefined) patch.memo = input.memo;

  if (input.inputStatus !== undefined) {
    patch.input_status = input.inputStatus;

    if (input.inputStatus === "submitted") {
      patch.entered_by = adminId;
      patch.entered_at = new Date().toISOString();
    }

    // rejected → draft/submitted 재제출 시 review_status 리셋
    if (row.review_status === "rejected") {
      patch.review_status = "pending";
      patch.rejection_reason = null;
      patch.reviewed_by = null;
      patch.reviewed_at = null;
    }
  }

  // submitted 상태로 전이 시 필수 항목 검증
  const effectiveInputStatus = (patch.input_status as InputStatus | undefined) ?? row.input_status;
  if (effectiveInputStatus === "submitted") {
    const merged = await getMergedDraftState(id, patch);
    if (!merged.line_code) {
      throw Object.assign(new Error("제출 시 line_code는 필수입니다"), { status: 400 });
    }
    if (!merged.main_title) {
      throw Object.assign(new Error("제출 시 main_title은 필수입니다"), { status: 400 });
    }
    if (merged.rating === null || merged.rating === undefined) {
      throw Object.assign(new Error("제출 시 평점은 필수입니다"), { status: 400 });
    }
    const linkCount = (merged.output_link_1 ? 1 : 0) + (merged.output_link_2 ? 1 : 0);
    const images = Array.isArray(merged.output_images) ? merged.output_images : [];
    const totalAssets = linkCount + images.length;
    if (totalAssets < 1) {
      throw Object.assign(new Error("제출 시 Output을 최소 1개 입력해주세요"), { status: 400 });
    }
    if (totalAssets > 2) {
      throw Object.assign(new Error("Output은 최대 2개까지 입력 가능합니다"), { status: 400 });
    }
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .update(patch)
    .eq("id", id)
    .select(DRAFT_SELECT)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw Object.assign(
        new Error("이미 해당 주차에 동일 사용자·라인 조합의 초안이 존재합니다"),
        { status: 409 },
      );
    }
    throw new Error(error.message);
  }

  const dto = toDraftDto(data as unknown as ExperienceDraftRow);
  // 행동 이력: 이 PATCH 가 제출(submitted)로 전이시킨 경우에만 [개설 신청] 로그(재신청도 행 추가).
  if (input.inputStatus === "submitted") {
    await insertExperienceOpeningLog({
      action: "apply",
      weekId: dto.weekId,
      organizationSlug: dto.organizationSlug,
      actorUserId: adminId,
      teamId: dto.teamId,
      teamName: dto.teamName,
      partName: dto.partName,
      isTeamLevel: false,
      draftId: dto.id,
      targetUserId: dto.targetUserId,
    });
  }
  return dto;
}

async function getMergedDraftState(
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .select("line_code,main_title,rating,output_link_1,output_link_2,output_images")
    .eq("id", id)
    .single();

  if (error) throw new Error(error.message);

  const current = data as Record<string, unknown>;
  return { ...current, ...patch };
}

// ── Review draft ───────────────────────────────────────────

export async function reviewExperienceDraft(
  id: string,
  input: ExperienceDraftReviewInput,
  adminId: string,
): Promise<ExperienceDraftDto> {
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .select("id,input_status,review_status,open_status")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) {
    throw Object.assign(new Error("Draft를 찾을 수 없습니다"), { status: 404 });
  }

  const row = existing as { id: string; input_status: string; review_status: string; open_status: string };

  if (row.input_status !== "submitted") {
    throw Object.assign(new Error("제출 완료 상태의 항목만 검수할 수 있습니다"), { status: 400 });
  }
  if (row.open_status === "opened") {
    throw Object.assign(new Error("이미 개설된 항목은 검수할 수 없습니다"), { status: 400 });
  }

  const patch: Record<string, unknown> = {
    review_status: input.reviewStatus,
    reviewed_by: adminId,
    reviewed_at: new Date().toISOString(),
  };

  if (input.reviewStatus === "rejected") {
    patch.rejection_reason = input.rejectionReason;
  } else {
    patch.rejection_reason = null;
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .update(patch)
    .eq("id", id)
    .select(DRAFT_SELECT)
    .single();

  if (error) throw new Error(error.message);

  const dto = toDraftDto(data as unknown as ExperienceDraftRow);
  // 행동 이력: 승인=[개설 검수], 반려=[검수 반려] (서로 다른 행동). best-effort.
  const reviewAction =
    input.reviewStatus === "approved"
      ? "review"
      : input.reviewStatus === "rejected"
        ? "reject"
        : null;
  if (reviewAction) {
    await insertExperienceOpeningLog({
      action: reviewAction,
      weekId: dto.weekId,
      organizationSlug: dto.organizationSlug,
      actorUserId: adminId,
      teamId: dto.teamId,
      teamName: dto.teamName,
      partName: dto.partName,
      isTeamLevel: false,
      draftId: dto.id,
      targetUserId: dto.targetUserId,
    });
  }
  return dto;
}

// ── Open drafts (최종 개설) ────────────────────────────────
//
// Supabase JS client 는 DB 트랜잭션을 지원하지 않으므로
// 순차적 INSERT + 실패 시 best-effort 정리로 처리한다.
//
// Partial failure 위험:
//   1) cluster4_lines INSERT 성공 후 targets INSERT 실패
//   2) targets INSERT 성공 후 evaluations INSERT 실패
//   3) 위 모두 성공 후 draft UPDATE 실패
//
// 각 단계 실패 시 이전 단계에서 생성한 행을 삭제 시도하지만,
// 정리 실패 시 orphan 행이 남을 수 있다. 이 경우 응답에 경고를 포함한다.
//
// 정책:
//   - 같은 (week_id, experience_line_master_id) → 1개 cluster4_lines
//   - Output은 그룹 내 첫 번째 draft 기준
//   - 그룹 내 Output 불일치 시 경고 로그

export type OpenResult = {
  openedCount: number;
  linesCreated: number;
  targetsCreated: number;
  evaluationsCreated: number;
  results: Array<{
    draftId: string;
    lineId: string;
    targetId: string;
    evaluationId: string | null;
    status: "opened";
  }>;
  warnings: string[];
};

type DraftForOpen = {
  id: string;
  week_id: string;
  organization_slug: string;
  team_id: string | null;
  part_name: string | null;
  target_user_id: string;
  experience_line_master_id: string;
  line_code: string;
  main_title: string;
  output_link_1: string | null;
  output_link_2: string | null;
  output_links: unknown;
  // 레거시 string[] · 신규 [{url,caption}] 혼재 가능 → 개설 미러 시 그대로 전달.
  output_images: unknown;
  rating: number | null;
  review_status: string;
  open_status: string;
  entered_by: string | null;
  entered_at: string | null;
};

export async function openExperienceDrafts(
  draftIds: string[],
  adminId: string,
): Promise<OpenResult> {
  // 1. 대상 draft 조회 및 검증
  const { data: rawDrafts, error: fetchError } = await supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .select(
      "id,week_id,organization_slug,team_id,part_name,target_user_id," +
      "experience_line_master_id,line_code,main_title," +
      "output_link_1,output_link_2,output_links,output_images," +
      "rating,review_status,open_status,entered_by,entered_at",
    )
    .in("id", draftIds);

  if (fetchError) throw new Error(fetchError.message);

  const drafts = (rawDrafts ?? []) as unknown as DraftForOpen[];

  if (drafts.length !== draftIds.length) {
    const found = new Set(drafts.map((d) => d.id));
    const missing = draftIds.filter((id) => !found.has(id));
    throw Object.assign(
      new Error(`Draft를 찾을 수 없습니다: ${missing.join(", ")}`),
      { status: 404 },
    );
  }

  // 모든 draft approved + pending 확인
  for (const d of drafts) {
    if (d.review_status !== "approved") {
      throw Object.assign(
        new Error(`Draft ${d.id}의 검수 상태가 approved가 아닙니다 (${d.review_status})`),
        { status: 400 },
      );
    }
    if (d.open_status !== "pending") {
      throw Object.assign(
        new Error(`Draft ${d.id}는 이미 개설되었습니다`),
        { status: 400 },
      );
    }
  }

  // week_id 동일성 검증
  const weekIds = new Set(drafts.map((d) => d.week_id));
  if (weekIds.size > 1) {
    throw Object.assign(
      new Error("모든 draft의 week_id가 동일해야 합니다"),
      { status: 400 },
    );
  }
  const weekId = drafts[0].week_id;

  // submission window 조회
  const { data: weekRow, error: weekError } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,end_date")
    .eq("id", weekId)
    .single();

  if (weekError || !weekRow) {
    throw Object.assign(
      new Error("주차 정보를 찾을 수 없습니다"),
      { status: 404 },
    );
  }

  const week = weekRow as { id: string; start_date: string; end_date: string };
  const submissionOpensAt = computeSubmissionOpensAt(week.start_date);
  const submissionClosesAt = computeSubmissionClosesAt(week.start_date);

  // 2. (week_id, experience_line_master_id) 기준 그룹핑
  const groups = new Map<string, DraftForOpen[]>();
  for (const d of drafts) {
    const key = `${d.week_id}::${d.experience_line_master_id}`;
    const list = groups.get(key);
    if (list) {
      list.push(d);
    } else {
      groups.set(key, [d]);
    }
  }

  // 3. 그룹별 처리
  const warnings: string[] = [];
  const results: OpenResult["results"] = [];
  const createdLineIds: string[] = [];
  const createdTargetIds: string[] = [];
  const createdEvalIds: string[] = [];

  for (const [, groupDrafts] of groups) {
    const first = groupDrafts[0];

    // Output 불일치 검사
    for (let i = 1; i < groupDrafts.length; i++) {
      const d = groupDrafts[i];
      if (
        d.output_link_1 !== first.output_link_1 ||
        d.output_link_2 !== first.output_link_2 ||
        JSON.stringify(d.output_images) !== JSON.stringify(first.output_images)
      ) {
        warnings.push(
          `라인 ${first.line_code} 그룹 내 Output 불일치: ` +
          `draft ${d.id}의 Output이 첫 번째 draft와 다릅니다. 첫 번째 기준으로 개설합니다.`,
        );
      }
    }

    // cluster4_lines 생성
    const { data: lineRow, error: lineError } = await supabaseAdmin
      .from("cluster4_lines")
      .insert({
        part_type: "experience",
        experience_line_master_id: first.experience_line_master_id,
        line_code: first.line_code,
        main_title: first.main_title,
        team_id: first.team_id,
        output_link_1: first.output_link_1,
        output_link_2: first.output_link_2,
        output_links: resolveOutputLinks(first.output_links, [
          first.output_link_1,
          first.output_link_2,
        ]),
        output_images: first.output_images,
        submission_opens_at: submissionOpensAt,
        submission_closes_at: submissionClosesAt,
        is_active: true,
        // QA 기간(QA_HIDE_REAL_USERS=true) 생성분 표식 — 운영 조회 제외. 기본 false.
        is_qa_test: QA_HIDE_REAL_USERS,
        created_by: adminId,
        updated_by: adminId,
      })
      .select("id")
      .single();

    if (lineError || !lineRow) {
      const msg = lineError?.message ?? "cluster4_lines 생성 실패";
      await rollbackCreatedRows(createdLineIds, createdTargetIds, createdEvalIds);
      throw Object.assign(new Error(msg), { status: 500 });
    }

    const lineId = (lineRow as { id: string }).id;
    createdLineIds.push(lineId);

    // 그룹 내 각 draft에 대해 target + evaluation 생성
    for (const d of groupDrafts) {
      // cluster4_line_targets 생성
      const { data: targetRow, error: targetError } = await supabaseAdmin
        .from("cluster4_line_targets")
        .insert({
          line_id: lineId,
          week_id: d.week_id,
          target_mode: "user",
          target_user_id: d.target_user_id,
          target_rule: {},
          created_by: adminId,
          updated_by: adminId,
        })
        .select("id")
        .single();

      if (targetError || !targetRow) {
        const msg = targetError?.message ?? "cluster4_line_targets 생성 실패";
        await rollbackCreatedRows(createdLineIds, createdTargetIds, createdEvalIds);
        throw Object.assign(new Error(msg), { status: 500 });
      }

      const targetId = (targetRow as { id: string }).id;
      createdTargetIds.push(targetId);

      // evaluation 생성 (rating이 있는 경우)
      let evaluationId: string | null = null;
      if (d.rating !== null && d.rating !== undefined) {
        const { data: evalRow, error: evalError } = await supabaseAdmin
          .from("cluster4_experience_line_evaluations")
          .insert({
            line_target_id: targetId,
            user_id: d.target_user_id,
            rating: d.rating,
            evaluated_by: d.entered_by,
            evaluated_at: d.entered_at,
          })
          .select("id")
          .single();

        if (evalError || !evalRow) {
          const msg = evalError?.message ?? "evaluation 생성 실패";
          warnings.push(`Draft ${d.id}: 평가 생성 실패 — ${msg}. 라인/대상은 생성됨.`);
        } else {
          evaluationId = (evalRow as { id: string }).id;
          createdEvalIds.push(evaluationId);
        }
      }

      // draft 상태 업데이트
      const { error: updateError } = await supabaseAdmin
        .from("cluster4_experience_line_drafts")
        .update({
          open_status: "opened",
          opened_line_id: lineId,
          opened_by: adminId,
          opened_at: new Date().toISOString(),
        })
        .eq("id", d.id);

      if (updateError) {
        warnings.push(
          `Draft ${d.id}: 라인/대상 생성 완료되었으나 draft 상태 업데이트 실패 — ${updateError.message}`,
        );
      }

      results.push({
        draftId: d.id,
        lineId,
        targetId,
        evaluationId,
        status: "opened",
      });
    }
  }

  // 개설로 라인/타깃/평가가 생성되어 대상자들의 주차 카드(가용 라인·평점)가 바뀐다 → 즉시 재계산.
  // ≤10 즉시 / >10 background(after) — 저장 직후 고객 반영(평점→강화/주차인정). best-effort.
  const affectedUsers = new Set(drafts.map((d) => d.target_user_id));
  for (const lineId of createdLineIds) {
    for (const userId of await collectLineOrgAudience(lineId).catch(() => [])) {
      affectedUsers.add(userId);
    }
  }
  await invalidateWeeklyCardsForUsers(Array.from(affectedUsers));

  // 행동 이력: 개설된 draft 마다 [개설 완료] 로그(재완료 시 행 추가 = 덮어쓰기 금지). best-effort.
  const draftById = new Map(drafts.map((d) => [d.id, d]));
  for (const r of results) {
    const d = draftById.get(r.draftId);
    if (!d) continue;
    await insertExperienceOpeningLog({
      action: "open",
      weekId: d.week_id,
      organizationSlug: d.organization_slug,
      actorUserId: adminId,
      teamId: d.team_id,
      partName: d.part_name,
      isTeamLevel: false,
      draftId: d.id,
      targetUserId: d.target_user_id,
    });
  }

  return {
    openedCount: results.length,
    linesCreated: createdLineIds.length,
    targetsCreated: createdTargetIds.length,
    evaluationsCreated: createdEvalIds.length,
    results,
    warnings,
  };
}

// ── Workflow summary ───────────────────────────────────────

export type WorkflowSummary = {
  weekId: string;
  totalDrafts: number;
  draftCount: number;
  submittedCount: number;
  approvedCount: number;
  rejectedCount: number;
  openedCount: number;
};

export async function getExperienceWorkflowSummary(
  weekId: string,
  organizationSlug?: string | null,
  mode: ScopeMode = "operating",
): Promise<WorkflowSummary> {
  let query = supabaseAdmin
    .from("cluster4_experience_line_drafts")
    .select("target_user_id,input_status,review_status,open_status")
    .eq("week_id", weekId);

  if (organizationSlug) {
    query = query.eq("organization_slug", organizationSlug);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const scope = await resolveUserScope(mode, null);
  const rows = ((data ?? []) as Array<{
    target_user_id: string;
    input_status: string;
    review_status: string;
    open_status: string;
  }>).filter((row) => scope.includes(row.target_user_id));

  let draftCount = 0;
  let submittedCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let openedCount = 0;

  for (const r of rows) {
    if (r.open_status === "opened") {
      openedCount++;
    } else if (r.review_status === "approved") {
      approvedCount++;
    } else if (r.review_status === "rejected") {
      rejectedCount++;
    } else if (r.input_status === "submitted") {
      submittedCount++;
    } else {
      draftCount++;
    }
  }

  return {
    weekId,
    totalDrafts: rows.length,
    draftCount,
    submittedCount,
    approvedCount,
    rejectedCount,
    openedCount,
  };
}

// ── Helpers ────────────────────────────────────────────────

// KST = UTC+9. 주 시작일(월요일) 00:00 KST 기준 submission open.
function computeSubmissionOpensAt(weekStartDate: string): string {
  const ms = Date.UTC(
    +weekStartDate.slice(0, 4),
    +weekStartDate.slice(5, 7) - 1,
    +weekStartDate.slice(8, 10),
  );
  return new Date(ms - 9 * 3600_000).toISOString();
}

// 수요일 22:00 KST 기준 submission close.
function computeSubmissionClosesAt(weekStartDate: string): string {
  const ms = Date.UTC(
    +weekStartDate.slice(0, 4),
    +weekStartDate.slice(5, 7) - 1,
    +weekStartDate.slice(8, 10),
  );
  const wednesdayMs = ms + 2 * 86_400_000;
  return new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString();
}

// Best-effort rollback: 생성된 행을 역순으로 삭제 시도.
// 삭제 실패 시 콘솔 경고만 남기고 진행.
async function rollbackCreatedRows(
  lineIds: string[],
  targetIds: string[],
  evalIds: string[],
): Promise<void> {
  for (const id of evalIds) {
    const { error } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations")
      .delete()
      .eq("id", id);
    if (error) console.error(`[openExperienceDrafts rollback] eval ${id}:`, error.message);
  }

  for (const id of targetIds) {
    const { error } = await supabaseAdmin
      .from("cluster4_line_targets")
      .delete()
      .eq("id", id);
    if (error) console.error(`[openExperienceDrafts rollback] target ${id}:`, error.message);
  }

  for (const id of lineIds) {
    const { error } = await supabaseAdmin
      .from("cluster4_lines")
      .delete()
      .eq("id", id);
    if (error) console.error(`[openExperienceDrafts rollback] line ${id}:`, error.message);
  }
}
