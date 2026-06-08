/**
 * PMS 활동행 Season 문자열 → 시즌 타입 정규화 + 날짜 기반 보조 귀속 (2026-06-07 강화).
 *
 * 배경 (audit-season-pollution-20260607): PMS Season 자유입력 오염 22종 274행 —
 *   오타(겨을·경울)·특수문자(봄`)·연도 prefix(26, 겨울)·주차 접미(겨울 시즌8주차)·
 *   시즌 정보 부재(4·8월·중간)·비시즌 행(테스트·시즌전환). 종전 정규화는 공백/'시즌'
 *   접미만 처리해 인정 주차 귀속 누락(user×주차 108)을 유발 — pilot P4/P5 실측.
 *
 * 계약:
 *   1) isExcludedPmsSeason — 테스트/전환 행은 의도적 제외 (귀속 금지·hold 로그).
 *   2) normalizePmsSeasonType — 비한글 제거·숫자/주차/시즌 토큰 제거 후 사전 매칭
 *      (오타 사전 포함: 겨을·경울→winter).
 *   3) 정규화 실패(시즌 정보 부재) → **StartDate 날짜 기반 보조 귀속** (호출부에서
 *      weekByRange 로 결정 — 날짜가 SoT, SeasonWeek 무시).
 *   4) **W0/0주차 정책 (2026-06-07 확정)**: 시즌 시작 전 0주차(OT)·시즌 갭 날짜 활동은
 *      이번 활성 계정 이관에서 **제외** — live 달력에 대응 주차가 없어 날짜 귀속도 실패하는
 *      것이 정상 동작이다. W0 주차 행을 새로 만들지 않고, uws/경험행도 생성하지 않는다.
 *      원본은 legacy_point_ledger(포인트)·hold queue(활동)로 보존되고 포인트 잔액 차이는
 *      adjustment(§5-2)가 흡수한다. W0 정산은 추후 별도 작업.
 */

export type PmsSeasonType = "spring" | "summer" | "autumn" | "winter";

const SEASON_TOKEN_DICT = new Map<string, PmsSeasonType>([
  ["봄", "spring"],
  ["여름", "summer"],
  ["가을", "autumn"],
  ["겨울", "winter"],
  ["거울", "winter"], // 기존 오타 사전
  ["겨을", "winter"], // 2026-06-07 추가 (olympus 실측 오타)
  ["경울", "winter"], // 2026-06-07 추가 (hrdb 실측 오타)
]);

// 비시즌 행 — 귀속하지 않는 것이 정당 (테스트 데이터·시즌 전환 메모).
const EXCLUDED_PATTERNS = [/테스트/, /test/i, /전환/];

export function isExcludedPmsSeason(raw: unknown): boolean {
  const s = String(raw ?? "");
  return EXCLUDED_PATTERNS.some((p) => p.test(s));
}

export function normalizePmsSeasonType(raw: unknown): PmsSeasonType | null {
  if (isExcludedPmsSeason(raw)) return null;
  let x = String(raw ?? "");
  // 1) 공백류(개행·\r·전각 공백) 제거
  x = x.replace(/[\s\r\n　]+/g, "");
  // 2) 한글 외 문자 제거 — 백틱·콤마·화살표·영숫자 prefix("26,겨울"·"2026겨울") 흡수
  x = x.replace(/[^가-힣]/g, "");
  // 3) '시즌'·'주차' 토큰 제거 ("겨울시즌주차" 형태 잔여 처리)
  x = x.replace(/시즌/g, "").replace(/주차/g, "");
  return SEASON_TOKEN_DICT.get(x) ?? null;
}
