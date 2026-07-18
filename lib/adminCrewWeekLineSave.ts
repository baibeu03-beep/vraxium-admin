import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import {
  getCrewWeekLineDetail,
  type AdminCrewWeekLineDetailDto,
} from "@/lib/adminCrewWeekLineDetail";
import {
  writeSecondEntryOverride,
  isSecondEntryOverrideAllowed,
} from "@/lib/cluster4SecondEntryOverride";
import { upsertCareerEvaluation } from "@/lib/adminCareerEvaluationsData";
import { outputLinksToLegacySlots } from "@/lib/cluster4OutputLinks";
import {
  splitImageSlots,
  IMAGE_SLOT_COUNT,
  type Cluster4ImageSlot,
  type Cluster4OutputImage,
} from "@/lib/cluster4OutputImages";
import {
  refreshWeeklyCardsSnapshotSafe,
  markWeeklyCardsSnapshotStaleMany,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  reconcileLineResultAwardForUser,
  recomputeWeeklyPointsForUsers,
} from "@/lib/processPointAccrual";
import { recomputeDerivedAfterActMutation } from "@/lib/crewWeekGrowthRejudge";
import { repointCompetencyLineMaster } from "@/lib/adminCompetencyLineSelect";
import { adminWeekStatusLabel } from "@/lib/adminCrewWeeklyResults";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import type { CareerGrade } from "@/lib/careerGrade";
import type { Cluster4EnhancementStatus, Cluster4OutputLink } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 관리자 라인 상세 저장. 판정 정책(2026-07-16 확정):
//   클럽 오픈 + 대상자        = 강화 성공
//   클럽 오픈 + 대상자 아님    = 강화 실패
//   클럽 미오픈               = 해당 없음  (← 클럽 전체 데이터, 이 화면에서 변경 불가)
//
// 따라서 강화 결과 레버 = **실제 cluster4_line_targets 배정 상태**(표시 override 아님):
//   · 실패 → 성공: 해당 회원의 target(target_mode='user') 을 생성(배정).
//   · 성공 → 실패: 해당 회원의 target 을 해제(+ 종속 eval/submission 삭제).
//   · 경험=평점, 경력=등급은 성공 시 대상자 배정과 함께 파생값이 성공이 되도록 함께 저장한다.
//   · info/competency 는 배정 자체가 성공 신호 — 별도 표시 override 를 만들지 않는다(기존 경로 제거).
//
// 원칙:
//   · 쓰기 대상 = targets / experience evals / career evals / submissions / **라인 레벨 아웃풋 이미지
//     운영진 슬롯(cluster4_lines.output_images ≤1)**.  Main Title·허브·라인명·라인코드·실무자·라인마스터는
//     절대 쓰지 않는다(allowlist). 클럽 오픈 여부(라인 존재)도 안 바꾼다.
//   · 이미지 = 예약 슬롯 모델(2026-07-18): 슬롯 0=운영진(라인 레벨), 슬롯 1..3=크루(제출). 두 출처에 각자
//     저장해 슬롯 순서를 무손실 보존한다. 운영진 슬롯 변경은 클럽 공용이라 같은 라인 타 크루 snapshot 을 무효화.
//   · 성공 상태의 제출 데이터(A)는 결과가 실패면 "쓰지 않음"으로 보존(삭제/빈값 금지).
//   · 성장 결과 변경 미리보기: 레버 쓰기 → 재계산 → 주차 성장 결과 flip 확인 → 미확인이면 전체 롤백 후
//     409(실제 재계산 로직 그대로 재사용 — 분기 없는 정확성). 확인(confirmGrowthFlip) 시 유지.
//   · 결과가 success 가 아니게 되면 이 라인의 2차 기입 수동 허용 override 를 자동 회수(§5).
//   · 저장 후 lineTargetId·enhancementStatus·라인 A/B·2차 기입 자격·성공/실패 집계·주차 성장률/결과·
//     주차 포인트/품계·위클리 랭킹·snapshot·DTO 가 단일 수렴(recomputeWeeklyPointsForUsers)으로 정합.
// ─────────────────────────────────────────────────────────────────────

