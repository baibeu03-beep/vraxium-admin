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

// 실무 경험 라인(팀 단위)이 이번 주 "오픈(개설 대상)" 인가 — 오픈 확인 + practicalExperience[teamId]
//   중 하나라도 체크(=== true). 실무 정보(isInfoLineOpenForWeek)와 동일한 엄격 규칙:
//   "설정 없음 / open_confirmed=false = 미오픈"(fallback true 없음). 개설 기간(isOpeningPeriod)의 단일 SoT.
//   ⚠ 팀 총괄 [개설 완료]는 팀 단위이므로 teamId 로 판정한다. teamId 미지정(허브 전체 상태창)일 때는
//     어느 팀이든 하나라도 체크돼 있으면 true(허브 단위 개설 기간 판정). mode/actAs/demo 무분기.
export function isExperienceLineOpenForWeek(opts: {
  openConfirmed: boolean;
  config: SavedConfig | null;
  teamId?: string | null;
}): boolean {
  if (!opts.openConfirmed) return false;
  const exp = opts.config?.practicalExperience;
  if (!exp) return false;
  const teamHasAnyChecked = (
    team: Partial<Record<string, boolean>> | undefined,
  ): boolean => team != null && Object.values(team).some((v) => v === true);
  if (opts.teamId != null) return teamHasAnyChecked(exp[opts.teamId]);
  // 허브 전체 — 어느 팀이든 하나라도 체크되어 있으면 개설 기간.
  return Object.values(exp).some((team) => teamHasAnyChecked(team));
}

// ── [오픈 확인] 재실행 타임라인(시점 경계) ────────────────────────────────────
//   재실행 정책: 각 액트는 "그 액트의 발생 예정 시각(occur)에 유효했던 config 버전"으로 가동을 판정한다.
//   변경 이전 액트는 구설정 유지, 변경 이후 액트만 신설정 적용(과거 기록 보존·미래만 변경).
//   라인 오픈(개설)은 시점 경계 대상이 아님 — 최신 config 로 판정한다(isInfoLineOpenForWeek 등 불변).

// 설정 버전 1개 — config + 유효 시작 시각(ms). effectiveFromMs 오름차순으로 정렬돼 있다고 가정.
export type TimelineVersion = { config: SavedConfig | null; effectiveFromMs: number };

// 액트 시점 게이트 입력 — 타임라인 로더(loadWeekOpeningTimeline) 반환의 상위집합.
export type ActOpenTimeline = {
  openConfirmed: boolean; // live 마스터 스위치(cluster4_week_opening_configs.open_confirmed)
  latestConfig: SavedConfig | null; // 최신 버전 config(= 부모 테이블 .config). 라인·폴백용.
  versions: readonly TimelineVersion[]; // effectiveFromMs ASC. 비어 있음 = 이력 없음.
  timelineAvailable: boolean; // 버전 테이블 적용 여부(미적용이면 latestConfig 폴백).
};

// occurMs 시각에 유효했던 config 버전 선택 — effectiveFromMs <= occurMs 중 "최신".
//   occurMs 가 첫 버전보다 앞서면 첫 버전(floor-to-earliest: 최초 오픈 확인이 그 주 전체를 지배 →
//   최초 확인 동작은 오늘과 동일, 정밀 경계는 재실행 델타에만 적용). versions 비어 있으면 null.
export function resolveConfigAtTime(
  versions: readonly TimelineVersion[],
  occurMs: number,
): SavedConfig | null {
  if (versions.length === 0) return null;
  let chosen: TimelineVersion | null = null;
  for (const v of versions) {
    if (v.effectiveFromMs <= occurMs) chosen = v;
    else break; // ASC 정렬 가정 — 이후는 모두 미래 버전.
  }
  return (chosen ?? versions[0]).config;
}

// 액트가 "그 액트 예정 시각에" 가동 대상인가 — 시점 버전 config 를 골라 기존 isActOpenForWeek 에 위임.
//   timelineAvailable=false(마이그 전) 또는 occurMs=null(예외 액트)이면 latestConfig 사용 = 오늘 동작(안전).
//   mode/actAs/demo 무분기(스코프 확정 후 동일 타임라인·동일 판정).
export function isActOpenAtTime(opts: {
  hub: string;
  timeline: ActOpenTimeline;
  occurMs: number | null;
  lineGroupId: string | null;
  teamId?: string | null;
}): boolean {
  const { hub, timeline, occurMs, lineGroupId, teamId } = opts;
  const config =
    timeline.timelineAvailable && occurMs != null && timeline.versions.length > 0
      ? resolveConfigAtTime(timeline.versions, occurMs)
      : timeline.latestConfig;
  return isActOpenForWeek({ hub, openConfirmed: timeline.openConfirmed, config, lineGroupId, teamId });
}

// 실무 역량 라인이 이번 주 "오픈(개설 대상)" 인가 — 오픈 확인 + practicalCompetency.checked === true.
//   ⚠ 실무 역량은 라인급 단위가 없어(허브 공유 플래그) 액트 가동(isActOpenForWeek hub="competency")과
//     "완전히 같은" 단일 SoT(practicalCompetency.checked)를 쓴다 — 프로세스 체크(가동)와 라인 개설(오픈)이
//     동일한 주차 운영 설정으로 판정된다. info 라인과 마찬가지로 "설정 없음 / open_confirmed=false = 미오픈"
//     엄격(=== true). fallback true 없음.
export function isCompetencyLineOpenForWeek(opts: {
  openConfirmed: boolean;
  config: SavedConfig | null;
}): boolean {
  if (!opts.openConfirmed) return false;
  return opts.config?.practicalCompetency?.checked === true;
}
