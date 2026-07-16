// 실무 역량(competency) — 회원 상세 팝업의 "강화 실패 placeholder → 강화 성공(라인 선택)" 흐름.
//
// 정책(2026-07-16 확정, 판정 SoT = 실제 대상자 배정):
//   실무 역량은 강화 실패 상태에서 특정 라인명이 없어 표에 "라인명: -" placeholder 로 뜬다.
//   관리자가 이를 강화 성공으로 바꾸려면 "성공으로 인정할 역량 활동(마스터)"을 직접 선택해야 한다.
//   선택 즉시 **그 크루 전용** cluster4_lines 인스턴스를 새로 만들고(승인 개설 흐름과 동일 원천:
//   마스터 main_title + 주차 공용 링크) + cluster4_line_targets(user) 를 생성 → 대상자 배정 = 성공.
//   ⚠ 다른 크루의 output_link_2(제출)·이미지·개인 링크는 절대 공유/복제하지 않는다(빈 값으로 시작).
//   지급/집계/2차 기입/snapshot 수렴은 라인 저장(reconcileLineResultAwardForUser +
//   recomputeWeeklyPointsForUsers)과 동일 SoT 를 재사용한다.
//
// 드롭다운 원천 = 해당 (주차, 조직)에서 "개설된" 역량 활동 마스터
//   = cluster4_competency_applications(resolution='opened', week_id, organization_slug) 의 마스터 집합.
//   이미 이 크루에게 배정된 마스터는 제외한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import {
  reconcileLineResultAwardForUser,
  recomputeWeeklyPointsForUsers,
} from "@/lib/processPointAccrual";
import { refreshWeeklyCardsSnapshotSafe } from "@/lib/cluster4WeeklyCardsSnapshot";
import { recomputeDerivedAfterActMutation } from "@/lib/crewWeekGrowthRejudge";
import { adminWeekStatusLabel } from "@/lib/adminCrewWeeklyResults";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";

export type CompetencyMasterOption = {
  masterId: string;
  lineCode: string | null;
  lineName: string;
  mainTitle: string | null;
  // 선택 시 미리보기(선택한 라인 기존 원천 — 새로 추정/복제 아님).
  previewLink: string | null; // 주차 공용 링크(개설된 라인 output_link_1)
  previewImage: string | null; // 역량 라인 이미지 원천(현재 정책상 대개 없음)
};

type WeekCommonContent = {
  link: string | null;
  image: string | null;
  opensAt: string | null;
  closesAt: string | null;
};

async function resolveCrewOrg(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("user_profiles")
    .select("organization_slug")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
}

// 이 (주차, org)에 개설된 역량 라인 하나에서 주차 공용 콘텐츠(링크·이미지·제출 창)를 가져온다.
//   승인 개설이 만든 라인들은 output_link_1(카페 공용글)·제출 창을 공유하므로 표본 1개로 충분하다.
async function loadWeekCommonContent(
  weekId: string,
  openedLineIds: string[],
): Promise<WeekCommonContent> {
  if (openedLineIds.length === 0) return { link: null, image: null, opensAt: null, closesAt: null };
  const { data } = await supabaseAdmin
    .from("cluster4_lines")
    .select("output_link_1,output_images,submission_opens_at,submission_closes_at")
    .in("id", openedLineIds)
    .eq("is_active", true)
    .limit(50);
  const rows = (data ?? []) as Array<{
    output_link_1: string | null;
    output_images: unknown;
    submission_opens_at: string | null;
    submission_closes_at: string | null;
  }>;
  const withLink = rows.find((r) => r.output_link_1) ?? rows[0] ?? null;
  const firstImg = rows
    .map((r) => (Array.isArray(r.output_images) ? r.output_images[0] : null))
    .find(Boolean) as { url?: string } | string | null | undefined;
  const image =
    typeof firstImg === "string" ? firstImg : (firstImg && firstImg.url) || null;
  return {
    link: withLink?.output_link_1 ?? null,
    image: image ?? null,
    opensAt: withLink?.submission_opens_at ?? null,
    closesAt: withLink?.submission_closes_at ?? null,
  };
}