const MAX_LINKS = 5;
const HTTP_RE = /^https?:\/\//i;
const OVERRIDE_TABLE = "cluster4_line_enhancement_overrides";
const EXP_EVAL_TABLE = "cluster4_experience_line_evaluations";
const CAREER_EVAL_TABLE = "cluster4_career_line_evaluations";
const SUBMISSION_TABLE = "cluster4_line_submissions";
const TARGET_TABLE = "cluster4_line_targets";

export type SaveLineDetailInput = {
  enhancementStatus: Cluster4EnhancementStatus; // 드롭다운 결과 레버(모든 허브 공통 SoT)
  // 실무 역량 전용 — 라인명 변경(마스터 repoint). 지정 시 강화 성공 상태에서 이 라인의 마스터를 교체한다.
  //   그 외 허브/미지정/현재값과 동일 시 무시. 라인 identity(라인명/코드/유형)만 마스터에서 파생 갱신하고
  //   제출/평점/아웃풋/성장 포인트/지급 등 나머지 값은 그대로 보존한다.
  competencyMasterId?: string | null;
  statusData: {
    subTitle: string | null;
    growthPoint: string | null;
    outputLinks: { url: string; label: string | null }[];
    // 예약 슬롯 이미지(2026-07-18): 고정 4슬롯. 슬롯 0=운영진(라인 레벨,≤1), 슬롯 1..3=크루(제출).
    //   빈 슬롯=null(위치 보존). 미제공(undefined) 시 기존 이미지 보존. [[cluster4OutputImages]]
    imageSlots?: Cluster4ImageSlot[];
    rating: number | null; // 경험
    grade?: CareerGrade | null; // 경력
  };
};

export type SaveLineDetailResult =
  // data=null: 실무 역량 성공→실패처럼 저장 후 그 라인이 이 크루 카드에서 사라진 경우(대상자 해제 +
  //   관리자 생성 인스턴스 정리). 저장은 성공이며 프론트는 요약을 재조회한다.
  | { ok: true; data: AdminCrewWeekLineDetailDto | null }
  | {
      ok: false;
      code: 400 | 404 | 409 | 422;
      error: string;
      growth?: { beforeLabel: string; afterLabel: string };
    };

function normLinks(links: { url: string; label: string | null }[]): Cluster4OutputLink[] {
  return links
    .filter((l) => l.url && l.url.trim())
    .slice(0, MAX_LINKS)
    .map((l) => ({ url: l.url.trim(), label: (l.label ?? "").trim() || null }));
}
function linksEqual(a: Cluster4OutputLink[], b: Cluster4OutputLink[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.url === (b[i]?.url ?? "") && (x.label ?? null) === (b[i]?.label ?? null));
}
// 성장 결과 flip = 둘 다 성공/실패이고 서로 다를 때(휴식/진행/집계 상태는 flip 아님).
function isGrowthFlip(a: string, b: string): boolean {
  return (a === "success" || a === "fail") && (b === "success" || b === "fail") && a !== b;
}

type Row = Record<string, unknown>;
type LineStateSnapshot = {
  target: Row | null;
  expEvals: Row[];
  careerEvals: Row[];
  submission: Row | null;
  overrides: Row[];
};

