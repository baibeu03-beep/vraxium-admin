import assert from "node:assert/strict";

import {
  EXPERIENCE_OPENING_LOG_ACTION_LABEL,
  isExperienceOpeningLogAction,
  resolveExperienceApplicationLogAction,
} from "../lib/experienceOpeningLogFormat";

assert.equal(resolveExperienceApplicationLogAction(false), "apply");
assert.equal(resolveExperienceApplicationLogAction(true), "reapply");
assert.equal(resolveExperienceApplicationLogAction(false, true), "reapply");

assert.deepEqual(
  {
    apply: EXPERIENCE_OPENING_LOG_ACTION_LABEL.apply,
    reapply: EXPERIENCE_OPENING_LOG_ACTION_LABEL.reapply,
    apply_cancel: EXPERIENCE_OPENING_LOG_ACTION_LABEL.apply_cancel,
    review: EXPERIENCE_OPENING_LOG_ACTION_LABEL.review,
    review_cancel: EXPERIENCE_OPENING_LOG_ACTION_LABEL.review_cancel,
    open: EXPERIENCE_OPENING_LOG_ACTION_LABEL.open,
    cancel: EXPERIENCE_OPENING_LOG_ACTION_LABEL.cancel,
  },
  {
    apply: "개설 신청",
    reapply: "개설 재신청",
    apply_cancel: "개설 신청 취소",
    review: "개설 검수 완료",
    review_cancel: "개설 검수 취소",
    open: "개설 완료",
    cancel: "개설 취소",
  },
);

for (const action of [
  "apply",
  "reapply",
  "apply_cancel",
  "review",
  "review_cancel",
  "open",
  "cancel",
] as const) {
  assert.equal(isExperienceOpeningLogAction(action), true);
}

console.log("experience opening log event verification passed");
