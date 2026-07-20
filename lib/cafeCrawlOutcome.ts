// 카페 댓글 크롤 "결과 판정" — 순수 함수(브라우저/서버/테스트 공용, playwright 미의존).
//
//   문제(증상2): 기존 크롤러는 댓글 컨테이너를 못 찾아도(hasCommentList===0) ok:true + totalComments:0 을
//     반환해 "실제 댓글 없음"과 "댓글 영역 탐지 실패(새 레이아웃 등)"를 구분하지 못했다 → UI 가 실댓글 게시물을
//     "댓글 없음"으로 오표시. 이 모듈은 DOM 에서 수집한 "신호"를 받아 success / error(코드)를 결정론적으로 판정한다.
//
//   ⚠ selector 자체는 여기서 다루지 않는다(신호는 호출부가 DOM 에서 수집). 이 함수는 "어떤 신호 조합이
//     정상 빈 게시물인지 / 탐지 실패인지"의 규칙만 담는다 → 라이브 DOM 없이도 규칙을 단위 검증할 수 있다.

import type { CafeCommentsErrorCode } from "./naverCafeComments";

// 레이아웃 종류(진단·비차단) — 사용자에게 노출하지 않는다.
export type CafeLayoutKind = "legacy-iframe" | "legacy" | "fe" | "unknown";

// DOM 에서 수집한 판정 신호(호출부가 채운다). 페이지 접근/로그인은 크롤 흐름이 먼저 처리하므로
//   여기 들어올 땐 보통 loginRequired/accessDenied=false 지만, 명시 신호가 있으면 우선한다.
export type CafeCrawlSignals = {
  postBodyFound: boolean; // 게시물 본문 영역 발견(=페이지가 정상 게시물로 열림)
  commentContainerFound: boolean; // 댓글 컨테이너(후보 selector 중 하나) 발견
  commentItemCount: number; // 컨테이너 내부에서 추출한(중복 제거된) 실제 댓글 수
  emptyStateConfirmed: boolean; // "댓글 0개" 명시 빈 상태 DOM 확인(컨테이너 없는 레이아웃의 정상 빈 판정용)
  paginationCompleted: boolean; // 페이지네이션/더보기 순회가 끝까지 완료됐는가(중단=미완료)
  loginRequired: boolean; // 로그인/세션 만료로 접근 불가
  accessDenied: boolean; // 접근 제한/권한 없음/본문 미발견
  layoutKind: CafeLayoutKind; // 진단용 레이아웃 추정
};

export type CafeCrawlVerdict =
  | { kind: "success"; totalComments: number }
  | { kind: "error"; errorCode: CafeCommentsErrorCode };

// 판정 규칙(요구사항 §4) — 순수. success+0 은 "정상 빈 게시물"이 확정될 때만.
//
//   우선순위:
//     1) 로그인 필요            → login_required
//     2) 접근 불가/본문 미발견  → article_not_accessible
//     3) 컨테이너 발견:
//          · 아이템 ≥1 + 순회 미완료 → pagination_incomplete (정상 수집으로 처리 금지)
//          · 아이템 ≥1            → success(개수)
//          · 아이템 0            → success(0)  ← 컨테이너 존재 자체가 "정상 빈"의 근거(검증된 레거시 컨테이너)
//     4) 컨테이너 미발견:
//          · 빈 상태 DOM 확인    → success(0)  (컨테이너 없는 레이아웃의 정상 빈)
//          · 그 외              → layout_mismatch (본문은 열렸으나 댓글 영역을 못 찾음 = 탐지 실패, success+0 금지)
export function classifyCafeCrawlOutcome(s: CafeCrawlSignals): CafeCrawlVerdict {
  if (s.loginRequired) return { kind: "error", errorCode: "login_required" };
  if (s.accessDenied || !s.postBodyFound) return { kind: "error", errorCode: "article_not_accessible" };

  if (s.commentContainerFound) {
    if (s.commentItemCount > 0 && !s.paginationCompleted) {
      return { kind: "error", errorCode: "pagination_incomplete" };
    }
    // 컨테이너를 찾았다 → 아이템 0개는 "정상 빈 게시물"로 신뢰한다(검증된 컨테이너 존재가 빈 상태의 근거).
    return { kind: "success", totalComments: s.commentItemCount };
  }

  // 컨테이너 미발견 — 명시 빈 상태 DOM 이 확인될 때만 정상 빈으로 인정한다(그 외엔 탐지 실패).
  if (s.emptyStateConfirmed) return { kind: "success", totalComments: 0 };
  return { kind: "error", errorCode: "layout_mismatch" };
}