// 라인 결과 레버가 건드리는 모든 행(대상자·평가·제출·표시 override)을 캡처한다(롤백/복원용).
async function captureLineState(
  userId: string,
  weekId: string,
  lineId: string,
  partType: string,
  lineCode: string | null,
): Promise<LineStateSnapshot> {
  const { data: tRows } = await supabaseAdmin
    .from(TARGET_TABLE)
    .select("*")
    .eq("line_id", lineId)
    .eq("target_user_id", userId)
    .eq("target_mode", "user");
  const target = ((tRows ?? []) as Row[])[0] ?? null;
  const tid = target ? (target.id as string) : null;

  let expEvals: Row[] = [];
  let careerEvals: Row[] = [];
  let submission: Row | null = null;
  if (tid) {
    const [ev, cv, sub] = await Promise.all([
      supabaseAdmin.from(EXP_EVAL_TABLE).select("*").eq("line_target_id", tid).eq("user_id", userId),
      supabaseAdmin.from(CAREER_EVAL_TABLE).select("*").eq("line_target_id", tid).eq("user_id", userId),
      supabaseAdmin.from(SUBMISSION_TABLE).select("*").eq("line_target_id", tid).eq("user_id", userId).maybeSingle(),
    ]);
    expEvals = (ev.data ?? []) as Row[];
    careerEvals = (cv.data ?? []) as Row[];
    submission = (sub.data as Row | null) ?? null;
  }

  // 표시 override(구 경로 잔존분) — line_id / line_code / line_target_id 어느 키로든 이 라인에 걸린 것.
  const { data: ov } = await supabaseAdmin
    .from(OVERRIDE_TABLE)
    .select("*")
    .eq("user_id", userId)
    .eq("week_id", weekId)
    .eq("part_type", partType);
  const overrides = ((ov ?? []) as Row[]).filter(
    (o) =>
      o.line_id === lineId ||
      (lineCode != null && o.line_code === lineCode) ||
      (tid != null && o.line_target_id === tid),
  );

  return { target, expEvals, careerEvals, submission, overrides };
}

// 이 라인·회원의 대상자(+종속 eval/submission) 와 표시 override 를 전부 제거한다(멱등).
async function clearLineState(
  userId: string,
  weekId: string,
  lineId: string,
  partType: string,
  lineCode: string | null,
): Promise<void> {
  const { data: tRows } = await supabaseAdmin
    .from(TARGET_TABLE)
    .select("id")
    .eq("line_id", lineId)
    .eq("target_user_id", userId)
    .eq("target_mode", "user");
  const ids = ((tRows ?? []) as Array<{ id: string }>).map((t) => t.id);
  if (ids.length > 0) {
    // FK(RESTRICT) 순서: 종속행 먼저 삭제 후 target.
    await supabaseAdmin.from(EXP_EVAL_TABLE).delete().in("line_target_id", ids);
    await supabaseAdmin.from(CAREER_EVAL_TABLE).delete().in("line_target_id", ids);
    await supabaseAdmin.from(SUBMISSION_TABLE).delete().in("line_target_id", ids);
    await supabaseAdmin.from(TARGET_TABLE).delete().in("id", ids);
  }
  // 표시 override 제거 — 대상자 배정 상태를 SoT 로 쓰므로 overlay 잔존을 남기지 않는다.
  let delQ = supabaseAdmin.from(OVERRIDE_TABLE).delete().eq("user_id", userId).eq("week_id", weekId).eq("part_type", partType);
  delQ = delQ.eq("line_id", lineId);
  await delQ;
  if (lineCode != null) {
    await supabaseAdmin
      .from(OVERRIDE_TABLE)
      .delete()
      .eq("user_id", userId)
      .eq("week_id", weekId)
      .eq("part_type", partType)
      .eq("line_code", lineCode);
  }
}

// 캡처 스냅샷으로 정확히 복원한다(현재 상태를 지우고 원본 재삽입).
async function restoreLineState(
  userId: string,
  weekId: string,
  lineId: string,
  partType: string,
  lineCode: string | null,
  snap: LineStateSnapshot,
): Promise<void> {
  await clearLineState(userId, weekId, lineId, partType, lineCode);
  if (snap.target) {
    await supabaseAdmin.from(TARGET_TABLE).insert(snap.target);
    if (snap.expEvals.length > 0) await supabaseAdmin.from(EXP_EVAL_TABLE).insert(snap.expEvals);
    if (snap.careerEvals.length > 0) await supabaseAdmin.from(CAREER_EVAL_TABLE).insert(snap.careerEvals);
    if (snap.submission) await supabaseAdmin.from(SUBMISSION_TABLE).insert(snap.submission);
  }
  if (snap.overrides.length > 0) await supabaseAdmin.from(OVERRIDE_TABLE).insert(snap.overrides);
}

