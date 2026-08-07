import type { BadgeTone } from "@/components/ui/badge"

// ─────────────────────────────────────────────────────────────────────────────
// 상태/선택값 → 색상(tone) 단일 레지스트리(SoT).
//
// 목표: "같은 상태값은 모든 페이지에서 같은 색상으로". 라벨 문자열은 이미 도메인
// 헬퍼(memberStatusLabel · processCheckActStatusLabel 등)에서 정규화되어 내려오므로,
// 여기서는 그 정규 라벨 → tone 만 매핑한다. 라벨 자체(텍스트)는 바꾸지 않는다.
//
// 색상 의미(사용자 지정):
//   성장 성공/활동 중/체크 완료      → success(초록)
//   성장 실패                        → danger(빨강)
//   개인 휴식/체크 필요              → warning(노랑)
//   공식 휴식/시즌 휴식/필수/수동부여 → info(파랑)
//   진행 중                          → neutral(회색)
//   집계 중/졸업/체크 대기/선별       → violet(보라)
//   활동 중단/활동 정지              → orange(주황)
// ─────────────────────────────────────────────────────────────────────────────

const LABEL_TONE: Record<string, BadgeTone> = {
  // 성장 도전 결과
  "성장 성공": "success",
  "성장 실패": "danger",
  성공: "success",
  실패: "danger",

  // 시즌 결과(크루 상세)
  "시즌 성공": "success",
  "시즌 중단": "orange",

  // 회원/시즌 활동 상태
  "활동 중": "success",
  활동중: "success",
  "개인 휴식": "warning",
  개인휴식: "warning",
  "공식 휴식": "info",
  공식휴식: "info",
  // 주차 활동 유형(주차 결과(크루)) — 휴식과 짝을 이루는 "공식 활동".
  "공식 활동": "success",
  공식활동: "success",
  "시즌 휴식": "info",
  시즌휴식: "info",
  "진행 중": "neutral",
  진행중: "neutral",
  "집계 중": "violet",
  집계중: "violet",
  졸업: "violet",
  "활동 중단": "orange",
  활동중단: "orange",
  "활동 정지": "orange",
  활동정지: "orange",

  // 회원 상태 버킷(lib/memberStatusBucket BUCKET_LABEL)
  "주차 휴식": "warning",
  엘리트: "violet", // graduated
  온보딩: "neutral",
  바사노스: "violet", // graduating(졸업 절차)

  // 프로세스 체크 상태
  "체크 필요": "warning",
  "체크 대기": "violet",
  "체크 완료": "success",
  // UI 용어 통일(SoT) — 링크 신청 / 수동 부여. (저장값 enum review_request/manual_grant 은 불변)
  "링크 신청": "violet",
  "수동 부여 완료": "info",
  "수동 부여": "info",
  "체크 대상 아님": "neutral",
  "검수 대기": "violet",
  // 주차 결과(크루) 3종 표시 상태 — "진행 중"/"집계 중"은 위 등록분과 같은 색을 공유한다.
  "검수 완료": "success",
  검수완료: "success",

  // 액트 종류(필수/자율/선별/기타)
  필수: "info",
  선별: "violet",
  자율: "neutral",
  기타: "neutral",

  // 검수/신청 일반
  대기: "warning",
  완료: "success",
  취소: "neutral",
  반려: "danger",
  승인: "success",
  신청: "info",

  // 팀 생명주기(관리 원장 — 삭제된 팀도 원장에는 남지만 활동 화면에서는 제외됨을 표시)
  삭제됨: "neutral",
}

/**
 * 정규 라벨 → tone. 매핑되지 않은 라벨은 "default"(약한 중립) 폴백.
 * 공백/양끝 정리만 하고 텍스트는 그대로 사용한다.
 */
export function statusTone(label: string | null | undefined): BadgeTone {
  if (!label) return "default"
  return LABEL_TONE[label.trim()] ?? "default"
}

/** 등록된 라벨인지(폴백 default 가 아닌지) — 디버그/검증용. */
export function isKnownStatusLabel(label: string | null | undefined): boolean {
  return !!label && label.trim() in LABEL_TONE
}

