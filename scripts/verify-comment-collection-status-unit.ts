// 댓글 수집 상태 SoT 단위 검증(순수 — DB/네이버/서버 불필요, tsx 로 바로 실행).
//   deriveCommentCollectionStatus 결정표 + 라벨/설명/톤 + 재수집 게이트 + 문구 규칙("일시적으로" 포함,
//   단정적 실패 문구 금지)을 검증한다. 정규/변동/운영/테스트 공용 SoT 이므로 여기서 한 번에 확인한다.
//
//   실행: npx tsx scripts/verify-comment-collection-status-unit.ts

import {
  deriveCommentCollectionStatus,
  commentCollectionAllowsRecollect,
  COMMENT_COLLECTION_LABEL,
  COMMENT_COLLECTION_DESCRIPTION,
  COMMENT_COLLECTION_TONE,
  type CommentCollectionStatusKind,
} from "../lib/adminProcessCheckTypes";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}
function eq<T>(name: string, got: T, want: T) {
  ok(`${name} (got=${String(got)} want=${String(want)})`, got === want);
}

console.log("── deriveCommentCollectionStatus 결정표 ──");
// 요구 결정표: 수집 성공 + 원본 0 → 댓글 없음
eq(
  "완료·성공·원본0 → collected_no_comments",
  deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 0, matchedCount: 0 }),
  "collected_no_comments",
);
// 수집 성공 + 원본 ≥1 + 매칭 0 → 매칭 사용자 없음
eq(
  "완료·성공·원본7·매칭0 → collected_no_match",
  deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 7, matchedCount: 0 }),
  "collected_no_match",
);
// 수집 성공 + 원본 ≥1 + 매칭 ≥1 → 매칭 완료
eq(
  "완료·성공·원본12·매칭8 → collected_matched",
  deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 12, matchedCount: 8 }),
  "collected_matched",
);
// 수집 오류(대기) → 일시 오류
eq(
  "대기·오류 → error",
  deriveCommentCollectionStatus({ status: "pending", collectionStatus: "error", rawCommentCount: null, matchedCount: 0 }),
  "error",
);
// 미수집(대기·상태없음) → 미수집
eq(
  "대기·상태없음 → not_collected",
  deriveCommentCollectionStatus({ status: "pending", collectionStatus: null, rawCommentCount: null, matchedCount: 0 }),
  "not_collected",
);
// needed → 미수집
eq(
  "needed → not_collected",
  deriveCommentCollectionStatus({ status: "needed", collectionStatus: null, rawCommentCount: null, matchedCount: 0 }),
  "not_collected",
);
// 레거시 완료(신규 컬럼 없음 · 매칭 0) → 상태 확인 불가(임의 판정 금지)
eq(
  "레거시 완료·매칭0 → unknown",
  deriveCommentCollectionStatus({ status: "completed", collectionStatus: null, rawCommentCount: null, matchedCount: 0 }),
  "unknown",
);
// 레거시 완료지만 매칭이 있으면 그 사실은 신뢰 → 매칭 완료
eq(
  "레거시 완료·매칭3 → collected_matched",
  deriveCommentCollectionStatus({ status: "completed", collectionStatus: null, rawCommentCount: null, matchedCount: 3 }),
  "collected_matched",
);
// count===0 만으로 오류 판정하지 않음: 성공+원본0 은 오류가 아니라 '댓글 없음'
ok(
  "count===0 을 오류로 판정하지 않음",
  deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 0, matchedCount: 0 }) !== "error",
);
// 완료로 남았지만 마지막 수집이 오류인데 기존 매칭이 있으면 결과 유지(0 위장 금지)
eq(
  "완료·오류지만 매칭2 → collected_matched(보존)",
  deriveCommentCollectionStatus({ status: "completed", collectionStatus: "error", rawCommentCount: null, matchedCount: 2 }),
  "collected_matched",
);

console.log("── 재수집 게이트(일시 오류만) ──");
const ALL: CommentCollectionStatusKind[] = [
  "not_collected",
  "collecting",
  "collected_matched",
  "collected_no_match",
  "collected_no_comments",
  "error",
  "unknown",
];
for (const k of ALL) {
  eq(`recollect(${k})`, commentCollectionAllowsRecollect(k), k === "error");
}

console.log("── 문구 규칙 ──");
// 오류 문구는 반드시 "일시적으로" 포함 + 단정적("댓글 수집 실패"/단독 "가져오지 못했습니다") 금지
const errDesc = COMMENT_COLLECTION_DESCRIPTION.error;
ok(`오류 설명에 "일시적으로" 포함: "${errDesc}"`, errDesc.includes("일시적으로"));
ok('오류 설명이 "댓글 수집 실패" 단정 표현 아님', !errDesc.includes("댓글 수집 실패"));
ok("오류 라벨 = '댓글 수집 일시 오류'", COMMENT_COLLECTION_LABEL.error === "댓글 수집 일시 오류");
// 요구 문구 정확 일치
eq("댓글 없음 라벨", COMMENT_COLLECTION_LABEL.collected_no_comments, "댓글 없음");
eq("댓글 없음 설명", COMMENT_COLLECTION_DESCRIPTION.collected_no_comments, "댓글 수집은 정상적으로 완료되었습니다.");
eq("매칭 사용자 없음 라벨", COMMENT_COLLECTION_LABEL.collected_no_match, "매칭 사용자 없음");
eq(
  "매칭 사용자 없음 설명",
  COMMENT_COLLECTION_DESCRIPTION.collected_no_match,
  "댓글은 수집되었지만 등록된 사용자와 매칭되지 않았습니다.",
);
eq("오류 설명 정확 문구", errDesc, "댓글 정보를 일시적으로 가져오지 못했습니다. 다시 수집해주세요.");

console.log("── 색 톤 ──");
eq("댓글 없음 = 회색(neutral)", COMMENT_COLLECTION_TONE.collected_no_comments, "neutral");
eq("매칭 사용자 없음 = 경고(warning)", COMMENT_COLLECTION_TONE.collected_no_match, "warning");
eq("일시 오류 = 위험(danger)", COMMENT_COLLECTION_TONE.error, "danger");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail === 0 ? 0 : 1);