// (주차, org) 에 개설된 역량 활동 마스터 id 집합 + 그 개설 라인 id 들. applications(opened) SoT.
async function loadOpenedCompetencyMasters(
  weekId: string,
  org: string | null,
): Promise<{ masterIds: string[]; openedLineIds: string[] }> {
  let q = supabaseAdmin
    .from("cluster4_competency_applications")
    .select("competency_line_master_id,opened_line_id")
    .eq("resolution", "opened")
    .eq("week_id", weekId);
  if (org) q = q.eq("organization_slug", org);
  const { data } = await q;
  const rows = (data ?? []) as Array<{
    competency_line_master_id: string | null;
    opened_line_id: string | null;
  }>;
  const masterIds = Array.from(
    new Set(rows.map((r) => r.competency_line_master_id).filter((x): x is string => Boolean(x))),
  );
  const openedLineIds = Array.from(
    new Set(rows.map((r) => r.opened_line_id).filter((x): x is string => Boolean(x))),
  );
  return { masterIds, openedLineIds };
}

// 이 크루가 이 주차에 이미 배정된 역량 마스터 집합(중복 배정 제외용).
async function loadCrewAssignedCompetencyMasters(userId: string, weekId: string): Promise<Set<string>> {
  const { data: tgts } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("line_id")
    .eq("week_id", weekId)
    .eq("target_user_id", userId)
    .eq("target_mode", "user");
  const lineIds = ((tgts ?? []) as Array<{ line_id: string }>).map((t) => t.line_id);
  if (lineIds.length === 0) return new Set();
  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("competency_line_master_id")
    .in("id", lineIds)
    .eq("part_type", "competency");
  return new Set(
    ((lines ?? []) as Array<{ competency_line_master_id: string | null }>)
      .map((l) => l.competency_line_master_id)
      .filter((x): x is string => Boolean(x)),
  );
}

export type CompetencyOptionsResult =
  | { ok: true; options: CompetencyMasterOption[] }
  | { ok: false; reason: "member_not_found" | "week_not_found" };

