/**
 * 순수 단위 검증 — "완료 취소(un-complete)" 시 수집 진단값 초기화 정책 + 초기화 후 재검수 파생 매트릭스.
 *   DB/크롤러 없이 실행 가능(공용 SoT 함수만 호출·로직 복제 없음).
 *   npx tsx scripts/verify-uncomplete-collection-reset-unit.ts
 *
 * 검증 대상:
 *   1) uncompleteResetStamp / collectionResetFields (lib/processCheckCollectionReset) — 실제 stamp 필드.
 *   2) deriveCommentCollectionStatus (lib/adminProcessCheckTypes) — 초기화 후 재검수 성공/실패의 표시 상태.
 *      · 핵심 회귀: "완료 취소 → 재검수" 뒤에는 어떤 정상 경로에서도 `unknown`(상태 확인 불가) 이 안 나온다.
 */
import {
  uncompleteResetStamp,
  collectionResetFields,
} from "@/lib/processCheckCollectionReset";
import { deriveCommentCollectionStatus } from "@/lib/adminProcessCheckTypes";

let failed = 0;
function ck(name: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
const keysSorted = (o: object) => Object.keys(o).sort();

console.log("── 초기화 stamp(컬럼 적용) ──");
{
  const s = uncompleteResetStamp(true);
  ck(
    "4개 필드 전부 null(last_error+수집3)",
    keysSorted(s).join(",") ===
      ["comment_collection_error_code", "comment_collection_status", "last_error", "raw_comment_count"].join(",") &&
      Object.values(s).every((v) => v === null),
    s,
  );
  ck("raw_comment_count=null", s.raw_comment_count === null);
  ck("comment_collection_status=null", s.comment_collection_status === null);
  ck("comment_collection_error_code=null", s.comment_collection_error_code === null);
  ck("last_error=null", s.last_error === null);
}

console.log("── 초기화 stamp(컬럼 미적용 degrade) ──");
{
  const s = uncompleteResetStamp(false);
  // 미적용 DB 에서는 수집 3컬럼을 update 에 넣으면 안 됨(column does not exist) → last_error 만.
  ck("미적용이면 last_error 만 초기화", keysSorted(s).join(",") === "last_error" && s.last_error === null, s);
  ck("collectionResetFields(false)=빈 객체", Object.keys(collectionResetFields(false)).length === 0);
  ck(
    "collectionResetFields(true)=수집 3컬럼 null",
    keysSorted(collectionResetFields(true)).join(",") ===
      ["comment_collection_error_code", "comment_collection_status", "raw_comment_count"].join(","),
  );
}

console.log("── 초기화 직후(재신청/필요 상태) 표시 파생 ──");
{
  // 완료 취소 후 stamp 를 반영한 행 = status needed/pending + 수집값 전부 null → not_collected(이전 결과 미노출).
  const afterReset = { collectionStatus: null, rawCommentCount: null } as const;
  ck(
    "needed + 초기화 → not_collected(이전 댓글 수 미노출)",
    deriveCommentCollectionStatus({ status: "needed", ...afterReset, matchedCount: 0 }) === "not_collected",
  );
  ck(
    "pending(재신청) + 초기화 → not_collected",
    deriveCommentCollectionStatus({ status: "pending", ...afterReset, matchedCount: 0 }) === "not_collected",
  );
}

console.log("── 초기화 후 재검수 결과(sweep 각인값) 표시 파생 ──");
{
  // 재검수 성공 — sweep 성공 브랜치가 comment_collection_status='success' + raw_comment_count=이번수집 각인.
  ck(
    "재검수 성공·댓글 0 → collected_no_comments (unknown 아님)",
    deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 0, matchedCount: 0 }) ===
      "collected_no_comments",
  );
  ck(
    "재검수 성공·댓글>0·매칭0 → collected_no_match",
    deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 7, matchedCount: 0 }) ===
      "collected_no_match",
  );
  ck(
    "재검수 성공·댓글>0·매칭>0 → collected_matched",
    deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 12, matchedCount: 3 }) ===
      "collected_matched",
  );
  // 재검수 실패 — sweep 실패 브랜치가 comment_collection_status='error'(status 는 pending 유지).
  ck(
    "재검수 실패 → error (unknown/댓글없음 아님)",
    deriveCommentCollectionStatus({ status: "pending", collectionStatus: "error", rawCommentCount: null, matchedCount: 0 }) ===
      "error",
  );
}

console.log("── 핵심 회귀: 초기화 후 재검수 경로에서 unknown 이 안 나온다 ──");
{
  // 초기화(null) → 재검수의 모든 정상 종결 상태를 열거해 unknown 이 없음을 보인다.
  const outcomes = [
    deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 0, matchedCount: 0 }),
    deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 5, matchedCount: 0 }),
    deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 5, matchedCount: 2 }),
    deriveCommentCollectionStatus({ status: "pending", collectionStatus: "error", rawCommentCount: null, matchedCount: 0 }),
  ];
  ck("재검수 종결 상태에 unknown 없음", !outcomes.includes("unknown"), outcomes);
  // 대조: 초기화하지 않아 collectionStatus 가 null 인 채로 완료되면(레거시/버그) unknown 이 남는다 — 초기화가 필요한 이유.
  ck(
    "대조: 미초기화 완료(null·매칭0) → unknown (초기화가 막는 상태)",
    deriveCommentCollectionStatus({ status: "completed", collectionStatus: null, rawCommentCount: null, matchedCount: 0 }) ===
      "unknown",
  );
}

console.log(`\n결과: ${failed === 0 ? "ALL PASS" : failed + " FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
