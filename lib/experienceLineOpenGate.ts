// 실무 경험 라인 개설 "개설 기간" 게이트(단일 SoT) — 서버 강제.
//
// 판정 원천 = cluster4_week_opening_configs(loadWeekOpeningConfig) → weekOpenGate.isExperienceLineOpenForWeek.
//   (org, weekId) 의 주차 운영 설정에서 open_confirmed && practicalExperience[teamId] 중 하나라도 체크일 때만
//   개설 허용. 실무 정보(info-lines)·실무 역량(competency-lines) POST 게이트와 동일 패턴·동일 SoT.
//   ⚠ mode(operating/test)·actAsTestUserId·demoUserId 로 분기하지 않는다 — 스코프 확정 후 동일 config·동일 판정.
//   ⚠ org 미지정(통합)은 단일 클럽 config 가 없어 게이트를 적용하지 않는다(info/competency 와 동일 — 호출부가
//     org 유무로 게이트 여부를 정한다). resolveExperienceLineOpenGate 자체는 org=null 을 false 로 본다.

import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import {
  isExperienceExpansionOpenForWeek,
  isExperienceLineOpenForWeek,
} from "@/lib/weekOpenGate";
import { isOrganizationSlug } from "@/lib/organizations";

// 개설 기간이 아니어서 개설을 거부할 때의 사유 문구 — API(409)·상태창 DTO(openBlockedReason)·UI 차단 패널 공용.
export const EXPERIENCE_LINE_NOT_OPEN_REASON =
  "선택한 주차는 실무 경험 라인의 개설 기간이 아닙니다.";

// 개설 기간 게이트 판정 — (org, weekId, teamId) 의 주차 운영 설정에서 개설 가능하면 true.
//   org/weekId 미지정이면 false(fail-closed). teamId 미지정=허브 전체 판정.
export async function resolveExperienceLineOpenGate(
  org: string | null,
  weekId: string | null,
  teamId?: string | null,
): Promise<boolean> {
  if (!org || !weekId || !isOrganizationSlug(org)) return false;
  const { config, openConfirmed } = await loadWeekOpeningConfig(weekId, org);
  return isExperienceLineOpenForWeek({ openConfirmed, config, teamId });
}

// 그 주차·팀의 실무 경험 개설 상태(개설 기간 + 확장 류 활성)를 **config 1회 조회**로 함께 해소한다.
//   두 값 모두 같은 주차 최신 설정(cluster4_week_opening_configs)에서 나오므로 원천이 갈라질 수 없고,
//   보드 조회처럼 둘 다 필요한 경로에서 DB 왕복이 늘지 않는다.
//   ⚠ 확장 활성(expansionActive)의 SoT 는 여기(주차 최신 저장 설정)뿐이다 — 확장 기간 원장
//     (cluster4_experience_extension_periods)은 종류(online/offline) 표시 힌트로만 쓰고 활성 판정에 쓰지 않는다.
export async function resolveExperienceOpenState(
  org: string | null,
  weekId: string | null,
  teamId?: string | null,
): Promise<{ canOpen: boolean; expansionActive: boolean }> {
  if (!org || !weekId || !isOrganizationSlug(org)) {
    return { canOpen: false, expansionActive: false };
  }
  const { config, openConfirmed } = await loadWeekOpeningConfig(weekId, org);
  return {
    canOpen: isExperienceLineOpenForWeek({ openConfirmed, config, teamId }),
    expansionActive: isExperienceExpansionOpenForWeek({ openConfirmed, config, teamId }),
  };
}

// 확장 류 활성 판정 단독 조회 — 주차 최신 설정 단일 SoT(위 resolveExperienceOpenState 와 동일 값).
export async function resolveExperienceExpansionActive(
  org: string | null,
  weekId: string | null,
  teamId?: string | null,
): Promise<boolean> {
  return (await resolveExperienceOpenState(org, weekId, teamId)).expansionActive;
}

// 개설 write 직전 강제 가드 — 개설 기간이 아니면 409 throw(모든 write 이전). URL/HTTP 직접 호출로도 우회 불가.
//   org=null(통합)은 호출부에서 이 함수를 건너뛴다(info/competency 와 동일 정책) — 여기 도달하면 항상 org 필요.
export async function assertExperienceLineOpenable(
  org: string,
  weekId: string,
  teamId?: string | null,
): Promise<void> {
  if (!(await resolveExperienceLineOpenGate(org, weekId, teamId))) {
    throw Object.assign(new Error(EXPERIENCE_LINE_NOT_OPEN_REASON), { status: 409 });
  }
}
