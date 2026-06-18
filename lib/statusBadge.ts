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
  "수동 부여 완료": "info",
  "수동 부여": "info",
  "체크 대상 아님": "neutral",
  "검수 신청": "violet",
  "검수 대기": "violet",

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