// ── 품계(클럽 랭크) → tone ──────────────────────────────────────────────────
// user_grade_stats.grade(1=정승 최상위 … 10=정9품). 알록달록 방지 위해 3개 밴드로만
// 묶는다(상위/중위/하위). 같은 grade(=같은 품계 라벨) → 항상 같은 색. soft 비중으로 표시.
export function rankTone(gradeNumber: number | null | undefined): BadgeTone {
  if (gradeNumber == null) return "default"
  if (gradeNumber <= 3) return "violet" // 상위 품계
  if (gradeNumber <= 7) return "info" // 중위
  return "neutral" // 하위
}

// ── 열거/자유값 → tone (컬럼 스코프 결정론 매핑) ─────────────────────────────
// "같은 컬럼 안에서 같은 값 = 항상 같은 색". 정렬·필터·재렌더로 행 순서가 바뀌어도
// 색이 따라 움직이면 안 되므로, **렌더 순서가 아니라 값 자체**로만 색을 정한다.
//
// 컬럼(category)을 색 키에 포함한다 — 같은 문자열이라도 컬럼이 다르면 의미가 다르다.
//   키 = `${category}:${value}`
//
// 값 집합이 고정 enum 인 컬럼은 VALUE_TONE 에 명시 매핑을 두고, 값이 계속 늘어날 수
// 있는 컬럼(소속 라인 급 등)은 문자열 해시(FNV-1a)로 제한된 팔레트에 안정 매핑한다.
// danger(빨강)는 팔레트에서 제외 — 단순 분류값이 오류/실패로 오독되지 않게.

/**
 * 값 종류가 동적인 컬럼용 팔레트. 순서를 바꾸면 기존 값의 색이 바뀌므로 append-only.
 * danger(빨강)는 오류 오독 때문에, orange 는 라이트 모드 명암비가 AA(4.5:1) 미만(실측 4.34)이라 제외.
 */
const VALUE_TONE_PALETTE: readonly BadgeTone[] = [
  "info",
  "violet",
  "success",
  "warning",
  "neutral",
]

/** 고정 enum 컬럼의 명시 매핑 — 값 종류가 닫혀 있으면 해시에 맡기지 않고 서로 다른 색을 보장한다. */
const VALUE_TONE: Record<string, BadgeTone> = {
  // 허브 급(PROCESS_HUB_LABEL + " 급") — 5종이 서로 구분되도록 각각 다른 tone.
  "hub:클럽 총괄 급": "violet",
  "hub:실무 정보 급": "info",
  "hub:실무 경험 급": "success",
  "hub:실무 역량 급": "warning",
  "hub:실무 경력 급": "neutral",
  // 체크 대상(PROCESS_CHECK_TARGET_LABEL)
  "checkTarget:체크": "violet",
  "checkTarget:미체크": "neutral",
  // 카페 발생 여부(PROCESS_CAFE_LABEL)
  "cafe:발생": "success",
  "cafe:미발생": "neutral",
}

/** FNV-1a 32bit — 같은 문자열이면 언제나 같은 수(런타임·세션 무관). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 컬럼 스코프 값 → tone. 명시 매핑 우선, 없으면 `${category}:${value}` 해시로 팔레트 배정.
 * 빈 값은 배지를 만들지 않는 쪽(호출부에서 "-" 표시)이라 "default" 를 돌려준다.
 */
export function valueTone(category: string, value: string | null | undefined): BadgeTone {
  const v = (value ?? "").trim()
  if (!v) return "default"
  const key = `${category}:${v}`
  const explicit = VALUE_TONE[key]
  if (explicit) return explicit
  return VALUE_TONE_PALETTE[fnv1a(key) % VALUE_TONE_PALETTE.length]
}

// ── 클래스(등급) → tone ─────────────────────────────────────────────────────
// classLabel: 정규 / 심화(파트장·에이전트) / 운영진(팀장·앰배서더). 계층별 3색.
// 같은 클래스 라벨 → 항상 같은 색. outline(가장 은은한) 비중으로 표시.
export function classTone(classLabelValue: string | null | undefined): BadgeTone {
  const v = (classLabelValue ?? "").trim()
  if (!v || v === "정규") return "neutral"
  if (v.startsWith("운영진") || v === "관리자" || v === "최고 관리자") return "violet"
  if (v.startsWith("심화")) return "info"
  return "neutral"
}
