// 검수 준비 상태(readiness) — 읽기 전용. "검수 완료" 전에 무엇이 부족한지 체크리스트로 보여준다.
//
// ⚠ 기존 finalize/point/uws 로직을 일절 변경하지 않는다. 안전장치와 동일한 판정 재료를 read-only 로
//   조회해 관리자에게 "왜 검수 완료가 안 되는지"를 한눈에 설명하기 위한 조회 전용 레이어다.
//   실제 확정은 여전히 markTeamPartsWeekReviewed(POST /review) 가 수행한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";
import type { StateScope } from "@/lib/operationalState";
import {
  assertWeekAccrualComplete,
  loadFinalizeCohort,
  loadExperienceLineWeekScope,
  type FinalizeWeekRow,
} from "@/lib/adminWeekUwsFinalize";

export type ReadinessItem = {
  key:
    | "accrual"
    | "experienceLines"
    | "experienceEval"
    | "seasonParticipants"
    | "noPending";
  label: string;
  ok: boolean;
  detail: string; // 부족/충족 설명(관리자용)
};

export type ReviewReadiness = {
  // 신정책(2026-summer+·비공식휴식·과거) 주차인가. false 면 준비체크 대상 아님(레거시/공식휴식/현재·미래).
  applicable: boolean;
  notApplicableReason: string | null;
  items: ReadinessItem[];
  ready: boolean; // 모든 blocking 항목 충족 → 정상 검수 완료 가능.
  // test/QA 스코프 여부(강제 진행 버튼 노출 가능). operating 실유저면 false.
  scopeIsTest: boolean;
};

async function loadWeek(weekId: string): Promise<
  | (FinalizeWeekRow & { season_key: string | null })
  | null
> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest")
    .eq("id", weekId)
    .maybeSingle();
  return (data as (FinalizeWeekRow & { season_key: string | null }) | null) ?? null;
}

export async function computeReviewReadiness(
  weekId: string,
  scope: StateScope = "operating",
): Promise<ReviewReadiness> {
  const scopeIsTest = scope === "qa" || QA_HIDE_REAL_USERS;
  const notApplicable = (reason: string): ReviewReadiness => ({
    applicable: false,
    notApplicableReason: reason,
    items: [],
    ready: false,
    scopeIsTest,
  });

  const week = await loadWeek(weekId);
  if (!week) return notApplicable("주차를 찾을 수 없습니다.");
  if (!week.start_date || !week.season_key) return notApplicable("주차 메타(시즌/시작일)가 없습니다.");
  if (week.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) {
    return notApplicable("레거시 주차(2026 여름 이전)는 준비 상태 점검 대상이 아닙니다.");
  }
  if (week.is_official_rest === true) {
    return notApplicable("공식 휴식 주차는 개별 주차 결과를 확정하지 않습니다.");
  }
  const currentWeekStartMs = getCurrentWeekStartMs(getCurrentActivityDateIso());
  const weekStartMs = Date.parse(`${week.start_date}T00:00:00Z`);
  if (currentWeekStartMs != null && weekStartMs >= currentWeekStartMs) {
    return notApplicable("현재/미래 주차는 아직 결과를 확정할 수 없습니다.");
  }

  // ── 판정 재료(read-only) ────────────────────────────────────────────────
  // 1) 적립 완료(안전장치와 동일 함수).
  const gate = await assertWeekAccrualComplete(week, scope);

  // 2) 시즌 참여자(코호트, scope 반영).
  const cohort = await loadFinalizeCohort(week.season_key, scope);

  // 3) 실무 경험 라인/타깃/평가 (주차 전역).
  //   ⚠ experience 라인은 개설 UI 에서 cluster4_lines.week_id 를 세팅하지 않는다(NULL) — 주차 앵커는
  //     cluster4_line_targets.week_id. 공통 SoT(loadExperienceLineWeekScope)로 라인 개설 페이지와 동일 조회.
  const { lineIds: expLineIds, targetIds } = await loadExperienceLineWeekScope(weekId);

  let targetCount = 0;
  let evaluatedCount = 0;
  {
    targetCount = targetIds.length;
    if (targetIds.length > 0) {
      // 평가 완료 = rating>0 이거나 evaluated_by 세팅(팀장이 실제 평가). rating=0 & evaluated_by=null = 미평가.
      const CHUNK = 200;
      const evaluated = new Set<string>();
      for (let i = 0; i < targetIds.length; i += CHUNK) {
        const chunk = targetIds.slice(i, i + CHUNK);
        const { data: evs } = await supabaseAdmin
          .from("cluster4_experience_line_evaluations")
          .select("line_target_id,rating,evaluated_by")
          .in("line_target_id", chunk);
        for (const e of (evs ?? []) as Array<{
          line_target_id: string;
          rating: number | null;
          evaluated_by: string | null;
        }>) {
          if ((e.rating ?? 0) > 0 || e.evaluated_by != null) evaluated.add(e.line_target_id);
        }
      }
      evaluatedCount = evaluated.size;
    }
  }
  const unevaluated = Math.max(0, targetCount - evaluatedCount);

  const items: ReadinessItem[] = [
    {
      key: "accrual",
      label: "프로세스 활동 점수 확인",
      ok: gate.ok,
      detail: gate.ok
        ? `활동 점수 ${gate.awardCount}건 반영 완료`
        : `아직 반영되지 않은 활동이 있습니다 (미완료 ${gate.pendingChecks + gate.pendingIrregular}건)`,
    },
    {
      key: "experienceLines",
      label: "실무 경험 활동 등록",
      ok: expLineIds.length > 0,
      detail: expLineIds.length > 0 ? `${expLineIds.length}개 등록됨` : "등록된 실무 경험 활동이 없습니다.",
    },
    {
      key: "experienceEval",
      label: "실무 경험 결과 확인",
      ok: targetCount > 0 && unevaluated === 0,
      detail:
        targetCount === 0
          ? "확인할 실무 경험 활동이 없습니다 (먼저 활동을 등록해주세요)."
          : unevaluated === 0
            ? `대상 ${targetCount}건 모두 결과 확인 완료`
            : `${targetCount}건 중 ${unevaluated}건 결과 확인 필요`,
    },
    {
      key: "seasonParticipants",
      label: "이번 주 참여 대상자 확인",
      ok: cohort.length > 0,
      detail: cohort.length > 0 ? `참여 대상자 ${cohort.length}명` : "이번 주 참여 대상자가 없습니다.",
    },
    {
      key: "noPending",
      label: "추가로 확인할 대상",
      ok: unevaluated === 0,
      detail: unevaluated === 0 ? "없음 (모든 대상자 확인 완료)" : `${unevaluated}건이 결과 확인 대기 중입니다.`,
    },
  ];

  const ready = items.every((i) => i.ok);
  return { applicable: true, notApplicableReason: null, items, ready, scopeIsTest };
}
