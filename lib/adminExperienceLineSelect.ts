// 실무 경험(experience) — 회원 상세 팝업의 "오픈+비대상(강화 실패) 슬롯 → 강화 성공(라인 선택)" 흐름.
//
// 정책(2026-07-17 확정): 실무 경험 유형이 클럽에서 오픈됐으나 본인이 대상자가 아니면 그 유형 슬롯은
//   "강화 실패"로 표시된다(라인명 "-"). 관리자가 이를 강화 성공으로 바꾸려면 해당 유형(도출/분석/견문/
//   관리/확장)의 라인을 직접 선택해야 한다. 선택 즉시 **그 크루 전용** cluster4_lines(experience)
//   인스턴스 + cluster4_line_targets(user) + cluster4_experience_line_evaluations(rating>=4)를 만들어
//   강화 성공으로 수렴시킨다(역량 라인 선택 흐름의 experience 아날로그).
//   ⚠ 타인의 라인 인스턴스를 대표값으로 재사용하지 않는다 — 새 인스턴스만 생성한다.
//   지급/집계/2차 기입/snapshot 수렴은 라인 저장과 동일 SoT(reconcile + recompute).
//
// 옵션 원천 = /admin/lines/register 원장(line_registrations, hub=experience)에서 유형이 일치하는
//   활성 라인(org + 공통). value = bridged_master_id = cluster4_experience_line_masters.id.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import {
  reconcileLineResultAwardForUser,
  recomputeWeeklyPointsForUsers,
} from "@/lib/processPointAccrual";
import { refreshWeeklyCardsSnapshotSafe } from "@/lib/cluster4WeeklyCardsSnapshot";
import { recomputeDerivedAfterActMutation } from "@/lib/crewWeekGrowthRejudge";
import { adminWeekStatusLabel } from "@/lib/adminCrewWeeklyResults";
import { EXPERIENCE_OVERALL_CATEGORIES } from "@/lib/experienceTeamOverallTypes";
import { resolveExperienceTypeLabel } from "@/lib/adminLineHistoryType";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import type { Cluster4ExperienceCategory } from "@/shared/cluster4.contracts";

// 성공 대표 평점(>=4). 저장 후 관리자가 팝업 평점 드롭다운으로 세부 조정 가능.
const EXPERIENCE_SUCCESS_RATING = 7;

const CATEGORY_TO_KO_LINE_TYPE = new Map<Cluster4ExperienceCategory, string>(
  EXPERIENCE_OVERALL_CATEGORIES.map((c) => [c.key as Cluster4ExperienceCategory, c.koLineType]),
);

function isValidCategory(c: string): c is Cluster4ExperienceCategory {
  return CATEGORY_TO_KO_LINE_TYPE.has(c as Cluster4ExperienceCategory);
}

export type ExperienceMasterOption = {
  masterId: string; // cluster4_experience_line_masters.id (= registration.bridged_master_id)
  lineCode: string | null;
  lineName: string;
};

async function resolveCrewOrg(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("user_profiles")
    .select("organization_slug")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
}

function isMasterOrgVisible(masterOrg: string | null, crewOrg: string | null): boolean {
  if (masterOrg == null || masterOrg === "common") return true;
  return masterOrg === crewOrg;
}

export type ExperienceLineOptionsResult =
  | { ok: true; category: Cluster4ExperienceCategory; label: string; options: ExperienceMasterOption[] }
  | { ok: false; reason: "member_not_found" | "week_not_found" | "invalid_category" };