export async function saveCrewWeekLineDetail(
  legacyUserId: string,
  weekId: string,
  lineId: string,
  input: SaveLineDetailInput,
  adminUserId: string,
  confirmGrowthFlip: boolean,
): Promise<SaveLineDetailResult> {
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

  if (!isCrewWeekEditable(card.userWeekStatus)) {
    return { ok: false, code: 409, error: "성장 결과가 확정된 이후에만 수정할 수 있습니다." };
  }

  const line = card.lines.find((l) => l.lineId != null && l.lineId === lineId);
  if (!line) return { ok: false, code: 404, error: "Line not found in this week" };

  const part = line.partType;
  const isExperience = part === "experience";
  const isCareer = part === "career";
  const lineCode = line.lineCode ?? null;
  const beforeStatus = card.userWeekStatus;

  // ── 결과 레버 값 검증 ──
  //   이 화면(오픈 라인 개인 상세)에서는 강화 성공/실패만 설정한다. 해당 없음(미오픈)·집계 전(pending)은
  //   클럽 전체/시점 상태라 여기서 만들 수 없다(오픈된 라인을 해당 없음으로 못 바꾸고, 미오픈은 이 경로 불가).
  const desired = input.enhancementStatus;
  if (desired !== "success" && desired !== "fail") {
    return {
      ok: false,
      code: 422,
      error: "오픈된 라인에서는 강화 성공 또는 강화 실패만 설정할 수 있습니다(해당 없음/집계 전은 이 화면에서 변경 불가).",
    };
  }

  // ── 실무 역량 라인명 변경(마스터 repoint) — 강화 성공 상태에서만, identity 만 갱신(제출/평점/지급 보존) ──
  //   같은 라인 행 유지 → 대상자/제출/평가/지급 전부 보존. 라인명/코드/유형은 마스터 파생이라 아래 최종
  //   수렴(§5 recompute → snapshot 재생성)에서 카드/snapshot 이 새 라인으로 자동 반영된다. 강화 결과·평점·
  //   아웃풋·성장 포인트는 이 단계에서 건드리지 않는다. 실패로 바꾸는 경우엔 라인이 제거되므로 repoint 무의미(스킵).
  const wantMasterId =
    typeof input.competencyMasterId === "string" ? input.competencyMasterId.trim() : "";
  if (part === "competency" && desired === "success" && wantMasterId && wantMasterId !== line.competencyLineMasterId) {
    const rep = await repointCompetencyLineMaster(userId, weekId, lineId, wantMasterId, adminUserId);
    if (!rep.ok) return { ok: false, code: rep.code, error: rep.error };
  }

  // ── 제출 데이터 검증(쓰기 전 전부) ──
  for (const l of input.statusData.outputLinks) {
    if (l.url && l.url.trim() && !HTTP_RE.test(l.url.trim())) {
      return { ok: false, code: 422, error: "링크 URL 은 http(s):// 로 시작해야 합니다." };
    }
  }
  if (input.statusData.outputLinks.filter((l) => l.url && l.url.trim()).length > MAX_LINKS) {
    return { ok: false, code: 422, error: `링크는 최대 ${MAX_LINKS}개까지 가능합니다.` };
  }
  const links = normLinks(input.statusData.outputLinks);
  const subTitle = input.statusData.subTitle?.trim() ? input.statusData.subTitle.trim() : null;
  const growthPoint = input.statusData.growthPoint?.trim() ? input.statusData.growthPoint.trim() : null;
  if (subTitle && subTitle.length > 300) return { ok: false, code: 422, error: "Sub Title 은 300자 이하여야 합니다." };
  if (growthPoint && growthPoint.length > 200) return { ok: false, code: 422, error: "Growth Point 는 200자 이하여야 합니다." };

  const rating = input.statusData.rating;
  if (isExperience && rating != null && (!Number.isInteger(rating) || rating < 0 || rating > 10)) {
    return { ok: false, code: 422, error: "평점은 0~10 정수여야 합니다." };
  }
  if (isExperience && desired === "success" && rating != null && rating < 4) {
    return { ok: false, code: 422, error: "강화 성공이면 평점은 4점 이상이어야 합니다." };
  }
  const grade = input.statusData.grade ?? null;
  if (isCareer && desired === "success" && grade === "D") {
    return { ok: false, code: 422, error: "강화 성공이면 등급은 D 가 될 수 없습니다." };
  }

  const statusChanging = desired !== line.enhancementStatus;

  // ── 롤백 스냅샷 캡처(레버 쓰기 전) ──
  const snap = await captureLineState(userId, weekId, lineId, part, lineCode);
  const targetExists = snap.target != null;
  let currentTargetId: string | null = targetExists ? (snap.target!.id as string) : null;

  const recomputeAndReadStatus = async (): Promise<string> => {
    try {
      await refreshWeeklyCardsSnapshotSafe(userId);
    } catch {
      /* best-effort */
    }
    const re = await resolveCrewWeekCard(legacyUserId, weekId);
    return re.ok ? re.card.userWeekStatus : beforeStatus;
  };

  // ── 1. 결과 레버 = 대상자 배정 상태 ──
  try {
    if (desired === "success") {
      // 성공 = 대상자 배정. 없으면 생성.
      if (!currentTargetId) {
        const { data: created, error: cErr } = await supabaseAdmin
          .from(TARGET_TABLE)
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
        if (cErr || !created) {
          await restoreLineState(userId, weekId, lineId, part, lineCode, snap);
          return { ok: false, code: 422, error: "대상자 배정에 실패했습니다." };
        }
        currentTargetId = (created as { id: string }).id;
      }
      // 경험 평점 / 경력 등급을 성공값으로 함께 저장(파생 강화 결과가 성공이 되도록).
      if (isExperience && rating != null) {
        const { error } = await supabaseAdmin
          .from(EXP_EVAL_TABLE)
          .upsert(
            { line_target_id: currentTargetId, user_id: userId, rating, evaluated_by: adminUserId, evaluated_at: new Date().toISOString() },
            { onConflict: "line_target_id,user_id" },
          );
        if (error) {
          await restoreLineState(userId, weekId, lineId, part, lineCode, snap);
          return { ok: false, code: 422, error: "평점 저장에 실패했습니다." };
        }
      } else if (isExperience) {
        // 성공인데 평점 미입력 → 실패 평점 잔존 시 제거(대상자+마감 후 = 성공 기본).
        await supabaseAdmin.from(EXP_EVAL_TABLE).delete().eq("line_target_id", currentTargetId).eq("user_id", userId);
      }
      if (isCareer && grade != null) {
        try {
          await upsertCareerEvaluation({ lineTargetId: currentTargetId, userId, grade }, adminUserId, new Date().toISOString());
        } catch (e) {
          await restoreLineState(userId, weekId, lineId, part, lineCode, snap);
          return { ok: false, code: 422, error: e instanceof Error ? e.message : "등급 저장에 실패했습니다." };
        }
      }
      // 표시 override 잔존 제거(대상자 배정 상태를 SoT 로).
      await clearOverridesOnly(userId, weekId, lineId, part, lineCode);
    } else {
      // 실패 = 대상자 해제(+종속 eval/submission 삭제) + override 제거.
      //   ⚠ 인스턴스(cluster4_lines) 삭제는 여기서 하지 않는다 — 뒤의 reconcile(회수)·재조회가 라인을
      //   참조하므로, 관리자 생성 역량 인스턴스 고아 정리는 회수·수렴 이후 맨 끝에서 수행한다.
      await clearLineState(userId, weekId, lineId, part, lineCode);
      currentTargetId = null;
    }
  } catch (e) {
    await restoreLineState(userId, weekId, lineId, part, lineCode, snap);
    return { ok: false, code: 422, error: e instanceof Error ? e.message : "결과 저장에 실패했습니다." };
  }

  // ── 2. 성장 결과 flip 미리보기(상태가 실제로 바뀔 때만) ──
  if (statusChanging) {
    const afterStatus = await recomputeAndReadStatus();
    if (isGrowthFlip(beforeStatus, afterStatus) && !confirmGrowthFlip) {
      await restoreLineState(userId, weekId, lineId, part, lineCode, snap);
      try {
        await refreshWeeklyCardsSnapshotSafe(userId);
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        code: 409,
        error: "GROWTH_STATUS_WILL_CHANGE",
        growth: { beforeLabel: adminWeekStatusLabel(beforeStatus), afterLabel: adminWeekStatusLabel(afterStatus) },
      };
    }
  }

  // ── 3. 제출 데이터 — 최종 결과가 success 이고 실제 변경이 있을 때만(A 보존) ──
  //   ⚠ 변경 판정 기준 = **표시값(고객과 동일)**.
  //     · 서브타이틀/그로스/링크 = per-user submission 우선, 없으면 라인 레벨 폴백(미변경 저장이 라인 콘텐츠를
  //       submission 으로 복사하지 않도록).
  //     · 이미지 = **예약 슬롯 모델**(2026-07-18): 슬롯 0=운영진(라인 레벨 cluster4_lines.output_images),
  //       슬롯 1..3=크루(submission.output_images). 운영진/크루를 각자 출처에 저장해 슬롯 순서를 무손실 보존한다.
  //       (기존 either/or·compact 는 운영진/크루 이미지를 뭉개 슬롯을 이동시켰다 — 이번 버그.)
  const curSub = line.submission;
  const effSubtitle = curSub?.subtitle ?? line.infoSubtitle ?? null;
  const effGrowth = curSub?.growthPoint ?? line.infoGrowthPoint ?? null;
  const hasSubLinks = (curSub?.outputLinks?.length ?? 0) > 0;
  const effLinks: Cluster4OutputLink[] = hasSubLinks ? curSub!.outputLinks : (line.outputLinks ?? []);

  // 현재 이미지 — 운영진(라인 레벨)과 크루(제출)를 분리해서 읽는다(표시/고객과 동일 SoT).
  const curAdminImages: Cluster4OutputImage[] = (line.outputImages ?? []).map((url, i) => ({
    url,
    caption: line.outputImageCaptions?.[i] ?? null,
  }));
  const curCrewImages: Cluster4OutputImage[] = (curSub?.outputImages ?? []).map((url, i) => ({
    url,
    caption: curSub?.outputImageCaptions?.[i] ?? null,
  }));
  // 목표 이미지 — 팝업이 보낸 고정 4슬롯을 운영진/크루로 분리. 미제공 시 현재 유지(보존).
  const { adminImages: nextAdminImages, crewImages: nextCrewImages } = input.statusData.imageSlots
    ? splitImageSlots(input.statusData.imageSlots.slice(0, IMAGE_SLOT_COUNT))
    : { adminImages: curAdminImages, crewImages: curCrewImages };

  const imagesEqual = (a: Cluster4OutputImage[], b: Cluster4OutputImage[]) =>
    a.length === b.length &&
    a.every((x, i) => x.url === b[i]?.url && (x.caption ?? null) === (b[i]?.caption ?? null));
  const crewImagesChanged = !imagesEqual(nextCrewImages, curCrewImages);
  const adminImagesChanged = !imagesEqual(nextAdminImages, curAdminImages);

  // 3a. 크루(제출) 이미지 + 서브타이틀/그로스/링크 = per-user submission upsert(성공 상태에서만·변경 시).
  const submissionChanged =
    subTitle !== effSubtitle ||
    growthPoint !== effGrowth ||
    !linksEqual(links, effLinks) ||
    crewImagesChanged;
  if (desired === "success" && submissionChanged && currentTargetId) {
    const [link2, link3, link4, link5] = outputLinksToLegacySlots(links, 4);
    const { error } = await supabaseAdmin.from(SUBMISSION_TABLE).upsert(
      {
        line_target_id: currentTargetId,
        user_id: userId,
        subtitle: subTitle,
        growth_point: growthPoint,
        output_links: links,
        output_link_2: link2,
        output_link_3: link3,
        output_link_4: link4,
        output_link_5: link5,
        output_images: nextCrewImages, // 크루 이미지만(연속) — 운영진 슬롯 미포함
      },
      { onConflict: "line_target_id,user_id" },
    );
    if (error) return { ok: false, code: 422, error: "제출 내용 저장에 실패했습니다." };
  }

  // 3b. 운영진(슬롯 0) 이미지 = 라인 레벨 cluster4_lines.output_images(≤1). 고정필드 allowlist 예외 —
  //   아웃풋 이미지의 운영진 슬롯만 라인 레벨에 쓴다(라인명/코드/허브/실무자 등 identity 는 여전히 불변).
  //   ⚠ 라인 레벨은 클럽 공용 — 이 크루 팝업에서 슬롯 0을 바꾸면 같은 라인의 모든 크루 카드 1번 슬롯에 반영된다.
  if (desired === "success" && adminImagesChanged) {
    const { error } = await supabaseAdmin
      .from("cluster4_lines")
      .update({ output_images: nextAdminImages })
      .eq("id", lineId);
    if (error) return { ok: false, code: 422, error: "운영진 이미지 저장에 실패했습니다." };
    // 라인 레벨(클럽 공용) 변경 → 같은 라인의 다른 크루 스냅샷은 stale. 본인은 §5 에서 재계산되므로,
    //   나머지 대상자만 무효화(lazy/cron 재계산)해 슬롯 0 이 모든 크루 카드에 일관 반영되게 한다(best-effort).
    try {
      const { data: otherTargets } = await supabaseAdmin
        .from(TARGET_TABLE)
        .select("target_user_id")
        .eq("line_id", lineId)
        .eq("target_mode", "user")
        .neq("target_user_id", userId);
      const otherIds = Array.from(
        new Set(
          ((otherTargets ?? []) as Array<{ target_user_id: string | null }>)
            .map((t) => t.target_user_id)
            .filter((id): id is string => !!id),
        ),
      );
      if (otherIds.length > 0) await markWeeklyCardsSnapshotStaleMany(otherIds);
    } catch (e) {
      console.warn("[crewWeekLineSave] 라인 레벨 이미지 변경 후 타 크루 무효화 실패(best-effort)", {
        lineId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── 4. 라인 지급 원장 결과 기준 reconcile (라인 A/B = 대상자 + 강화 성공 시 지급) ──
  try {
    await reconcileLineResultAwardForUser(userId, lineId, weekId, desired === "success", adminUserId);
  } catch (e) {
    console.warn("[crewWeekLineSave] 라인 지급 reconcile 실패(격리)", {
      userId,
      lineId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 5. 최종 수렴 — uwp 합산(취소분 제외)→등급→snapshot→카드→크루페이지 1회 수렴 ──
  //   (대상자 배정/평점/제출 변경 모두 반영: lineTargetId·강화 결과·획득 A/B·상단 포인트 합계·
  //    성공/실패 집계·2차 기입 자격·주차 성장률/결과·품계·위클리 랭킹·snapshot).
  try {
    await recomputeWeeklyPointsForUsers([userId], weekId);
  } catch {
    /* best-effort — 실패해도 cron 재계산 */
  }

  // ── 5.5. 주차 성장 결과(user_week_statuses) 재판정 — 라인 결과 변경을 실제 주차 결과로 커밋 ──
  //   ⚠ 순서 계약: 반드시 uwp 재집계(§5) "후" 호출해야 최신 earned(Point A) 로 판정한다
  //     (crewWeekGrowthRejudge 헤더 계약). 액트 보완/취소와 동일한 파생 체인을 재사용:
  //       rejudgeWeekStatusForUser(uws 1행) → snapshot 재생성 → 성장 통계 → 품계(주차 참여자).
  //   이 커밋으로 raw user_week_statuses 가 강화 결과 변경을 반영하므로, 이를 라이브로 읽는
  //   크루 페이지 이력서 카드(누적 성장 주차)·위클리 랭킹·cluster-4-ranking 과 파생 카드/품계가
  //   모두 동일 최신값으로 수렴한다. rejudge 는 레거시/휴식/공식휴식/not_applicable/pending 을
  //   스킵하고 대상 상태가 실제로 바뀔 때만 1행을 쓴다(타 크루·타 주차 불변). best-effort.
  try {
    await recomputeDerivedAfterActMutation({ userId, weekId });
  } catch (e) {
    console.warn("[crewWeekLineSave] uws 재판정/파생 재계산 실패(best-effort)", {
      userId,
      weekId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 6. 결과가 success 가 아니게 되면 2차 기입 수동 허용 자동 회수(§) ──
  if (desired !== "success") {
    try {
      if (await isSecondEntryOverrideAllowed(userId, weekId, lineId)) {
        await writeSecondEntryOverride({
          userId,
          weekId,
          lineId,
          allowed: false,
          adminUserId,
          source: "admin_manual",
          note: "강화 성공 아님 → 2차 기입 자동 회수",
        });
      }
    } catch {
      /* best-effort */
    }
  }

  // 실무 역량 성공→실패: 대상자 해제로 이 크루 카드에서 라인이 사라진다. 관리자 생성 인스턴스(신청 개설분
  //   아님·잔여 대상자 없음)는 회수·수렴을 끝낸 지금 정리한다(고아 방지). 잔여 대상자/신청분은 보존.
  if (part === "competency" && desired === "fail") {
    await deleteOrphanCompetencyLineIfAdminCreated(lineId);
  }

  const fresh = await getCrewWeekLineDetail(legacyUserId, weekId, lineId);
  if (!fresh.ok) {
    // 실패 저장 후 라인이 카드에서 사라진 정상 케이스(역량 인스턴스 정리 등) → 저장 성공(데이터 없음).
    if (desired === "fail") return { ok: true, data: null };
    return { ok: false, code: 404, error: "저장 후 재조회에 실패했습니다." };
  }
  return { ok: true, data: fresh.data };
}

// 실무 역량 관리자 생성 인스턴스(신청 개설분 아님) 고아 정리: 대상자 0 && 신청 미참조면 라인 삭제.
async function deleteOrphanCompetencyLineIfAdminCreated(lineId: string): Promise<void> {
  const { data: tgts } = await supabaseAdmin
    .from(TARGET_TABLE)
    .select("id")
    .eq("line_id", lineId)
    .eq("target_mode", "user")
    .limit(1);
  if (((tgts ?? []) as Array<{ id: string }>).length > 0) return; // 잔여 대상자 있음 → 보존.
  const { data: apps } = await supabaseAdmin
    .from("cluster4_competency_applications")
    .select("id")
    .eq("opened_line_id", lineId)
    .limit(1);
  if (((apps ?? []) as Array<{ id: string }>).length > 0) return; // 신청 개설분 → 보존(참조 무결성).
  // 대상자·제출은 clearLineState 가 이미 정리함(FK 종속행 없음). 회수된(취소) 라인 원장 + 인스턴스 제거.
  await supabaseAdmin.from("process_point_awards").delete().eq("source", "line").eq("ref_id", lineId);
  await supabaseAdmin.from("cluster4_lines").delete().eq("id", lineId);
}

// 표시 override 만 제거(대상자/평가/제출은 건드리지 않음) — 성공 경로에서 overlay 잔존 정리용.
async function clearOverridesOnly(
  userId: string,
  weekId: string,
  lineId: string,
  partType: string,
  lineCode: string | null,
): Promise<void> {
  await supabaseAdmin
    .from(OVERRIDE_TABLE)
    .delete()
    .eq("user_id", userId)
    .eq("week_id", weekId)
    .eq("part_type", partType)
    .eq("line_id", lineId);
  if (lineCode != null) {
    await supabaseAdmin
      .from(OVERRIDE_TABLE)
      .delete()
      .eq("user_id", userId)
      .eq("week_id", weekId)
      .eq("part_type", partType)
      .eq("line_code", lineCode);
  }
}
