// 주차별 "가동(액트) / 오픈(라인)" 판정 단일 SoT — 순수 함수(브라우저 안전).
//
// 모든 어드민 화면·API 가 이 함수를 공유해 동일 판정을 보장한다:
//   · 활동 관리 상세(클럽 정보 > 주차 내역)  — lib/adminTeamPartsInfoActCheckData.ts
//   · 프로세스 체크 보드(/admin/processes/check/{hub}) — lib/adminProcessCheckData.ts
//   · 라인 관리 / 라인 개설(주차별 개설 결과·실무 정보 개설) — 2단계 라인 작업에서 소비.
//
// 판정 원천 = cluster4_week_opening_configs(loadWeekOpeningConfig) — 오픈 설정 config + open_confirmed.
//   ⚠ open_confirmed=false(오픈 확인 전) → 아무 것도 가동/오픈 아님(활동 관리 SoT 동일).
//   ⚠ mode(operating/test)·actAsTestUserId·demoUserId 로는 분기하지 않는다 — 스코프를 정한 뒤에는
//     동일 config·동일 판정 함수를 쓴다(응답·차단 동작이 운영/테스트 동일).

import type { SavedConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";

// 오픈 설정(config)이 액트 가동을 게이팅하는 허브 — cluster4_week_opening_configs 도메인.
//   그 외 허브(career 등)는 오픈 설정 대상이 아니므로 게이트를 적용하지 않는다(기존 동작 불변).
export const OPEN_GATED_ACT_HUBS = ["info", "experience", "competency", "club"] as const;
export type OpenGatedActHub = (typeof OPEN_GATED_ACT_HUBS)[number];
export function isOpenGatedActHub(hub: string): hub is OpenGatedActHub {
  return (OPEN_GATED_ACT_HUBS as readonly string[]).includes(hub);
}

// 액트가 이번 주 "가동" 대상인가 — 오픈 확인 + 소속 라인급(체크) 선택.
//   info/club   = actCheck.<hub>[lineGroupId] ?? true (설정 없는 과거 확정 주차는 전 라인급 체크 간주)
//   experience  = actCheck.experience[teamId][lineGroupId] ?? true
//   competency  = practicalCompetency.checked === true (라인급 단위 없음 — 허브 공유 플래그)
//   lineGroupId 미상(정규 분류 불가)인 액트는 가동 아님(false). 게이트 미대상 허브는 항상 true.
export function isActOpenForWeek(opts: {
  hub: string;
  openConfirmed: boolean;
  config: SavedConfig | null;
  lineGroupId: string | null;
  teamId?: string | null;
}): boolean {
  const { hub, openConfirmed, config, lineGroupId, teamId } = opts;
  if (!isOpenGatedActHub(hub)) return true; // career 등 — 오픈 설정 대상 아님(기존 동작 유지).
  if (!openConfirmed) return false; // 오픈 확인 전에는 아무 것도 가동 아님.
  const actCfg = config?.actCheck ?? {};
  switch (hub) {
    case "info":
      return lineGroupId != null ? actCfg.info?.[lineGroupId] ?? true : false;
    case "club":
      return lineGroupId != null ? actCfg.club?.[lineGroupId] ?? true : false;
    case "experience":
      return lineGroupId != null && teamId != null
        ? actCfg.experience?.[teamId]?.[lineGroupId] ?? true
        : false;
    case "competency":
      return config?.practicalCompetency?.checked === true;
  }
  return false;
}

// 실무 정보 라인(활동유형)이 이번 주 "오픈(개설 대상)" 인가 — 오픈 확인 + practicalInfo[activityTypeId] 체크.
//   ⚠ 액트와 달리 "설정 없음 = 미오픈"(=== true 엄격) 이다 — 라인은 명시적으로 체크된 것만 개설 대상.
//     (라인 개설 관리 4카운트 보드 lib/adminTeamPartsInfoLineOpeningData.ts 와 동일 SoT.)
//   open_confirmed=false → 전 라인 미오픈.
export function isInfoLineOpenForWeek(opts: {
  openConfirmed: boolean;
  config: SavedConfig | null;
  activityTypeId: string;
}): boolean {
  if (!opts.openConfirmed) return false;
  return opts.config?.practicalInfo?.[opts.activityTypeId] === true;
}
