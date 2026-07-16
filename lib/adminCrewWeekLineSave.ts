import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import {
  getCrewWeekLineDetail,
  type AdminCrewWeekLineDetailDto,
} from "@/lib/adminCrewWeekLineDetail";
import { setEnhancementOverrideStatus } from "@/lib/cluster4EnhancementOverride";
import {
  writeSecondEntryOverride,
  isSecondEntryOverrideAllowed,
} from "@/lib/cluster4SecondEntryOverride";
import { upsertCareerEvaluation } from "@/lib/adminCareerEvaluationsData";
import { outputLinksToLegacySlots } from "@/lib/cluster4OutputLinks";
import { refreshWeeklyCardsSnapshotSafe } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  reconcileLineResultAwardForUser,
  recomputeWeeklyPointsForUsers,
} from "@/lib/processPointAccrual";
import { adminWeekStatusLabel } from "@/lib/adminCrewWeeklyResults";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import type { CareerGrade } from "@/lib/careerGrade";
import type { Cluster4EnhancementStatus, Cluster4OutputLink } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 관리자 라인 상세 저장. 원칙:
//   · 쓰기 대상 4종뿐 — submissions / experience evals / career evals / enhancement overrides.
//     Main Title·허브·라인명·라인코드·실무자·라인마스터는 절대 쓰지 않는다(allowlist).
//   · 강화 결과 레버: 경험=rating, 경력=grade(둘 다 verdict 로 흐름), 정보/역량=표시 override(verdict 무관).
//   · 성공 상태의 제출 데이터(A)는 결과가 실패/해당없음이면 "쓰지 않음"으로 보존(삭제/빈값 금지).
//   · 성장 결과 변경 미리보기: rating/grade 는 snapshot 재계산 시 verdict 로 흐르므로 별도 투영 훅이 없다.
//     그래서 "쓰기 → 재계산 → 주차 성장 결과 flip 확인 → 미확인이면 롤백 후 409" 로 정확히 판정한다
//     (실제 재계산 로직 그대로 재사용 — 분기 없는 정확성). 확인(confirmGrowthFlip) 시 유지.
//   · 결과가 success 가 아니게 되면 이 라인의 2차 기입 수동 허용 override 를 자동 회수(§23).
// ─────────────────────────────────────────────────────────────────────

const MAX_LINKS = 5;
const HTTP_RE = /^https?:\/\//i;

export type SaveLineDetailInput = {
  enhancementStatus: Cluster4EnhancementStatus; // 정보/역량 레버(그 외 허브는 rating/grade 로 파생)
  statusData: {
    subTitle: string | null;
    growthPoint: string | null;
    outputLinks: { url: string; label: string | null }[];
    images?: { url: string; caption: string | null }[]; // 미제공 시 기존 이미지 보존
    rating: number | null; // 경험
    grade?: CareerGrade | null; // 경력
  };
};

