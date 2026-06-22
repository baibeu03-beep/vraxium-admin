// 시즌/주차 단위 직책(포지션) — 단일 SoT 로직.
//   - PMS useractivities 행 디코드(decodePmsPosition)
//   - 시즌 대표 포지션 산정(resolveSeasonPosition: 3주룰 + 최다수행 fallback)
//   - position_code ↔ 표시 라벨(PositionLabel) 매핑
//
// 이력서 resume-activities(lib/cluster1ResumeData) 와 이관 스크립트
// (scripts/ingest-position-histories) 가 같은 규칙을 쓰도록 여기로 통일한다.

import type { PositionLabel } from "@/lib/cluster1ResumeTypes";

export type PositionCode =
  | "regular"
  | "advanced_agent"
  | "advanced_part_leader"
  | "operating_team_leader"
  | "operating_ambassador"
  | "operating_club_leader";

// 표시 우선순위(낮음→높음). 동일 레벨:
//   advanced_agent == advanced_part_leader, operating_team_leader == operating_ambassador.
export const POSITION_RANK: Record<PositionCode, number> = {
  regular: 1,
  advanced_agent: 2,
  advanced_part_leader: 2,
  operating_team_leader: 3,
  operating_ambassador: 3,
  operating_club_leader: 4,
};

export const POSITION_CODE_TO_LABEL: Record<PositionCode, PositionLabel> = {
  regular: "일반(정규)",
  advanced_agent: "심화(에이전트)",
  advanced_part_leader: "심화(파트장)",
  operating_team_leader: "운영진(팀장)",
  operating_ambassador: "운영진(앰배서더)",
  operating_club_leader: "운영진(클럽장)",
};

// PositionLabel → PositionCode (현재 membership/role fallback 경로에서 역매핑).
export const LABEL_TO_POSITION_CODE: Record<PositionLabel, PositionCode> = {
  "일반(정규)": "regular",
  "심화(에이전트)": "advanced_agent",
  "심화(파트장)": "advanced_part_leader",
  "운영진(팀장)": "operating_team_leader",
  "운영진(앰배서더)": "operating_ambassador",
  "운영진(클럽장)": "operating_club_leader",
};

// PMS useractivities (UserLevel/UserTeam/UserPart) → PositionCode.
//   직책 신호가 세 컬럼에 흩어져 있고(컬럼 스왑·오타·공백) 있어, 세 값을 합쳐 키워드를
//   우선순위(높음→낮음)로 스캔한다. 실증(scripts/diag-pms-operator-decode):
//     앰배서더 → operating_ambassador
//     팀장/팀장진 → operating_team_leader
//     클럽 → operating_club_leader (PMS 주차데이터엔 미발견 — 안전망)
//     파트장 → advanced_part_leader
//     에이전트/심화 → advanced_agent (심화 기본 = 에이전트)
//     그 외 → regular
export function decodePmsPosition(
  level: string | null,
  team: string | null,
  part: string | null,
): PositionCode {
  const hay = `${level ?? ""} ${team ?? ""} ${part ?? ""}`;
  if (hay.includes("앰배서더")) return "operating_ambassador";
  if (hay.includes("팀장")) return "operating_team_leader"; // "팀장진" 포함
  if (hay.includes("클럽")) return "operating_club_leader";
  if (hay.includes("파트장")) return "advanced_part_leader";
  if (hay.includes("에이전트")) return "advanced_agent";
  if (hay.includes("심화")) return "advanced_agent";
  return "regular";
}

// 같은 주차에 여러 useractivities 행이 있을 때 그 주차 대표 = 가장 높은 직책.
export function higherPosition(a: PositionCode, b: PositionCode): PositionCode {
  return POSITION_RANK[a] >= POSITION_RANK[b] ? a : b;
}

// 시즌 대표 포지션 산정.
//   입력 = 그 시즌의 주차별 PositionCode 배열(주차당 1개).
//   규칙(정책 #3):
//     1) 가장 높은 포지션부터 검사해 "그 포지션을 3주 이상 수행"한 최초 포지션을 채택.
//     2) 3주 이상인 포지션이 없으면 → 최다 수행 포지션(주차수 동수면 더 높은 직책).
//   빈 배열이면 null(호출부에서 현재 membership/role fallback).
export function resolveSeasonPosition(
  weeklyCodes: PositionCode[],
): PositionCode | null {
  if (weeklyCodes.length === 0) return null;

  const counts = new Map<PositionCode, number>();
  for (const c of weeklyCodes) counts.set(c, (counts.get(c) ?? 0) + 1);

  // 1) 높은 직책부터 3주 이상 검사.
  const present = [...counts.keys()].sort(
    (a, b) => POSITION_RANK[b] - POSITION_RANK[a],
  );
  for (const code of present) {
    if ((counts.get(code) ?? 0) >= 3) return code;
  }

  // 2) fallback: 최다 수행(동수 → 높은 직책).
  let best: PositionCode = present[0];
  for (const code of present) {
    const c = counts.get(code) ?? 0;
    const bc = counts.get(best) ?? 0;
    if (c > bc || (c === bc && POSITION_RANK[code] > POSITION_RANK[best])) {
      best = code;
    }
  }
  return best;
}

export const PMS_POSITION_SOURCE = "pms_useractivities" as const;
