/**
 * 순수 단위 테스트 — validateWeekPositionChange(prev, next).
 *
 * 정책(2026-07-22 사용자 지시):
 *   · 파트만 변경   → 심화 관련 검사 **없음**
 *   · 정규→심화     → "심화 ≤ 정규" 만 검사
 *   · 정규→심화(파트장) → "같은 파트 파트장 중복" + "심화 ≤ 정규" 둘 다 검사
 *   · 팀이 이미 규칙을 어긴 상태여도, 그 변경이 위반을 **새로 만들지 않으면** 통과
 *
 *   Usage: npx tsx scripts/test-week-position-validation.ts   (DB 불필요)
 */
import { validateWeekPositionChange, type PositionDraftRow } from "@/lib/teamWeekPositionValidation";

let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const row = (userId: string, rawPart: string | null, positionCode: PositionDraftRow["positionCode"]): PositionDraftRow =>
  ({ userId, rawPart, positionCode });

// 심화가 정규보다 많은 **이미 위반 상태**의 팀(과거 데이터/이관으로 실제 발생 가능).
const violatingTeam: PositionDraftRow[] = [
  row("u1", "비트", "regular"),
  row("u2", "비트", "advanced_agent"),
  row("u3", "보컬", "advanced_agent"),
  row("u4", "보컬", "advanced_part_leader"),
];

console.log("[A] 파트만 변경 — 심화 검사 없음");
{
  // 정규 u1: 비트 → 보컬. 클래스 불변. 팀은 이미 심화(3) > 정규(1) 위반 상태.
  const next = violatingTeam.map((r) => (r.userId === "u1" ? row("u1", "보컬", "regular") : r));
  const v = validateWeekPositionChange(violatingTeam, next);
  ck("이미 심화>정규 인 팀에서도 파트만 바꾸면 통과", v.ok, v.ok ? "" : v.message);
}
{
  // 심화 u2 의 파트 이동(파트장 아님) — 검사 없음.
  const next = violatingTeam.map((r) => (r.userId === "u2" ? row("u2", "보컬", "advanced_agent") : r));
  const v = validateWeekPositionChange(violatingTeam, next);
  ck("심화(에이전트) 파트 이동도 통과", v.ok, v.ok ? "" : v.message);
}

console.log("\n[B] 정규 → 심화 — 심화≤정규 만 검사");
{
  const prev = [row("u1", "비트", "regular"), row("u2", "비트", "regular")];
  const next = [row("u1", "비트", "advanced_agent"), row("u2", "비트", "regular")];
  const v = validateWeekPositionChange(prev, next);
  ck("정규2 → 심화1/정규1 (1<=1) 통과", v.ok, v.ok ? "" : v.message);
}
{
  const prev = [row("u1", "비트", "advanced_agent"), row("u2", "비트", "regular")];
  const next = [row("u1", "비트", "advanced_agent"), row("u2", "비트", "advanced_agent")];
  const v = validateWeekPositionChange(prev, next);
  ck("심화1/정규1 → 심화2/정규0 차단", !v.ok, v.ok ? "(통과됨)" : v.message);
  ck("  메시지 = 심화 초과", !v.ok && v.message.includes("‘심화’"), !v.ok ? v.message : "");
}
{
  // 심화 → 정규(내리는 변경)는 위반 상태여도 항상 통과.
  const next = violatingTeam.map((r) => (r.userId === "u3" ? row("u3", "보컬", "regular") : r));
  const v = validateWeekPositionChange(violatingTeam, next);
  ck("심화 → 정규(하향)는 위반 팀에서도 통과", v.ok, v.ok ? "" : v.message);
}

console.log("\n[C] 정규 → 심화(파트장) — 중복 + 비율 둘 다");
{
  const prev = [row("u1", "비트", "regular"), row("u2", "비트", "advanced_part_leader"), row("u3", "비트", "regular")];
  const next = [row("u1", "비트", "advanced_part_leader"), row("u2", "비트", "advanced_part_leader"), row("u3", "비트", "regular")];
  const v = validateWeekPositionChange(prev, next);
  ck("같은 파트 파트장 2명 차단", !v.ok, v.ok ? "(통과됨)" : v.message);
  ck("  메시지 = 파트장 중복", !v.ok && v.message.includes("파트장"), !v.ok ? v.message : "");
}
{
  const prev = [row("u1", "비트", "regular"), row("u2", "보컬", "regular")];
  const next = [row("u1", "비트", "advanced_part_leader"), row("u2", "보컬", "regular")];
  const v = validateWeekPositionChange(prev, next);
  ck("다른 파트면 파트장 승격 통과", v.ok, v.ok ? "" : v.message);
}
{
  // 파트장 이동: 이미 파트장이 있는 파트로 옮기면 차단(클래스 변경 아니어도).
  const prev = [row("u1", "비트", "advanced_part_leader"), row("u2", "보컬", "advanced_part_leader"), row("u3", "비트", "regular"), row("u4", "보컬", "regular")];
  const next = prev.map((r) => (r.userId === "u1" ? row("u1", "보컬", "advanced_part_leader") : r));
  const v = validateWeekPositionChange(prev, next);
  ck("파트장이 파트장 있는 파트로 이동 시 차단", !v.ok, v.ok ? "(통과됨)" : v.message);
}
{
  // 원래부터 그 파트의 파트장인 사람은 다른 변경이 있어도 자기 자신 때문에 막히지 않는다.
  const prev = [row("u1", "비트", "advanced_part_leader"), row("u2", "비트", "regular"), row("u3", "보컬", "regular")];
  const next = prev.map((r) => (r.userId === "u3" ? row("u3", "비트", "regular") : r));
  const v = validateWeekPositionChange(prev, next);
  ck("기존 파트장 유지 + 남의 파트 이동 통과", v.ok, v.ok ? "" : v.message);
}

console.log("\n[D] 운용 파트 ≤ 6 — 늘어날 때만");
{
  const base = ["p1", "p2", "p3", "p4", "p5", "p6"].map((p, i) => row(`u${i}`, p, "regular"));
  // 6→6 이동(마지막 크루가 다른 운용 파트로) — 통과.
  const moveWithin = base.map((r) => (r.userId === "u0" ? row("u0", "p2", "regular") : r));
  ck("운용 6 → 6 이동 통과", validateWeekPositionChange(base, moveWithin).ok);
  // 6→7 — 차단.
  const grow = [...base, row("u9", "p7", "regular")];
  const v = validateWeekPositionChange(base, grow);
  ck("운용 6 → 7 차단", !v.ok, v.ok ? "(통과됨)" : v.message);
  // 이미 7인 상태에서 파트만 이동 — 통과(늘지 않음).
  const seven = [...base, row("u9", "p7", "regular")];
  const moveIn7 = seven.map((r) => (r.userId === "u0" ? row("u0", "p2", "regular") : r));
  ck("이미 7인 팀에서 이동(7→6) 통과", validateWeekPositionChange(seven, moveIn7).ok);
}

console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
process.exit(fail === 0 ? 0 : 1);