export type SaveLineDetailResult =
  | { ok: true; data: AdminCrewWeekLineDetailDto }
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
  const lineTargetId = line.lineTargetId;
  const beforeStatus = card.userWeekStatus;

  // ── 검증(쓰기 전 전부) ──
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
  const grade = input.statusData.grade ?? null;

  const resultingStatus: Cluster4EnhancementStatus = isExperience
    ? rating == null
      ? line.enhancementStatus
      : rating >= 4
        ? "success"
        : "fail"
    : isCareer
      ? grade == null
        ? line.enhancementStatus
        : grade === "D"
          ? "fail"
          : "success"
      : input.enhancementStatus;

  const recomputeAndReadStatus = async (): Promise<string> => {
    try {
      await refreshWeeklyCardsSnapshotSafe(userId);
    } catch {
      /* best-effort */
    }
    const re = await resolveCrewWeekCard(legacyUserId, weekId);
    return re.ok ? re.card.userWeekStatus : beforeStatus;
  };

  // ── 1. 결과 레버 ──
  if (isExperience) {
    const cur = line.experienceRating;
    if (rating !== cur) {
      if (rating != null && !lineTargetId) {
        return { ok: false, code: 422, error: "배정된 라인이 아니어서 평점을 저장할 수 없습니다." };
      }
      // 롤백용 원본 평가 캡처.
      type ExpEvalRow = { rating: number; evaluated_by: string | null; evaluated_at: string | null };
      let orig: ExpEvalRow | null = null;
      if (lineTargetId) {
        const { data } = await supabaseAdmin
          .from("cluster4_experience_line_evaluations")
          .select("rating,evaluated_by,evaluated_at")
          .eq("line_target_id", lineTargetId)
          .eq("user_id", userId)
          .maybeSingle();
        orig = (data as ExpEvalRow | null) ?? null;
      }
      // 쓰기.
      if (rating == null) {
        if (lineTargetId) {
          const { error } = await supabaseAdmin
            .from("cluster4_experience_line_evaluations")
            .delete()
            .eq("line_target_id", lineTargetId)
            .eq("user_id", userId);
          if (error) return { ok: false, code: 422, error: "평점 삭제에 실패했습니다." };
        }
      } else {
        const { error } = await supabaseAdmin
          .from("cluster4_experience_line_evaluations")
          .upsert(
            {
              line_target_id: lineTargetId,
              user_id: userId,
              rating,
              evaluated_by: adminUserId,
              evaluated_at: new Date().toISOString(),
            },
            { onConflict: "line_target_id,user_id" },
          );
        if (error) return { ok: false, code: 422, error: "평점 저장에 실패했습니다." };
      }
      // 재계산 + flip 판정(제출 쓰기 전이라 롤백 시 부분 저장 없음).
      const afterStatus = await recomputeAndReadStatus();
      if (isGrowthFlip(beforeStatus, afterStatus) && !confirmGrowthFlip) {
        if (lineTargetId) {
          if (orig) {
            await supabaseAdmin
              .from("cluster4_experience_line_evaluations")
              .upsert(
                {
                  line_target_id: lineTargetId,
                  user_id: userId,
                  rating: orig.rating,
                  evaluated_by: orig.evaluated_by,
                  evaluated_at: orig.evaluated_at,
                },
                { onConflict: "line_target_id,user_id" },
              );
          } else {
            await supabaseAdmin
              .from("cluster4_experience_line_evaluations")
              .delete()
              .eq("line_target_id", lineTargetId)
              .eq("user_id", userId);
          }
          try {
            await refreshWeeklyCardsSnapshotSafe(userId);
          } catch {
            /* best-effort */
          }
        }
        return {
          ok: false,
          code: 409,
          error: "GROWTH_STATUS_WILL_CHANGE",
          growth: { beforeLabel: adminWeekStatusLabel(beforeStatus), afterLabel: adminWeekStatusLabel(afterStatus) },
        };
      }
      // 유지 — 재계산 이미 수행됨.
    }
  } else if (isCareer) {
    if (grade != null && resultingStatus !== line.enhancementStatus) {
      if (!lineTargetId) return { ok: false, code: 422, error: "배정된 라인이 아니어서 등급을 저장할 수 없습니다." };
      try {
        await upsertCareerEvaluation({ lineTargetId, userId, grade }, adminUserId, new Date().toISOString());
      } catch (e) {
        return { ok: false, code: 422, error: e instanceof Error ? e.message : "등급 저장에 실패했습니다." };
      }
      // 경력 등급도 verdict 로 흐르지만 이번 팝업엔 grade UI 가 없어 flip 미리보기는 후속(§UI). 재계산은 헬퍼가 수행.
    }
  } else {
    // 정보/역량 — 표시 override(verdict 무관, read-time overlay). 재계산 불필요.
    if (resultingStatus !== line.enhancementStatus) {
      await setEnhancementOverrideStatus({
        userId,
        weekId,
        partType: part,
        lineTargetId,
        lineId,
        lineCode: line.lineCode ?? null,
        overrideStatus: resultingStatus,
        adminUserId,
      });
    }
  }

  // ── 2. 제출 데이터 — 최종 결과가 success 이고 실제 변경이 있을 때만(A 보존) ──
  const curSub = line.submission;
  const curImages = (curSub?.outputImages ?? []).map((url, i) => ({
    url,
    caption: curSub?.outputImageCaptions?.[i] ?? null,
  }));
  const images = (input.statusData.images ?? curImages)
    .filter((im) => im.url && im.url.trim())
    .slice(0, 4)
    .map((im) => ({ url: im.url.trim(), caption: im.caption?.trim() || null }));
  const imagesChanged = JSON.stringify(images) !== JSON.stringify(curImages);
  const submissionChanged =
    subTitle !== (curSub?.subtitle ?? null) ||
    growthPoint !== (curSub?.growthPoint ?? null) ||
    !linksEqual(links, curSub?.outputLinks ?? []) ||
    imagesChanged;
  if (resultingStatus === "success" && submissionChanged) {
    if (!lineTargetId) return { ok: false, code: 422, error: "배정된 라인이 아니어서 제출 내용을 저장할 수 없습니다." };
    const [link2, link3, link4, link5] = outputLinksToLegacySlots(links, 4);
    const { error } = await supabaseAdmin.from("cluster4_line_submissions").upsert(
      {
        line_target_id: lineTargetId,
        user_id: userId,
        subtitle: subTitle,
        growth_point: growthPoint,
        output_links: links,
        output_link_2: link2,
        output_link_3: link3,
        output_link_4: link4,
        output_link_5: link5,
        output_images: images,
      },
      { onConflict: "line_target_id,user_id" },
    );
    if (error) return { ok: false, code: 422, error: "제출 내용 저장에 실패했습니다." };
  }

  // ── 3. 라인 지급 원장 결과 기준 reconcile (라인 A/B = 강화 성공 시 지급) ──
  //   성공→config point_a/b 지급, 실패/해당없음→회수(soft-cancel). 대상자 등록 payout 과 별개(결과 종속).
  try {
    await reconcileLineResultAwardForUser(userId, lineId, weekId, resultingStatus === "success", adminUserId);
  } catch (e) {
    console.warn("[crewWeekLineSave] 라인 지급 reconcile 실패(격리)", {
      userId,
      lineId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 4. 최종 수렴 — uwp 합산(취소분 제외)→등급→snapshot→카드→크루페이지 1회 수렴 ──
  //   (라인 지급/평점/제출 변경 모두 반영: 획득 A/B·상단 포인트 합계·성공/실패 집계·2차 기입 자격).
  try {
    await recomputeWeeklyPointsForUsers([userId], weekId);
  } catch {
    /* best-effort — 실패해도 cron 재계산 */
  }

  // ── 5. 결과가 success 가 아니게 되면 2차 기입 수동 허용 자동 회수(§23) ──
  if (resultingStatus !== "success") {
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

  const fresh = await getCrewWeekLineDetail(legacyUserId, weekId, lineId);
  if (!fresh.ok) return { ok: false, code: 404, error: "저장 후 재조회에 실패했습니다." };
  return { ok: true, data: fresh.data };
}
