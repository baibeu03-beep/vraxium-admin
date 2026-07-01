// Cluster4 "테스트 모드 휴식꼬리 주차 예외" 단일 SoT (browser-safe · DB 접근 없음).
// ─────────────────────────────────────────────────────────────────────────────
// 배경
//   정규 시즌은 활동 주차 뒤에 공식 휴식 주차가 붙는다(2026 봄 = 활동 W1~W13, 휴식 W14~W16).
//   "휴식 꼬리" 구간(오늘이 W14 이후)에서는 금요일 경계 규칙상 개설/체크 대상 주차가 휴식 주차로
//   넘어가, 마지막 활동 주차(2026 봄 = W13)를 더 이상 대상으로 잡지 못한다(운영·테스트 공통).
//
// 정책 (이 파일이 유일한 판단 출처)
//   1) 운영(operating) 모드는 기존 정책을 그대로 유지한다 — 절대 주차를 옮기지 않는다.
//   2) 테스트(test) 모드에서만 휴식 꼬리일 때 대상 주차를 "마지막 활동 주차(2026 봄 W13)"로
//      되돌린다(검증 목적). 어느 시즌의 어느 주차를 예외로 둘지는 CLUSTER4_TEST_EXCEPTION_WEEKS
//      한 곳에서 명시 관리한다(하드코딩 산재 금지).
//   3) 실사용자/운영 데이터에는 영향이 없다 — operating 은 분기 진입 자체가 없고, test 는
//      test_user_markers 스코프 가드(각 write 경로) 안에서만 효과가 발생한다.
//   4) snapshot 조회/생성·고객 weekly-cards DTO·demoUserId 경로는 mode-agnostic 으로 유지한다
//      (이 모듈은 "어드민 개설/체크/적립 대상 주차" 판정에만 쓰이며 고객 카드 계산엔 호출하지 않는다).
//
// hub/org 별 허용 정책은 TEST_WEEK_HUB_POLICY 에서 명시적으로 관리한다.
//   · 2026-06-16: 실무 경험의 기존 "encre 조직 한정" 제한은 사용자 결정으로 제거 — 전 조직 허용으로
//     통일(역량과 동일). 향후 특정 hub/org 로 좁힐 일이 생기면 이 맵만 수정한다.
// ─────────────────────────────────────────────────────────────────────────────

import { describeWeekByStartMs } from "@/lib/cluster4WeekPolicy";
import type { ScopeMode } from "@/lib/userScopeShared";
import { QA_FIXED_TEST_ONLY } from "@/lib/qaFixedScope";

