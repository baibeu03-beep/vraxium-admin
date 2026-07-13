/**
 * 액트 카드 상태 판정(lib/actCardState.resolveActCardState) 순수 단위 검증.
 *   - 5상태 fixture(inactive·pending·overdue·completed-on-time·completed-late)
 *   - 우선순위(체크 기록 > 가동 > 현재 시각)
 *   - 경계값(actual==required → on-time·now==required → pending)
 *   - epoch ms 비교라 타임존 무관(같은 순간을 다른 offset 문자열로 넣어도 동일 판정)
 *   npx tsx scripts/verify-act-card-state.ts
 */
import {
  resolveActCardState,
  actCardActiveAttr,
  isCompletedCardState,
  type ActCardState,
} from "@/lib/actCardState";

let failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

const T = (iso: string) => Date.parse(iso);
const REQ = T("2026-07-02T14:00:00+09:00"); // (목) 14:00 KST
const NOW_BEFORE = T("2026-07-02T13:00:00+09:00");
const NOW_AFTER = T("2026-07-02T15:00:00+09:00");

// 5상태 fixture.
const fixtures: Array<{ name: string; input: Parameters<typeof resolveActCardState>[0]; expect: ActCardState }> = [
  {
    name: "inactive — 비가동·미신청",
    input: { isActive: false, requiredCheckedAtMs: REQ, check: null, nowMs: NOW_AFTER },
    expect: "inactive",
  },
  {
    name: "pending — 가동·미신청·필요 시간 전",
    input: { isActive: true, requiredCheckedAtMs: REQ, check: null, nowMs: NOW_BEFORE },
    expect: "pending",
  },
  {
    name: "overdue — 가동·미신청·필요 시간 초과",
    input: { isActive: true, requiredCheckedAtMs: REQ, check: null, nowMs: NOW_AFTER },
    expect: "overdue",
  },
  {
    name: "completed-on-time — 실제 ≤ 필요",
    input: { isActive: true, requiredCheckedAtMs: REQ, check: { actualCheckedAtMs: T("2026-07-02T13:00:00+09:00") }, nowMs: NOW_AFTER },
    expect: "completed-on-time",
  },
  {
    name: "completed-late — 실제 > 필요",
    input: { isActive: true, requiredCheckedAtMs: REQ, check: { actualCheckedAtMs: T("2026-07-02T15:00:00+09:00") }, nowMs: NOW_AFTER },
    expect: "completed-late",
  },
];
for (const f of fixtures) check(`fixture: ${f.name}`, resolveActCardState(f.input) === f.expect, resolveActCardState(f.input));

// 경계값.
check("경계: actual == required → on-time", resolveActCardState({ isActive: true, requiredCheckedAtMs: REQ, check: { actualCheckedAtMs: REQ }, nowMs: NOW_AFTER }) === "completed-on-time");
check("경계: now == required → pending(지각 아님)", resolveActCardState({ isActive: true, requiredCheckedAtMs: REQ, check: null, nowMs: REQ }) === "pending");
check("경계: now = required+1ms → overdue", resolveActCardState({ isActive: true, requiredCheckedAtMs: REQ, check: null, nowMs: REQ + 1 }) === "overdue");

// 우선순위: 체크 기록이 있으면 비가동이어도 완료 상태.
check("우선순위: check 기록 > 비가동", resolveActCardState({ isActive: false, requiredCheckedAtMs: REQ, check: { actualCheckedAtMs: NOW_BEFORE }, nowMs: NOW_AFTER }) === "completed-on-time");
check("우선순위: check 기록 > now(지연이어도 완료로 판정)", resolveActCardState({ isActive: true, requiredCheckedAtMs: REQ, check: { actualCheckedAtMs: NOW_AFTER }, nowMs: NOW_AFTER }) === "completed-late");

// 필요 시점 미상.
check("required 미상 + 미신청 → pending(overdue 불가)", resolveActCardState({ isActive: true, requiredCheckedAtMs: null, check: null, nowMs: NOW_AFTER }) === "pending");
check("required 미상 + 신청 → on-time", resolveActCardState({ isActive: true, requiredCheckedAtMs: null, check: { actualCheckedAtMs: NOW_AFTER }, nowMs: NOW_AFTER }) === "completed-on-time");
check("actual 미상 + 신청 → on-time", resolveActCardState({ isActive: true, requiredCheckedAtMs: REQ, check: { actualCheckedAtMs: null }, nowMs: NOW_AFTER }) === "completed-on-time");

// 타임존 무관성 — 같은 순간을 다른 offset 문자열로 표현해도 동일 판정.
check("TZ 무관: +09:00 과 UTC 동일 순간 = 동일 판정",
  resolveActCardState({ isActive: true, requiredCheckedAtMs: T("2026-07-02T14:00:00+09:00"), check: { actualCheckedAtMs: T("2026-07-02T05:00:00Z") }, nowMs: NOW_AFTER }) === "completed-on-time",
  { req: T("2026-07-02T14:00:00+09:00"), act: T("2026-07-02T05:00:00Z") });

// data-act-active·완료 헬퍼.
check("data-act-active: inactive=0", actCardActiveAttr("inactive") === "0");
check("data-act-active: pending/overdue/completed=1",
  (["pending", "overdue", "completed-on-time", "completed-late"] as ActCardState[]).every((s) => actCardActiveAttr(s) === "1"));
check("isCompletedCardState", isCompletedCardState("completed-on-time") && isCompletedCardState("completed-late") && !isCompletedCardState("pending") && !isCompletedCardState("overdue") && !isCompletedCardState("inactive"));

console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
