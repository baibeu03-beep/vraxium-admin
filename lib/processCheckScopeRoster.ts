// 프로세스 체크 "체크 대상자 로스터" 해소 — 각 체크가 실제로 사용한 스코프를 그대로 재현.
// ─────────────────────────────────────────────────────────────────────
//   Point C(패널티)는 "비대상자(unselectedUsers) = checkScopeRoster − matchedPerformers" 에게 지급한다.
//   그 모집단(roster)은 어디에도 저장돼 있지 않으므로 체크 시점 스코프에서 재계산한다.
//
//   ⚠ 새로운 roster 판정 규칙을 만들지 않는다 — 현재 체크 화면/검수가 대상자로 삼는 "기존 공통 조회
//     로직"을 그대로 재사용한다(UI 체크 대상자 == Point A/B/C 모집단). 허브별 기준:
//       · experience(팀 구분): 둘 다 "소속" 판정(역할 무관, 엘리트·바사노스는 제외 — 2026-07-31
//         최종 확정) — 파트 스코프(partName 있음) → listPartMembers(그 파트 소속자 중 엘리트·바사노스
//         제외. 파트장은 포함) / 팀 총괄(partName 없음) → listTeamMembers(그 팀 소속자 전원 중
//         엘리트·바사노스 제외. 파트 소속자·파트 미배정자·파트장 포함 — PART/TEAM 모집단은 상호
//         배타적이지 않다). 팀장은 어느 쪽에도 없다(역할 필터가 아니라 팀장은 애초에 파트가 없음,
//         2026-06-19 정책, 이번 수정 범위 밖).
//       · info/competency/club(비팀): 카페 자동 검수가 매칭 후보로 삼는 org+mode 모집단과 동일
//         (resolveUserScope(mode,org) ∩ loadCrewRecords(org)). inProcessCrawlAndMatch 와 동일 집합.
//
//   스코프 키(체크 생성·조회와 동일): organization · hub · team_id · part_name · mode.
//   휴식/중단/탈퇴 포함 기준은 위 허브별 기존 로직을 그대로 따른다(별도 규칙 없음).
//   fail-closed: org 불명/팀 미해소면 빈 로스터(→ C 미지급). 다른 org/hub/team/part 유입 없음.
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";
import { loadCrewRecords } from "@/lib/cluster4CafeLineMatch";
import { listPartMembers, listTeamMembers } from "@/lib/adminExperiencePartInput";
import { resolveWeekStartDateForWeekId } from "@/lib/seasonRestWeekScope";
import { loadEvaluationEligibility } from "@/lib/evaluationEligibility";
import { resolveCurrentWeekStartDate } from "@/lib/teamWeekPositionOverride";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { isTeamBasedProcessHub } from "@/lib/adminProcessCheckTypes";
import type { ProcessHub } from "@/lib/adminProcessesTypes";
import type { OrganizationSlug } from "@/lib/organizations";

export type CheckScope = {
  hub: ProcessHub;
  organization: OrganizationSlug | null;
  mode: ScopeMode;
  teamId: string | null;
  partName: string | null;
  /** 이 체크가 속한 주차(weeks.id). 시즌 휴식 판정 기준 시즌을 여기서 얻는다(미지정=현재 시즌 폴백). */
  weekId?: string | null;
};

// 팀 id → 팀명(org·active 검증). adminProcessCheckData 의 private resolveTeamName 과 동일 질의(순환 import 회피 위해 국소 복제).
async function resolveTeamName(teamId: string, organization: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_teams")
    .select("team_name")
    .eq("id", teamId)
    .eq("organization_slug", organization)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.warn("[check-roster] team name resolve unavailable:", error.message);
    return null;
  }
  return (data as { team_name: string } | null)?.team_name ?? null;
}

// 체크 스코프의 체크 대상자 userId 집합(정렬·중복 제거). "화면에 보이는 대상자" 와 동일.
export async function resolveCheckScopeRoster(scope: CheckScope): Promise<string[]> {
  const { hub, organization, mode, teamId, partName, weekId } = scope;
  if (!organization) return []; // org 불명 → 로스터 불명(fail-closed, C 미지급).

  if (isTeamBasedProcessHub(hub)) {
    // experience — 팀 미선택 상태행은 로스터 불명(팀 총괄/파트 스코프에서만 대상자 확정).
    if (!teamId) return [];
    const teamName = await resolveTeamName(teamId, organization);
    if (!teamName) return [];
    // 시즌 휴식 제외는 주차 로스터(loadTeamWeekEffectiveRoster) 안에서 이미 적용된다 — 여기서 덧붙이지 않는다.
    //   partName 있음(파트 스코프) = 파트 "소속" 판정(파트장 포함, 엘리트·바사노스 제외) — listPartMembers.
    //   partName 없음(팀 총괄) = 팀 "소속" 판정(파트 소속·미배정·파트장 포함, 엘리트·바사노스 제외) — listTeamMembers.
    const crews = partName
      ? await listPartMembers(organization, teamName, partName, mode, weekId ?? null)
      : await listTeamMembers(organization, teamName, mode, weekId ?? null);
    return dedup(crews.map((c) => c.userId));
  }

  // 비팀 허브(info/competency/club) — 카페 검수 매칭 모집단과 동일(org+mode). QA_HIDE_REAL_USERS 도
  //   resolveUserScope 안에서 동일하게 반영되므로 "화면 대상자 == 매칭 후보 == C 모집단" 이 유지된다.
  //   ⚠ 집합 ② **실무 평가 가능 모집단**을 적용한다(2026-07-27 정책) — 시즌 휴식 · (효력 발생 후)
  //     활동 중단 · 엘리트 · 바사노스 제외. 팀 허브(주차 로스터)와 **같은 공통 모듈**이 판정한다.
  //     기준 시점 = 이 체크의 주차(현재 시점 고정 아님). 상태 문자열을 여기서 비교하지 않는다.
  const resolved = await resolveUserScope(mode, organization);
  const [crews, weekStart] = await Promise.all([
    loadCrewRecords(organization),
    resolveWeekStartDateForWeekId(weekId ?? null),
  ]);
  const scoped = resolved.filter(crews, (c) => c.userId);
  const eligibilityWeekStart =
    weekStart ?? (await resolveCurrentWeekStartDate(getCurrentActivityDateIso()));
  if (!eligibilityWeekStart) return dedup(scoped.map((c) => c.userId));
  const eligibility = await loadEvaluationEligibility({
    userIds: scoped.map((c) => c.userId),
    weekStartDate: eligibilityWeekStart,
  });
  return dedup(scoped.filter((c) => eligibility.isEvaluable(c.userId)).map((c) => c.userId));
}

function dedup(ids: Array<string | null | undefined>): string[] {
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id)))).sort();
}
