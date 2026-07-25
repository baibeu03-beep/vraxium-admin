import assert from "node:assert/strict";
import { selectMembershipRow } from "../lib/membershipResolver";
import { resolvePointAwardRows } from "../lib/pointResolver";
import { resolvePositionValues } from "../lib/positionResolver";

const membership = {
  team: "membership-team",
  part: "membership-part",
  code: "regular" as const,
  role: null,
  level: "일반",
};

assert.deepEqual(
  resolvePositionValues({ override: null, history: null, membership }),
  { teamName: "membership-team", partName: "membership-part", positionCode: "regular" },
);
assert.equal(
  resolvePositionValues({
    override: { rawTeam: "override-team", rawPart: null, positionCode: "advanced_agent" },
    history: null,
    membership,
  }).partName,
  "membership-part",
);
assert.equal(
  resolvePositionValues({
    override: { rawTeam: "override-team", rawPart: "   ", positionCode: "advanced_agent" },
    history: { team: "history-team", part: "history-part", code: "regular" },
    membership,
  }).partName,
  "history-part",
);

const selected = selectMembershipRow([
  {
    team_name: null,
    part_name: null,
    membership_level: "심화",
    is_current: true,
    updated_at: "2026-07-25",
  },
  {
    team_name: "selected-team",
    part_name: "selected-part",
    membership_level: "일반",
    is_current: false,
    updated_at: "2026-07-24",
  },
]);
assert.equal(selected?.team_name, "selected-team");
assert.equal(selected?.membership_level, "일반");

assert.deepEqual(resolvePointAwardRows([
  { point_check: 3, point_advantage: 10, point_penalty: 2 },
]), { pointA: 3, pointB: 8, pointC: 2, rawAdvantage: 10 });
assert.deepEqual(resolvePointAwardRows([
  { point_check: 3, point_advantage: 10, point_penalty: -2 },
]), { pointA: 3, pointB: 8, pointC: 2, rawAdvantage: 10 });
assert.deepEqual(resolvePointAwardRows([
  { point_check: 1, point_advantage: 7, point_penalty: -2 },
  { point_check: 2, point_advantage: 3, point_penalty: 4 },
]), { pointA: 3, pointB: 4, pointC: 6, rawAdvantage: 10 });
assert.deepEqual(resolvePointAwardRows([
  { point_check: 0, point_advantage: 0, point_penalty: 0 },
]), { pointA: 0, pointB: 0, pointC: 0, rawAdvantage: 0 });

console.log("common business resolver tests: PASS");
