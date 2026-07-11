/**
 * 주차별 활동 인정 개수 N — 순수 계산(SoT).  [Phase 3 아티팩트 · 오픈확인 API 미연결]
 *
 * 정책(2026-07-11 확정):
 *  - A(최소자) = 오픈확인된 `<필수>`(act_type='required') 액트 + `[실무 경험]`(hub='experience')
 *                오픈 라인을 최소 조건으로 이행했을 때 획득 가능한 (Point.A + Point.B) 총합.
 *  - B(성실자) = 오픈확인된 모든 액트(basic 제외) + 모든 오픈 라인(info/experience/competency)을
 *                이행했을 때 획득 가능한 (Point.A + Point.B) 총합.
 *  - 제외: Point.C(penalty) · 수동 지급 · 우수 결과물 보너스 · 평가/등수/경쟁 기반 포인트.
 *  - N = round(A + 0.4 × (B − A))   ( 0.4 = 2/5, 반올림 int )
 *
 * 이 함수는 DB/조직/모드에 의존하지 않는 순수 함수다(일반=test 동일 함수). "어떤 액트가
 * 가동/필수인지", "어떤 라인이 오픈됐는지", "각 항목의 Point.A/B" 해석은 호출부(오픈확인 확정
 * 설정 + 허브별 포인트 SoT)의 책임이다. 이 함수는 정규화된 입력만 받는다 —
 * 표시 문자열/라벨/순서/인덱스가 아니라 이미 해석된 id·hub·actType·isOpen·pointA·pointB.
 * Point.C 는 설계상 입력에 없다.
 */

// 액트 종류 — process_acts.act_type SoT (basic 은 모든 포인트 합계에서 제외되는 기존 정책과 동일).
export type RecognitionActType = "required" | "optional" | "selection" | "basic";

// N 계산에 들어가는 정규화된 액트 입력.
export type RecognitionActInput = {
  id: string;
  actType: RecognitionActType;
  // 가동 여부 = 오픈확인 && (해당 라인/허브 체크) && check_target='check'. 호출부가 판정.
  isOpen: boolean;
  // 확정적 이행으로 얻는 포인트만. Point.A=point_check(성장), Point.B=point_advantage(우위).
  pointA: number;
  pointB: number;
};

// N 계산에 들어가는 정규화된 라인 입력(career/club 은 이 흐름에서 제외 — 넘기지 않는다).
export type RecognitionLineInput = {
  id: string;
  hub: "info" | "experience" | "competency";
  // 오픈 여부 = 오픈확인 기준 활성(admin 개설 의도). 호출부가 판정.
  isOpen: boolean;
  pointA: number;
  pointB: number;
};

export type RecognitionCountInput = {
  acts: RecognitionActInput[];
  lines: RecognitionLineInput[];
  // 최소자→성실자 보간 계수(기본 2/5). 정책 고정이나 테스트/향후 조정을 위해 주입 가능.
  minimalToDiligentFactor?: number;
};

export type RecognitionCountResult = {
  minimalA: number; // A(최소자)
  diligentB: number; // B(성실자)
  recognitionCountN: number; // round(A + f × (B − A))
  calcVersion: number; // 산식 버전(감사/재현용)
};

// 산식 버전 — 저장 시 cluster4_week_opening_configs.recognition_calc_version 에 기록.
export const RECOGNITION_CALC_VERSION = 1;
// 정책 고정 계수 2/5.
export const RECOGNITION_MINIMAL_TO_DILIGENT_FACTOR = 2 / 5;

// Point.A + Point.B 단순 합산(정책3). 음수 방어(0 하한).
function pts(a: number, b: number): number {
  return Math.max(0, a) + Math.max(0, b);
}

export function computeWeekRecognitionCount(input: RecognitionCountInput): RecognitionCountResult {
  const factor = input.minimalToDiligentFactor ?? RECOGNITION_MINIMAL_TO_DILIGENT_FACTOR;
  let minimalA = 0;
  let diligentB = 0;

  for (const act of input.acts) {
    if (!act.isOpen) continue; // 가동 액트만
    const p = pts(act.pointA, act.pointB);
    if (act.actType === "required") minimalA += p; // A: 필수 액트만
    if (act.actType !== "basic") diligentB += p; // B: basic 제외 전 액트
  }
  for (const line of input.lines) {
    if (!line.isOpen) continue; // 오픈 라인만
    const p = pts(line.pointA, line.pointB);
    if (line.hub === "experience") minimalA += p; // A: [실무 경험] 라인만
    diligentB += p; // B: 모든 오픈 라인
  }

  // 구성상 (필수 액트 ⊂ basic제외 액트) 이고 (experience 라인 ⊂ 전체 라인) 이므로 B ≥ A.
  const recognitionCountN = Math.round(minimalA + factor * (diligentB - minimalA));
  return { minimalA, diligentB, recognitionCountN, calcVersion: RECOGNITION_CALC_VERSION };
}
