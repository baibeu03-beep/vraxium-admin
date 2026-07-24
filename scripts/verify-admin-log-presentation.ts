import assert from "node:assert/strict";

import { processCheckLogTone } from "../lib/adminProcessCheckTypes";
import {
  ADMIN_LOG_ENTITY_STYLES,
  ADMIN_LOG_TONE_STYLES,
} from "../lib/adminLogPresentation";
import { competencyOpeningLogTone } from "../lib/competencyOpeningLogFormat";
import { experienceOpeningLogTone } from "../lib/experienceOpeningLogFormat";
import { practicalInfoOpeningLogTone } from "../lib/practicalInfoSection0Format";

assert.equal(experienceOpeningLogTone("apply"), "submitted");
assert.equal(experienceOpeningLogTone("reapply"), "resubmitted");
assert.equal(experienceOpeningLogTone("review"), "reviewed");
assert.equal(experienceOpeningLogTone("review_cancel"), "reverted");
assert.equal(experienceOpeningLogTone("open"), "completed");
assert.equal(experienceOpeningLogTone("cancel"), "cancelled");

assert.equal(practicalInfoOpeningLogTone("open"), "completed");
assert.equal(practicalInfoOpeningLogTone("cancel"), "cancelled");
assert.equal(practicalInfoOpeningLogTone("close"), "closed");

assert.equal(competencyOpeningLogTone("open"), "completed");
assert.equal(competencyOpeningLogTone("cancel"), "cancelled");

assert.equal(processCheckLogTone("check_requested"), "submitted");
assert.equal(processCheckLogTone("check_completed"), "completed");
assert.equal(processCheckLogTone("check_cancelled"), "cancelled");
assert.equal(processCheckLogTone("check_rolled_back"), "reverted");

for (const className of Object.values(ADMIN_LOG_TONE_STYLES)) {
  assert.match(className, /dark:/, "every tone must include a dark-mode style");
}
assert.match(ADMIN_LOG_ENTITY_STYLES.team, /violet/);
assert.match(ADMIN_LOG_ENTITY_STYLES.part, /sky/);
assert.equal(ADMIN_LOG_ENTITY_STYLES.primary, ADMIN_LOG_ENTITY_STYLES.team);
assert.equal(ADMIN_LOG_ENTITY_STYLES.secondary, ADMIN_LOG_ENTITY_STYLES.part);
assert.match(ADMIN_LOG_ENTITY_STYLES.neutral, /slate/);
for (const className of Object.values(ADMIN_LOG_ENTITY_STYLES)) {
  assert.match(className, /ring-1/);
  assert.match(className, /dark:/);
}
assert.match(ADMIN_LOG_TONE_STYLES.reviewed, /indigo/);

console.log("admin log presentation verification passed");
