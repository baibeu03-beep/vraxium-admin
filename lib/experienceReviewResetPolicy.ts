// 실무 경험 [개설 검수] 무효화 정책 — 순수 함수/상수(browser-safe, DB 무관).
//
// 규칙(2026-07-23):
//   관리자가 [개설 검수]를 완료(status='reviewed')한 뒤 파트장이 자기 파트 탭에서 개설 신청 정보를
//   **실제로 바꿔** 저장하면, 검수된 데이터와 저장 데이터가 어긋나므로 검수 상태를 즉시 취소한다.
//   → 확인 팝업 → [확인] 이면 저장 + 검수 취소(status='none'), [취소] 면 아무것도 하지 않는다.
//   변경사항이 없으면 팝업도 검수 취소도 없다(기존 저장 동작 그대로).
//
// 이 파일이 "무엇이 실제 변경인가"의 단일 판단 지점이다. 서버(라우트 게이트)와 화면(팝업 문구)이
// 같은 상수/판정을 공유한다. mode(operating/test)·org·임퍼소네이션과 무관하게 동일 로직이다.

import {
  EXPERIENCE_PART_LINE_KEYS,
  normalizePartInputCell,
  type ExperiencePartLineType,
  type PartInputCellDto,
} from "@/lib/experiencePartInputTypes";

/** 409 응답 code — 화면이 "확인 팝업이 필요하다"를 문구 매칭 없이 판별하는 기계 판독 키. */
export const REVIEW_RESET_CONFIRM_CODE = "experience_review_reset_confirm_required";

/** 확인 팝업 문구(요구사항 원문). 서버 409 error 문구와 화면 다이얼로그가 동일 문자열을 쓴다. */
export const REVIEW_RESET_CONFIRM_TITLE = "개설 검수 완료 상태";
export const REVIEW_RESET_CONFIRM_MESSAGE =
  "현재 기존의 데이터로 <개설 검수>까지 완료된 상황입니다.\n그래도 바꾸시겠습니까?";

/** 저장 + 검수 취소가 함께 처리된 뒤의 안내(성공 toast). */
export const REVIEW_RESET_APPLY_SUCCESS =
  "개설 신청이 저장되었습니다. 기존 개설 검수는 취소되었습니다.";
export const REVIEW_RESET_APPLY_CANCEL_SUCCESS =
  "개설 신청이 취소되었습니다. 기존 개설 검수는 취소되었습니다.";

/** 저장은 됐는데 검수 취소에 실패한 경우(재시도 안내) — 5xx 로 나가므로 화면 fallback 으로 쓰인다. */
export const REVIEW_RESET_FAILED_MESSAGE =
  "저장은 되었지만 개설 검수 취소에 실패했습니다. 새로고침 후 다시 시도해주세요.";

// ── 검수 취소 상태 판독(단일 SoT) ──
//
// 검수 취소는 팀 총괄 헤더를 status='none' 으로 되돌린다(헤더/팀장 입력/아웃풋은 보존).
// 2026-07-23 마이그레이션(status CHECK 에 'none' 추가) 적용 전 환경에서는 그 UPDATE 가 거부되므로
//   **reviewed_at=NULL** 을 같은 뜻의 sentinel 로 쓴다(status 는 'reviewed' 로 남는다).
//   · 정상 경로에서 status='reviewed' 인 행은 항상 reviewed_at 을 갖는다(persistReviewState 가 함께 기록,
//     [개설 취소] 복귀도 기존 reviewed_at 을 보존) → 이 조합은 "검수 취소" 외에는 만들어지지 않는다.
//   · 마이그레이션 적용 후 새로 쓰이는 값은 'none' 이고, 이 함수는 두 표현을 모두 'none' 으로 읽는다.
// 헤더의 status 를 해석하는 모든 경로는 반드시 이 함수를 거친다(원시 문자열 비교 금지).
export function resolveOverallStatus(row: {
  status: string | null;
  reviewedAt: string | null;
}): "none" | "reviewed" | "opened" {
  if (row.status === "opened") return "opened";
  if (row.status === "reviewed") return row.reviewedAt ? "reviewed" : "none";
  return "none";
}

function cellKey(crewUserId: string, lineType: ExperiencePartLineType): string {
  return `${crewUserId}::${lineType}`;
}

// 셀 1개의 비교 서명. 보이드 규칙(미체크/0점 → 라인 null)까지 정규화한 뒤 비교하므로
//   "저장하면 같은 값이 되는" 입력은 변경으로 보지 않는다(불필요한 팝업 방지).
function cellSignature(cell: PartInputCellDto): string {
  const n = normalizePartInputCell(cell);
  return `${n.checked ? 1 : 0}|${n.score}|${n.selectedLineId ?? "-"}`;
}

function toSignatureMap(cells: PartInputCellDto[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of cells) {
    if (!c?.crewUserId) continue;
    if (!(EXPERIENCE_PART_LINE_KEYS as readonly string[]).includes(c.lineType)) continue;
    map.set(cellKey(c.crewUserId, c.lineType), cellSignature(c));
  }
  return map;
}

/**
 * 파트 신청 저장(POST)이 **실제 변경**인가.
 *
 *   · 신청 헤더가 아직 없으면(미신청) 저장 자체가 신청 상태 변화 → 항상 변경.
 *   · 비교 범위 = 이번 요청이 소유한 키(그리드가 보낸 crew×line) ∪ 그 crew 의 저장된 키.
 *     검수 단계에서 물질화된 **파트장 셀**(그리드에 없는 crew)은 비교에서 제외한다 —
 *     파트장 셀은 [개설 검수] 화면이 소유하므로, 그것 때문에 "변경 없음" 저장이 매번
 *     검수 취소로 이어지는 오탐을 막는다.
 *   · 값 비교는 정규화(보이드 규칙) 후 checked/score/selectedLineId 전부.
 */
export function hasPartSubmissionChanges(input: {
  incoming: PartInputCellDto[];
  stored: PartInputCellDto[];
  storedHeaderExists: boolean;
}): boolean {
  if (!input.storedHeaderExists) return true;

  const incoming = toSignatureMap(input.incoming);
  const stored = toSignatureMap(input.stored);

  // 이번 요청이 다루는 크루 집합 — 저장측 비교 대상을 이 크루로 한정(파트장 셀 등 타 소유 셀 제외).
  const scopedCrews = new Set<string>();
  for (const c of input.incoming) {
    if (c?.crewUserId) scopedCrews.add(c.crewUserId);
  }

  const keys = new Set<string>(incoming.keys());
  for (const c of input.stored) {
    if (!c?.crewUserId || !scopedCrews.has(c.crewUserId)) continue;
    if (!(EXPERIENCE_PART_LINE_KEYS as readonly string[]).includes(c.lineType)) continue;
    keys.add(cellKey(c.crewUserId, c.lineType));
  }

  for (const key of keys) {
    if (incoming.get(key) !== stored.get(key)) return true;
  }
  return false;
}