// 드롭다운 옵션: (주차, org) 개설된 역량 활동 마스터 − 이미 배정된 것. 각 옵션에 미리보기 콘텐츠 부착.
export async function listCompetencyMasterOptionsForWeek(
  legacyUserId: string,
  weekId: string,
): Promise<CompetencyOptionsResult> {
  const resolved = await resolveCrewWeekCard(legacyUserId, weekId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { crew } = resolved;
  const org = await resolveCrewOrg(crew.userId);

  const { masterIds, openedLineIds } = await loadOpenedCompetencyMasters(weekId, org);
  if (masterIds.length === 0) return { ok: true, options: [] };

  const [{ data: masters }, assigned, common] = await Promise.all([
    supabaseAdmin
      .from("cluster4_competency_line_masters")
      .select("id,line_code,line_name,main_title,is_active")
      .in("id", masterIds),
    loadCrewAssignedCompetencyMasters(crew.userId, weekId),
    loadWeekCommonContent(weekId, openedLineIds),
  ]);

  const options: CompetencyMasterOption[] = ((masters ?? []) as Array<{
    id: string;
    line_code: string | null;
    line_name: string;
    main_title: string | null;
    is_active: boolean;
  }>)
    .filter((m) => m.is_active && !assigned.has(m.id))
    .map((m) => ({
      masterId: m.id,
      lineCode: m.line_code,
      lineName: m.line_name,
      mainTitle: m.main_title,
      previewLink: common.link,
      previewImage: common.image,
    }))
    .sort((a, b) => (a.lineCode ?? "").localeCompare(b.lineCode ?? "", "ko"));

  return { ok: true, options };
}

export type CreateCompetencyLineResult =
  | { ok: true; lineId: string; lineTargetId: string }
  | {
      ok: false;
      code: 400 | 404 | 409 | 422;
      error: string;
      growth?: { beforeLabel: string; afterLabel: string };
    };

// 강화 성공 저장 = 선택한 마스터로 이 크루 전용 역량 라인 인스턴스 + target 생성 → 성공 수렴.
//   성장 결과 flip 미리보기: 생성 → 재계산 → flip 확인 → 미확인이면 생성분 롤백 후 409.
export async function createCompetencySuccessLine(
  legacyUserId: string,
  weekId: string,
  masterId: string,
  adminUserId: string,
  confirmGrowthFlip: boolean,
): Promise<CreateCompetencyLineResult> {
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
  const { masterIds, openedLineIds } = await loadOpenedCompetencyMasters(weekId, org);
  if (!masterIds.includes(masterId)) {
    return { ok: false, code: 422, error: "이 주차·조직에서 개설된 실무 역량 라인이 아닙니다." };
  }
  const assigned = await loadCrewAssignedCompetencyMasters(userId, weekId);
  if (assigned.has(masterId)) {
    return { ok: false, code: 409, error: "이미 이 회원에게 배정된 실무 역량 라인입니다." };
  }

  const { data: masterRow } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .select("id,line_code,line_name,main_title,is_active")
    .eq("id", masterId)
    .maybeSingle();
  const master = masterRow as {
    id: string;
    line_code: string | null;
    line_name: string;
    main_title: string | null;
    is_active: boolean;
  } | null;
  if (!master || !master.is_active) {
    return { ok: false, code: 422, error: "비활성이거나 존재하지 않는 실무 역량 라인입니다." };
  }

  const common = await loadWeekCommonContent(weekId, openedLineIds);
  const mainTitle = master.main_title?.trim() || master.line_name.trim() || master.line_name;
  const nowIso = new Date().toISOString();
  const outputLinks = common.link ? [{ url: common.link, label: "" }] : [];

  // 새 인스턴스 생성 — 공용 원천만(마스터 title/line_code + 주차 공용 링크/제출창). 타 크루 제출·이미지 미복제.
  const { data: lineRow, error: lineErr } = await supabaseAdmin
    .from("cluster4_lines")
    .insert({
      part_type: "competency",
      competency_line_master_id: master.id,
      line_code: master.line_code,
      main_title: mainTitle,
      output_link_1: common.link,
      output_link_2: null,
      output_links: outputLinks,
      output_images: [],
      submission_opens_at: common.opensAt ?? nowIso,
      submission_closes_at: common.closesAt ?? nowIso,
      is_active: true,
      is_qa_test: QA_HIDE_REAL_USERS,
      created_by: adminUserId,
      updated_by: adminUserId,
    })
    .select("id")
    .single();
  if (lineErr || !lineRow) {
    return { ok: false, code: 422, error: "실무 역량 라인 생성에 실패했습니다." };
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

  const rollback = async () => {
    try {
      await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").eq("ref_id", lineId).eq("user_id", userId);
    } catch {
      /* best-effort */
    }
    await supabaseAdmin.from("cluster4_line_targets").delete().eq("id", lineTargetId);
    await supabaseAdmin.from("cluster4_lines").delete().eq("id", lineId);
    try {
      await refreshWeeklyCardsSnapshotSafe(userId);
    } catch {
      /* best-effort */
    }
  };

  // 성장 결과 flip 미리보기 — 배정으로 주차 결과가 바뀌는지 재계산해 확인.
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
    console.warn("[competencyLineSelect] 라인 지급 reconcile 실패(격리)", {
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

  // 주차 성장 결과(user_week_statuses) 재판정 — 역량 라인 배정이 earned 를 바꾸므로 uwp 재집계 후 커밋.
  //   (라인 저장 경로 §5.5 와 동일 계약: rejudge → snapshot → 성장 통계 → 품계. best-effort.)
  //   raw user_week_statuses 를 라이브로 읽는 크루 페이지 이력서 카드·위클리 랭킹·cluster-4-ranking 수렴.
  try {
    await recomputeDerivedAfterActMutation({ userId, weekId });
  } catch (e) {
    console.warn("[competencyLineSelect] uws 재판정/파생 재계산 실패(best-effort)", {
      userId,
      weekId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  return { ok: true, lineId, lineTargetId };
}