// 선택 가능한 경험 라인 옵션(해당 유형·org+공통·활성). register 원장(bridged_master_id) 기준.
export async function listExperienceLineOptionsForCategory(
  legacyUserId: string,
  weekId: string,
  category: string,
): Promise<ExperienceLineOptionsResult> {
  if (!isValidCategory(category)) return { ok: false, reason: "invalid_category" };
  const resolved = await resolveCrewWeekCard(legacyUserId, weekId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const org = await resolveCrewOrg(resolved.crew.userId);
  const koLineType = CATEGORY_TO_KO_LINE_TYPE.get(category)!;

  let query = supabaseAdmin
    .from("line_registrations")
    .select("line_code,line_name,organization_slug,bridged_master_id")
    .eq("hub", "experience")
    .eq("is_active", true)
    .eq("line_type", koLineType)
    .not("bridged_master_id", "is", null)
    .order("line_code", { ascending: true });
  // 조직 스코프 = 그 조직 + 공통('common'). 라인 등록 목록·개설 후보와 동일 기준.
  //   ⚠ 종전에는 "공통 = organization_slug IS NULL" 로 봐서 'common' 슬러그 행을 제외했다.
  //     소속 클럽 필수화(2026-07-13) 이후 NULL 행은 0건이라 공통 라인만 통째로 누락됐다.
  //   org 미상이면 옵션을 만들지 않는다(교차 조직 노출 방지 — 종전 `.is(null)` 과 동일 결과).
  if (!org) {
    return { ok: true, category, label: resolveExperienceTypeLabel(category) ?? category, options: [] };
  }
  query = query.in("organization_slug", [org, "common"]);

  const { data, error } = await query;
  if (error) {
    console.warn("[experienceLineSelect] 옵션 조회 실패", error.message);
    return { ok: true, category, label: resolveExperienceTypeLabel(category) ?? category, options: [] };
  }
  const seen = new Set<string>();
  const options: ExperienceMasterOption[] = [];
  for (const r of (data ?? []) as Array<{
    line_code: string | null;
    line_name: string;
    bridged_master_id: string;
  }>) {
    if (seen.has(r.bridged_master_id)) continue; // org+공통 중복 방지
    seen.add(r.bridged_master_id);
    options.push({ masterId: r.bridged_master_id, lineCode: r.line_code, lineName: r.line_name });
  }
  return { ok: true, category, label: resolveExperienceTypeLabel(category) ?? category, options };
}

export type CreateExperienceLineResult =
  | { ok: true; lineId: string; lineTargetId: string }
  | {
      ok: false;
      code: 400 | 404 | 409 | 422;
      error: string;
      growth?: { beforeLabel: string; afterLabel: string };
    };

// 강화 성공 저장 = 선택 마스터로 이 크루 전용 경험 라인 인스턴스 + target + 평점(>=4) 생성 → 성공 수렴.
//   성장 결과 flip 미리보기: 생성 → 재계산 → flip 확인 → 미확인이면 생성분 롤백 후 409(competency 동형).
export async function createExperienceSuccessLine(
  legacyUserId: string,
  weekId: string,
  masterId: string,
  category: string,
  adminUserId: string,
  confirmGrowthFlip: boolean,
): Promise<CreateExperienceLineResult> {
  if (!isValidCategory(category)) {
    return { ok: false, code: 422, error: "알 수 없는 실무 경험 유형입니다." };
  }
  const resolved = await resolveCrewWeekCard(legacyUserId, weekId);
  if (!resolved.ok) {
    return {
      ok: false,
      code: 404,
      error: resolved.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew",
    };
  }
  const { crew, card } = resolved;
  const userId = crew.userId;
  const beforeStatus = card.userWeekStatus;

  if (!isCrewWeekEditable(card.userWeekStatus)) {
    return { ok: false, code: 409, error: "성장 결과가 확정된 이후에만 수정할 수 있습니다." };
  }

  const org = await resolveCrewOrg(userId);
  const { data: masterRow } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .select("id,line_code,line_name,default_main_title,experience_category,is_active,organization_slug")
    .eq("id", masterId)
    .maybeSingle();
  const master = masterRow as {
    id: string;
    line_code: string | null;
    line_name: string;
    default_main_title: string | null;
    experience_category: string | null;
    is_active: boolean;
    organization_slug: string | null;
  } | null;
  if (!master || !master.is_active) {
    return { ok: false, code: 422, error: "비활성이거나 존재하지 않는 실무 경험 라인입니다." };
  }
  if (master.experience_category !== category) {
    return { ok: false, code: 422, error: "선택한 라인의 유형이 슬롯 유형과 일치하지 않습니다." };
  }
  if (!isMasterOrgVisible(master.organization_slug, org)) {
    return { ok: false, code: 422, error: "이 조직에 적용되지 않는 실무 경험 라인입니다." };
  }

  // 이미 이 마스터로 배정돼 있으면 중복 생성 방지(본인 주차 target 라인 중 동일 master).
  const { data: userTargets } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("line_id")
    .eq("week_id", weekId)
    .eq("target_mode", "user")
    .eq("target_user_id", userId);
  const tgtLineIds = ((userTargets ?? []) as Array<{ line_id: string }>).map((t) => t.line_id);
  if (tgtLineIds.length > 0) {
    const { data: assignedLines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .in("id", tgtLineIds)
      .eq("experience_line_master_id", masterId);
    if (((assignedLines ?? []) as Array<{ id: string }>).length > 0) {
      return { ok: false, code: 409, error: "이미 이 회원에게 배정된 실무 경험 라인입니다." };
    }
  }

  const nowIso = new Date().toISOString();
  const mainTitle = master.default_main_title?.trim() || master.line_name.trim() || master.line_name;

  // 새 인스턴스 — 공용 원천만(마스터 title/line_code). team_id=null → 타 크루 Step2 phantom 미노출,
  //   본인은 Step1(본인 target)로 표시. 마감은 과거로 둬 대상자+평점>=4 → 강화 성공 파생.
  const { data: lineRow, error: lineErr } = await supabaseAdmin
    .from("cluster4_lines")
    .insert({
      part_type: "experience",
      experience_line_master_id: master.id,
      team_id: null,
      line_code: master.line_code,
      main_title: mainTitle,
      output_link_1: null,
      output_links: [],
      output_images: [],
      submission_opens_at: card.startDate ?? nowIso,
      submission_closes_at: card.startDate ?? nowIso,
      is_active: true,
      is_qa_test: QA_HIDE_REAL_USERS,
      created_by: adminUserId,
      updated_by: adminUserId,
    })
    .select("id")
    .single();
  if (lineErr || !lineRow) {
    return { ok: false, code: 422, error: "실무 경험 라인 생성에 실패했습니다." };
  }
  const lineId = (lineRow as { id: string }).id;

  const { data: tgtRow, error: tgtErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .insert({
      line_id: lineId,
      week_id: weekId,
      target_mode: "user",
      target_user_id: userId,
      target_rule: {},
      created_by: adminUserId,
      updated_by: adminUserId,
    })
    .select("id")
    .single();
  if (tgtErr || !tgtRow) {
    await supabaseAdmin.from("cluster4_lines").delete().eq("id", lineId);
    return { ok: false, code: 422, error: "대상자 배정에 실패했습니다." };
  }
  const lineTargetId = (tgtRow as { id: string }).id;

  // 평점(>=4) 저장 → 강화 성공 파생(experience 성공 = rating>=4). 관리자가 이후 세부 조정 가능.
  const { error: evalErr } = await supabaseAdmin
    .from("cluster4_experience_line_evaluations")
    .insert({
      line_target_id: lineTargetId,
      user_id: userId,
      rating: EXPERIENCE_SUCCESS_RATING,
      evaluated_by: adminUserId,
      evaluated_at: nowIso,
    });
  if (evalErr) {
    await supabaseAdmin.from("cluster4_line_targets").delete().eq("id", lineTargetId);
    await supabaseAdmin.from("cluster4_lines").delete().eq("id", lineId);
    return { ok: false, code: 422, error: "평점 저장에 실패했습니다." };
  }

  const rollback = async () => {
    try {
      await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").eq("ref_id", lineId).eq("user_id", userId);
    } catch {
      /* best-effort */
    }
    await supabaseAdmin.from("cluster4_experience_line_evaluations").delete().eq("line_target_id", lineTargetId);
    await supabaseAdmin.from("cluster4_line_targets").delete().eq("id", lineTargetId);
    await supabaseAdmin.from("cluster4_lines").delete().eq("id", lineId);
    try {
      await refreshWeeklyCardsSnapshotSafe(userId);
    } catch {
      /* best-effort */
    }
  };

  // 성장 결과 flip 미리보기.
  try {
    await refreshWeeklyCardsSnapshotSafe(userId);
  } catch {
    /* best-effort */
  }
  const re = await resolveCrewWeekCard(legacyUserId, weekId);
  const afterStatus = re.ok ? re.card.userWeekStatus : beforeStatus;
  const isFlip =
    (beforeStatus === "success" || beforeStatus === "fail") &&
    (afterStatus === "success" || afterStatus === "fail") &&
    beforeStatus !== afterStatus;
  if (isFlip && !confirmGrowthFlip) {
    await rollback();
    return {
      ok: false,
      code: 409,
      error: "GROWTH_STATUS_WILL_CHANGE",
      growth: { beforeLabel: adminWeekStatusLabel(beforeStatus), afterLabel: adminWeekStatusLabel(afterStatus) },
    };
  }

  // 지급 + 최종 수렴(대상자 배정 + 강화 성공 → A/B 지급 → uwp 합산 → 등급 → snapshot → 카드/크루).
  try {
    await reconcileLineResultAwardForUser(userId, lineId, weekId, true, adminUserId);
  } catch (e) {
    console.warn("[experienceLineSelect] 라인 지급 reconcile 실패(격리)", {
      userId,
      lineId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    await recomputeWeeklyPointsForUsers([userId], weekId);
  } catch {
    /* best-effort — cron 재계산 */
  }
  // 주차 성장 결과(user_week_statuses) 재판정 — 라인 저장 §5.5 와 동일 계약.
  try {
    await recomputeDerivedAfterActMutation({ userId, weekId });
  } catch (e) {
    console.warn("[experienceLineSelect] uws 재판정/파생 재계산 실패(best-effort)", {
      userId,
      weekId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  return { ok: true, lineId, lineTargetId };
}
