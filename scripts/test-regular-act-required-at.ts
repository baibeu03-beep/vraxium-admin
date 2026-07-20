import assert from "node:assert/strict";

import { resolveActCardState } from "@/lib/actCardState";
import { resolveRegularActRequiredAt } from "@/lib/regularActRequiredAt";

// 2026 여름 3주차(월 7/13~일 7/19)의 화요일 10:30은 조회일과 무관하게 7/14여야 한다.
const requiredAt = resolveRegularActRequiredAt({
  weekStart: "2026-07-13",
  checkWeek: "N",
  checkDow: 2,
  checkTime: "10:30:00",
});

assert.equal(requiredAt, "2026-07-14T10:30:00+09:00");

const requiredAtMs = Date.parse(requiredAt);
const requestedAtMs = Date.parse("2026-07-20T13:57:00+09:00");
assert.equal(
  resolveActCardState({
    isActive: true,
    requiredCheckedAtMs: requiredAtMs,
    check: { actualCheckedAtMs: requestedAtMs },
    nowMs: Date.parse("2026-07-20T14:00:00+09:00"),
  }),
  "completed-late",
);

// 명시적으로 다음 주(N1)인 액트의 기존 의미는 유지한다.
assert.equal(
  resolveRegularActRequiredAt({
    weekStart: "2026-07-13",
    checkWeek: "N1",
    checkDow: 2,
    checkTime: "10:30",
  }),
  "2026-07-21T10:30:00+09:00",
);

console.log("PASS: regular act requiredAt uses the managed week anchor");
