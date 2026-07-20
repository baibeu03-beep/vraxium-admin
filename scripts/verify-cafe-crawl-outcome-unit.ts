/**
 * 순수 단위 검증 — 카페 크롤 결과 판정(classifyCafeCrawlOutcome, 요구 §4). DOM/브라우저 없이 실행.
 *   npx tsx scripts/verify-cafe-crawl-outcome-unit.ts
 *
 *   핵심: "댓글 컨테이너 미발견"을 더 이상 success+0 으로 처리하지 않는다(→ layout_mismatch).
 */
import { classifyCafeCrawlOutcome, type CafeCrawlSignals } from "@/lib/cafeCrawlOutcome";

let failed = 0;
function ck(name: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

// 기본 신호(정상 접근·본문 발견·순회 완료) — 각 케이스에서 필요한 필드만 덮어쓴다.
const base: CafeCrawlSignals = {
  postBodyFound: true,
  commentContainerFound: true,
  commentItemCount: 0,
  emptyStateConfirmed: false,
  paginationCompleted: true,
  loginRequired: false,
  accessDenied: false,
  layoutKind: "legacy",
};
const S = (o: Partial<CafeCrawlSignals>): CafeCrawlSignals => ({ ...base, ...o });
const v = (o: Partial<CafeCrawlSignals>) => classifyCafeCrawlOutcome(S(o));

console.log("── 컨테이너 발견 ──");
ck("아이템>0 → success(개수)", JSON.stringify(v({ commentContainerFound: true, commentItemCount: 7 })) === JSON.stringify({ kind: "success", totalComments: 7 }));
ck("아이템>0·매칭무관 → success(개수)", v({ commentItemCount: 12 }).kind === "success");
ck("아이템 0 → success(0) [검증된 컨테이너 = 정상 빈]", JSON.stringify(v({ commentContainerFound: true, commentItemCount: 0 })) === JSON.stringify({ kind: "success", totalComments: 0 }));
ck("아이템>0·순회 미완료 → pagination_incomplete", JSON.stringify(v({ commentItemCount: 5, paginationCompleted: false })) === JSON.stringify({ kind: "error", errorCode: "pagination_incomplete" }));

console.log("── 컨테이너 미발견(핵심 회귀) ──");
ck("본문O·컨테이너X·빈상태X → layout_mismatch (success+0 아님!)", JSON.stringify(v({ commentContainerFound: false, commentItemCount: 0, emptyStateConfirmed: false })) === JSON.stringify({ kind: "error", errorCode: "layout_mismatch" }));
ck("컨테이너 미발견 결과가 success 가 아님", v({ commentContainerFound: false }).kind === "error");
ck("본문O·컨테이너X·빈상태 확인 → success(0) [컨테이너 없는 레이아웃 정상 빈]", JSON.stringify(v({ commentContainerFound: false, emptyStateConfirmed: true })) === JSON.stringify({ kind: "success", totalComments: 0 }));

console.log("── 접근/로그인 ──");
ck("loginRequired → login_required(우선)", v({ loginRequired: true, commentContainerFound: true, commentItemCount: 3 }).kind === "error" && (v({ loginRequired: true }) as { errorCode: string }).errorCode === "login_required");
ck("accessDenied → article_not_accessible", (v({ accessDenied: true }) as { errorCode: string }).errorCode === "article_not_accessible");
ck("본문 미발견 → article_not_accessible", (v({ postBodyFound: false, commentContainerFound: false }) as { errorCode: string }).errorCode === "article_not_accessible");

console.log("── 대조: 실제 빈 vs 탐지 실패 구분 ──");
ck("실제 빈(컨테이너O·0) = success+0", v({ commentContainerFound: true, commentItemCount: 0 }).kind === "success");
ck("탐지 실패(컨테이너X) = error(≠ success+0)", v({ commentContainerFound: false, commentItemCount: 0 }).kind === "error");

console.log(`\n결과: ${failed === 0 ? "ALL PASS" : failed + " FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
