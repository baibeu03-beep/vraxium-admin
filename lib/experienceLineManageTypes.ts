// 실무 경험 [라인 관리] 탭 — 팀 요약 보드 공용 타입(browser-safe, DB 무관).
//   데이터레이어(adminExperienceLineManage) · API · 컴포넌트(ExperienceLineManageBoard) · 검증 스크립트가 공유.
//
// 표시 전용 요약 — 팀 총괄(cluster4_experience_team_overall)의 라이브 보드를 팀마다 집계한다.
//   개설 완료/필요 판정 SoT = 팀 총괄 status(opened ↔ 개설 완료, 그 외 ↔ 개설 필요).
//   snapshot 생성/조회·고객 라인 강제 로직 무관(read-only).

import type { ExperienceOverallCategory } from "@/lib/experienceTeamOverallTypes";

// 라인(카테고리)별 강화 결과 집계.
//   - 미이행(unchecked)  = 체크 해제한 크루 수.
//   - 평점 미비(lowScore) = 체크했지만 score ≤ 3 인 크루 수.
//   - 강화 실패          = unchecked + lowScore.
//   - 강화 성공(success)  = total − 강화 실패.
//   - applicable=false   = 확장 라인이 확장 기간이 아님 → 숫자 대신 "해당 기간 아님" 표시.
export type LineManageCategoryStat = {
  category: ExperienceOverallCategory;
  label: string; // 도출 · 분석 · 견문 · 관리 · 확장
  applicable: boolean;
  total: number;
  success: number;
  unchecked: number;
  lowScore: number;
};

// 파트별 [개설 신청] 여부(색 칸/흰 칸 표시용). 팀 실제 파트 매핑 기준(하드코딩 없음).
export type LineManagePart = {
  partName: string;
  submitted: boolean;
};

// 팀 인원 요약(현재 멤버십 기준 크루 명부 — 일반/파트장/에이전트).
//   total = active + rest + suspended = normal + partLeader + agent (두 분류 모두 명부 전체를 분할).
//   상태(active/rest/suspended) = membership_state 분류(weekly_rest→휴식, 정지류→중단, 그 외→활동).
export type LineManageHeadcount = {
  total: number;
  active: number; // 활동
  rest: number; // 휴식
  suspended: number; // 중단
  normal: number; // 일반
  partLeader: number; // 파트장
  agent: number; // 에이전트
};

// 팀장(role=team_leader) 표시 정보. 학교/학과는 user_educations(canonical)→user_profiles 폴백.
//   팀장이 없으면 teamLeader=null(컴포넌트가 "팀장 정보 없음" 표기).
//   팀장은 있으나 학적이 없으면 school/department 둘 다 null("학적 정보 없음" 표기).
export type LineManageTeamLeader = {
  name: string;
  school: string | null;
  department: string | null;
};

// 팀장 표시 문구(컴포넌트/검증 공유) — "팀장: 홍길동 님 (00대학교 00학과)".
//   팀장 없음 → "팀장 정보 없음". 팀장은 있으나 학적 없음 → "팀장: 홍길동 님 (학적 정보 없음)".
export function formatTeamLeader(leader: LineManageTeamLeader | null): string {
  if (!leader) return "팀장 정보 없음";
  const academic = [leader.school, leader.department]
    .filter((v): v is string => !!v && v.trim() !== "")
    .join(" ");
  return `팀장: ${leader.name} 님 (${academic || "학적 정보 없음"})`;
}

export type LineManageTeam = {
  teamId: string;
  teamName: string;
  opened: boolean; // 팀 총괄 status === "opened".
  // 이 주차·팀이 실무 경험 라인 개설 기간인가(SoT = cluster4_week_opening_configs → board.canOpen).
  //   false 면 개설되지 않은 상태(개설 필요)와 구분해 "개설 기간 아님"으로 표시하고 개설 필요 안내를 하지 않는다.
  canOpen: boolean;
  statusLabel: "개설 완료" | "개설 필요" | "개설 기간 아님";
  parts: LineManagePart[];
  headcount: LineManageHeadcount;
  teamLeader: LineManageTeamLeader | null;
  categories: LineManageCategoryStat[];
};

export type LineManageWeek = {
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
};

export type ExperienceLineManageSummary = {
  // 개설 대상 주차(금요일 경계 = openable). 상태창/팀 총괄과 동일 SoT.
  targetWeek: LineManageWeek | null;
  extensionActive: boolean;
  extensionKind: "online" | "offline" | null;
  // neededCount = 개설 기간이면서(canOpen) 아직 미개설인 팀 수(개설 필요). notOpenCount = 개설 기간이 아닌 팀 수.
  totals: { teamCount: number; openedCount: number; neededCount: number; notOpenCount: number };
  teams: LineManageTeam[];
};