// QA 고정 필터 정합(lib/qaFixedScope): QA 기간엔 전달 mode 와 무관하게 test 축으로 판정한다.
//   resolveUserScope(모집단)·filterTeamsByScope(팀 목록)와 동일하게, "대상 주차" 축도 QA 를
//   반영해야 운영 URL(mode 미부착)에서 휴식 꼬리 시 마지막 활동 주차(W13)를 개설/체크 대상으로
//   잡을 수 있다. QA 종료(false) 시 전달 mode 그대로(종전 동작).
function effectiveTestWeekMode(mode: ScopeMode): ScopeMode {
  return QA_FIXED_TEST_ONLY ? "test" : mode;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// 예외가 적용되는 (시즌, 마지막 활동 주차) 목록. 현재 2026 봄(정규 W1~W13)만 등록.
//   ⚠ 시즌이 바뀌어 휴식 꼬리 검증이 필요해지면 여기 한 줄만 추가한다. "13" 을 코드 곳곳에
//      흩어 하드코딩하지 않는다.
export const CLUSTER4_TEST_EXCEPTION_WEEKS: ReadonlyArray<{
  seasonKey: string;
  weekNumber: number;
}> = [{ seasonKey: "2026-spring", weekNumber: 13 }];

// 테스트 모드 W13 예외를 받는 기능(hub) 식별자 — 라인 개설 4허브 · 프로세스 체크 3종 ·
//   포인트 적립 · 주차 드롭다운. 모든 호출부는 이 키로 정책을 조회한다.
export type Cluster4TestWeekHub =
  | "info-line"
  | "experience-line"
  | "competency-line"
  | "career-line"
  | "process-club"
  | "process-info"
  | "process-experience"
  | "process-competency"
  | "process-career"
  | "process-irregular"
  | "accrual"
  | "dropdown";

// hub 별 허용 정책. allowed=예외 적용 여부, orgs=null(전 조직) | 특정 조직 화이트리스트.
//   현재 전 항목 전 조직 허용(경험 encre 제한 2026-06-16 제거). 명시 관리 — 좁힐 땐 여기만 수정.
const TEST_WEEK_HUB_POLICY: Record<
  Cluster4TestWeekHub,
  { allowed: boolean; orgs: readonly string[] | null }
> = {
  "info-line": { allowed: true, orgs: null },
  "experience-line": { allowed: true, orgs: null }, // 과거 encre 한정 → 전 조직 통일.
  "competency-line": { allowed: true, orgs: null },
  "career-line": { allowed: true, orgs: null },
  "process-club": { allowed: true, orgs: null }, // 2026-06-17 신규 허용(irregular 와 동일 정책).
  "process-info": { allowed: true, orgs: null },
  "process-experience": { allowed: true, orgs: null }, // 신규 허용(기존 미허용).
  "process-competency": { allowed: true, orgs: null }, // 2026-06-17 신규 허용(experience 와 동일 정책).
  "process-career": { allowed: true, orgs: null }, // 2026-06-17 신규 허용(experience 와 동일 정책).
  "process-irregular": { allowed: true, orgs: null },
  accrual: { allowed: true, orgs: null },
  dropdown: { allowed: true, orgs: null },
};

// (시즌, 주차번호) 가 테스트 예외 주차인지 — test 모드에서만 true.
//   processPointAccrual era 게이트가 직접 호출(주차 행의 season_key/week_number 로 판정).
export function isCluster4TestExceptionWeek(
  mode: ScopeMode,
  seasonKey: string | null,
  weekNumber: number | null,
): boolean {
  if (effectiveTestWeekMode(mode) !== "test") return false;
  if (seasonKey == null || weekNumber == null) return false;
  return CLUSTER4_TEST_EXCEPTION_WEEKS.some(
    (w) => w.seasonKey === seasonKey && w.weekNumber === weekNumber,
  );
}

// hub/org 정책상 이 호출부에서 테스트 예외가 허용되는지 — test 모드 + 정책 allowed + org 매칭.
export function isTestWeekExceptionAllowed(
  mode: ScopeMode,
  hub: Cluster4TestWeekHub,
  organization: string | null,
): boolean {
  if (effectiveTestWeekMode(mode) !== "test") return false;
  const policy = TEST_WEEK_HUB_POLICY[hub];
  if (!policy || !policy.allowed) return false;
  if (policy.orgs == null) return true; // 전 조직 허용.
  return organization != null && policy.orgs.includes(organization);
}

// 정규(금요일경계/현재) 대상 주차 시작 ms 를 받아, 테스트 예외가 적용되면 마지막 활동 주차
// (예: 2026 봄 W13) 시작 ms 로 폴드해 반환한다. 그 외에는 base 를 그대로 반환한다(불변).
//
//   · mode !== 'test' / hub·org 미허용        → base (운영 정책 불변)
//   · base 가 휴식 주차가 아님(활동 주차)       → base (정규 계산이 이미 올바름 — 옮기지 않음)
//   · base 가 휴식 주차(휴식 꼬리/전환)         → 직전으로 walk-back 하여 만나는 첫 "예외 주차" ms
//   · 예외 주차를 못 찾음(시즌 시작 이전 등)     → base (fail-safe = 운영 동작)
//
//   base==null 이면 null 을 그대로 반환한다(현재 주차 계산 실패 전파).
export function resolveCluster4TestOpenableWeekStartMs(
  mode: ScopeMode,
  baseStartMs: number | null,
  opts: { hub: Cluster4TestWeekHub; organization: string | null },
): number | null {
  if (baseStartMs == null) return null;
  if (!isTestWeekExceptionAllowed(mode, opts.hub, opts.organization)) {
    return baseStartMs;
  }
  const base = describeWeekByStartMs(baseStartMs);
  if (!base) return baseStartMs;
  if (!base.isOfficialRest) return baseStartMs; // 활동 주차 → 옮기지 않음.

  // 휴식 주차 → config 예외 주차를 만날 때까지 1주씩 뒤로(시즌 시작 이전이면 중단).
  let ms = baseStartMs;
  for (let i = 0; i < 24; i++) {
    ms -= WEEK_MS;
    const d = describeWeekByStartMs(ms);
    if (!d) break; // 시즌 시작 이전 → 더 못 감.
    if (isCluster4TestExceptionWeek("test", d.seasonKey, d.weekNumber)) return ms;
  }
  return baseStartMs; // 예외 주차 없음 → fail-safe(운영 동작).
}

// 어드민 테스트 모드의 "실효 개설/대상 주차" 시작 ms — 호출부 가독성용 별칭.
//   resolveCluster4TestOpenableWeekStartMs 와 동일(개설·드롭다운·프로세스 체크 공용 진입점).
export const getEffectiveWeekForAdminTestMode = resolveCluster4TestOpenableWeekStartMs;
