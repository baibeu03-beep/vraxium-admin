/**
 * 주차별 활동 인정 개수 N — 순수 계산(SoT).
 *
 * 정책(2026-07-11 최초 · 2026-07-27 평점 기준 도입으로 개정):
 *  - A(최소자) = 오픈확인된 `<필수>`(act_type='required') 액트 + `[실무 경험]` 오픈 라인 중
 *                도출·분석·견문을 **최소자 수준**으로 이행했을 때 획득 가능한 총합.
 *  - B(성실자) = 오픈확인된 모든 액트(basic 제외) + 모든 오픈 라인(info/experience/competency)을
 *                **성실자 수준**으로 이행했을 때 획득 가능한 총합.
 *  - 제외: Point.C(penalty) · 수동 지급 · 우수 결과물 보너스 · 등수/경쟁 기반 포인트.
 *  - N = round(A + 0.4 × (B − A))   ( 0.4 = 2/5, 반올림 int )
 *
 * ── 2026-07-27 개정: "강화 시 포인트" 와 "평점" 은 서로 다른 개념이다 ─────────────
 *   강화 시 포인트 = cluster4_line_point_configs 고정 설정값 = max(0,point_a)+max(0,point_b).
 *   평점           = 크루가 실제로 받는 점수. 주차 기준값에서는 **실제 평점을 쓰지 않고**
 *                    최소자 4점 / 성실자 7점이라는 **기준 평점**을 쓴다(평균·합산 아님).
 *   따라서 오픈된 실무 경험 라인 1칸의 기여분은
 *       A 쪽: (강화 시 포인트 + 4)   ·   B 쪽: (강화 시 포인트 + 7)
 *   이며, 두 값은 서로 대체하지 않고 **더해진다**.
 *
 *   대상 라인은 도출·분석·견문 뿐이다. 관리는 특정 인원만 수행하므로 조직 공통 기준에서 제외하고,
 *   확장도 이번 정책 대상이 아니다 — 둘 다 A·B·N 어디에도 들어가지 않는다(role="excluded").
 *   ⚠ 관리 라인의 **개인** 적립(강화 시 포인트 + 실제 평점)은 별개 경로다
 *     (lib/processPointAccrual.ts reconcileLineResultAwardForUser) — 이 함수와 무관.
 *
 * 이 함수는 DB/조직/모드에 의존하지 않는 순수 함수다(일반=test 동일 함수). "어떤 액트가
 * 가동/필수인지", "어떤 라인 칸이 오픈됐는지", "각 항목의 Point.A/B·기준 평점" 해석은 호출부
 * (오픈확인 확정 설정 + 허브별 포인트 SoT = lib/weekRecognitionResolve.ts)의 책임이다.
 * 이 함수는 정규화된 입력만 받는다 — 표시 문자열/라벨/순서/인덱스가 아니라 이미 해석된
 * id·hub·actType·isOpen·pointA·pointB·role·ratingMinimal·ratingDiligent.
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

// 라인 1칸이 A/B 기준에 기여하는 역할(2026-07-27).
//   minimal_and_diligent : 실무 경험 도출·분석·견문 — A·B 양쪽에 기여(기준 평점 가산 포함).
//   diligent_only        : 실무 정보 · 실무 역량 — 성실자(B)에만 기여(기존 정책 불변).
//   excluded             : 실무 경험 관리·확장 — A·B·N 어디에도 기여하지 않음.
export type RecognitionLineRole = "minimal_and_diligent" | "diligent_only" | "excluded";

// N 계산에 들어가는 정규화된 라인 입력(career/club 은 이 흐름에서 제외 — 넘기지 않는다).
//   ⚠ 실무 경험은 **팀 × 카테고리 = 표의 체크 셀 1칸**이 입력 1건이다(2026-07-27). 체크된 셀 수만큼
//     행이 들어오며 그 수만큼 합산된다. 조직·주차당 카테고리별 1회로 접던 종전(2026-07-19) 규칙은
//     폐기 — `/admin/team-parts/info/weeks/*` 의 `[실무 경험] 라인(오픈)` 표가 보여주는 그대로 센다.
export type RecognitionLineInput = {
  id: string;
  hub: "info" | "experience" | "competency";
  // 오픈 여부 = 오픈확인 기준 활성(admin 개설 의도). 호출부가 판정.
  isOpen: boolean;
  // 강화 시 포인트(설정값). 실제 평점과 무관한 고정값 — 아래 rating* 과 더해지며 대체되지 않는다.
  pointA: number;
  pointB: number;
  // 미지정 시 hub 기본값(experience=minimal_and_diligent · 그 외=diligent_only) — 구 입력 호환.
  role?: RecognitionLineRole;
  // 기준 평점 가산. 실제 평점이 아니라 정책 상수(최소자 4 / 성실자 7). 대상 아닌 라인은 0/미지정.
  ratingMinimal?: number;
  ratingDiligent?: number;
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
//   v1 = 2026-07-11 최초(실무 경험 = 조직·주차당 카테고리별 1회, 평점 기준 없음)
//   v2 = 2026-07-27 평점 기준 도입(팀별 오픈 셀 단위 합산 + 최소자 4 / 성실자 7, 관리·확장 제외)
export const RECOGNITION_CALC_VERSION = 2;
// 정책 고정 계수 2/5.
export const RECOGNITION_MINIMAL_TO_DILIGENT_FACTOR = 2 / 5;

// 주차 기준 평점(정책 상수 · 실제 평점 아님). 최소자 4점 / 성실자 7점.
export const RECOGNITION_MINIMAL_RATING = 4;
export const RECOGNITION_DILIGENT_RATING = 7;

// Point.A + Point.B 단순 합산(= "강화 시 포인트"). 음수/누락 방어(0 하한).
function pts(a: number, b: number): number {
  return Math.max(0, a) + Math.max(0, b);
}

// 기준 평점 가산분 — 음수/미지정 방어(0 하한).
function bonus(v: number | undefined): number {
  return Math.max(0, v ?? 0);
}

// role 미지정 입력의 하위호환 기본값(구 호출부·테스트 입력).
function roleOf(line: RecognitionLineInput): RecognitionLineRole {
  return line.role ?? (line.hub === "experience" ? "minimal_and_diligent" : "diligent_only");
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
    if (!line.isOpen) continue; // 오픈(체크)된 칸만
    const role = roleOf(line);
    if (role === "excluded") continue; // 실무 경험 관리·확장 — A·B 양쪽 제외
    // 강화 시 포인트(설정값)와 기준 평점은 **독립 요소**다. 환산하지 않고 더한다.
    const p = pts(line.pointA, line.pointB);
    if (role === "minimal_and_diligent") minimalA += p + bonus(line.ratingMinimal);
    diligentB += p + bonus(line.ratingDiligent);
  }

  // 구성상 (필수 액트 ⊂ basic제외 액트) 이고, A 기여 라인은 B 에도 같은 p 로 기여하며
  //   기준 평점이 4 ≤ 7 이므로 라인별 기여도 B ≥ A → 전체 B ≥ A.
  const recognitionCountN = Math.round(minimalA + factor * (diligentB - minimalA));
  return { minimalA, diligentB, recognitionCountN, calcVersion: RECOGNITION_CALC_VERSION };
}
