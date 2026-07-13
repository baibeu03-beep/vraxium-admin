// 프로세스 체크 "체크 대상자 로스터" 해소 — 각 체크가 실제로 사용한 스코프를 그대로 재현.
// ─────────────────────────────────────────────────────────────────────
//   Point C(패널티)는 "비대상자(unselectedUsers) = checkScopeRoster − matchedPerformers" 에게 지급한다.
//   그 모집단(roster)은 어디에도 저장돼 있지 않으므로 체크 시점 스코프에서 재계산한다.
//
//   ⚠ 새로운 roster 판정 규칙을 만들지 않는다 — 현재 체크 화면/검수가 대상자로 삼는 "기존 공통 조회
//     로직"을 그대로 재사용한다(UI 체크 대상자 == Point C 모집단). 허브별 기준:
//       · experience(팀 구분): 파트 스코프 → listPartCrews / 팀 총괄(part=NULL) → listTeamCrews
//         (= 화면 "체크 대상 크루 수" 산출 로직. 파트장/팀장·휴식·미배정 파트 제외.)
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
import { listPartCrews, listTeamCrews } from "@/lib/adminExperiencePartInput";
import { isTeamBasedProcessHub } from "@/lib/adminProcessCheckTypes";
import type { ProcessHub } from "@/lib/adminProcessesTypes";
import type { OrganizationSlug } from "@/lib/organizations";

export type CheckScope = {
  hub: ProcessHub;
  organization: OrganizationSlug | null;
  mode: ScopeMode;
  teamId: string | null;
  partName: string | null;
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
  const { hub, organization, mode, teamId, partName } = scope;
  if (!organization) return []; // org 불명 → 로스터 불명(fail-closed, C 미지급).

  if (isTeamBasedProcessHub(hub)) {
    // experience — 팀 미선택 상태행은 로스터 불명(팀 총괄/파트 스코프에서만 대상자 확정).
    if (!teamId) return [];
    const teamName = await resolveTeamName(teamId, organization);
    if (!teamName) return [];
    const crews = partName
      ? await listPartCrews(organization, teamName, partName, mode)
      : await listTeamCrews(organization, teamName, mode);
    return dedup(crews.map((c) => c.userId));
  }

  // 비팀 허브(info/competency/club) — 카페 검수 매칭 모집단과 동일(org+mode). QA_HIDE_REAL_USERS 도
  //   resolveUserScope 안에서 동일하게 반영되므로 "화면 대상자 == 매칭 후보 == C 모집단" 이 유지된다.
  const resolved = await resolveUserScope(mode, organization);
  const crews = await loadCrewRecords(organization);
  return dedup(resolved.filter(crews, (c) => c.userId).map((c) => c.userId));
}

function dedup(ids: Array<string | null | undefined>): string[] {
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id)))).sort();
}
