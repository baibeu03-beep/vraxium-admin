/**
 * 주차별 팀 <운용> 파트 최대 6개 제한 — **공용 순수 validator** 결정론적 검증(요구 케이스 1~7).
 *   클라이언트(onCellChange)·서버(PATCH)·e2e 가 모두 동일한 validateWeekPositionRows 를 최종 draft
 *   전체에 적용하므로, 이 순수 함수 검증이 곧 클라이언트==서버 동작 증명이다(별도 분기 없음).
 *
 *   운용 파트 = next draft 에서 rawPart 가 비어있지 않은 distinct 파트('일반' 포함 — [A] operatedParts SoT 동일).
 *   Usage: npx tsx scripts/verify-operated-part-limit.ts   (DB 불필요)
 */
import {
  validateWeekPositionRows,
  validateOperatedPartLimit,
  OPERATED_PART_LIMIT,
  type PositionDraftRow,
} from "@/lib/teamWeekPositionValidation";

let fail = 0;
const ck = (cond: boolean, label: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
};

// 파트 배열 → draft 행(전부 정규, userId 고유). 파트별 인원 수를 그대로 표현.
//   parts = ["A","A","B"] → A 2명, B 1명. 운용 파트 수 = distinct(A,B)=2.
function draft(parts: (string | null)[]): PositionDraftRow[] {
  return parts.map((p, i) => ({ userId: `u${i}`, rawPart: p, positionCode: "regular" as const }));
}
const opCount = (rows: PositionDraftRow[]) =>
  new Set(rows.map((r) => (r.rawPart ?? "").trim()).filter(Boolean)).size;
const MSG_RE = /최대 6개를 넘을 수 없습니다.*7번째/;

console.log(`OPERATED_PART_LIMIT = ${OPERATED_PART_LIMIT}`);

// ── Case 1 — 생성 파트 10개 / 운용 5개 → 정상 (생성 개수는 제한 아님) ──────────
console.log("\n[Case 1] 생성 10 / 운용 5 → 허용");
{
  // draft 에는 실제 배정된 5개 파트만 등장(미배정 G~J 는 draft 행이 없음 = 미운용).
  const rows = draft(["A", "A", "B", "C", "D", "E"]);
  ck(opCount(rows) === 5, `운용 파트=5 (생성 파트 수와 무관)`);
  ck(validateWeekPositionRows(rows).ok === true, `저장 허용`);
}

// ── Case 2 — 운용 5 → 미운용 파트에 배정(5→6) → 허용 ─────────────────────────
console.log("\n[Case 2] 5 → 6 → 허용");
{
  const rows = draft(["A", "B", "C", "D", "E", "F"]);
  ck(opCount(rows) === 6, `운용 파트=6`);
  ck(validateWeekPositionRows(rows).ok === true, `6개는 허용(경계 포함)`);
}

// ── Case 3 — 운용 6 → 기존 운용 파트로 이동(6→6) → 허용 ──────────────────────
console.log("\n[Case 3] 6 → 6 (기존 운용 파트 간 이동) → 허용");
{
  // A의 1명을 B로 이동: A 여전히 1명 이상 남고 B 는 이미 운용 → distinct 여전히 6.
  const before = draft(["A", "A", "B", "C", "D", "E", "F"]);
  const after = before.map((r) => (r.userId === "u0" ? { ...r, rawPart: "B" } : r));
  ck(opCount(after) === 6, `이동 후 운용 파트=6`);
  ck(validateWeekPositionRows(after).ok === true, `허용`);
}

// ── Case 4 — 운용 6 → 미운용 파트에 추가(6→7) → 차단 ────────────────────────
console.log("\n[Case 4] 6 → 7 (새 파트 운용) → 차단");
{
  const rows = draft(["A", "B", "C", "D", "E", "F", "G"]);
  ck(opCount(rows) === 7, `운용 파트=7`);
  const v = validateWeekPositionRows(rows);
  ck(v.ok === false, `저장 차단`);
  ck(!v.ok && MSG_RE.test(v.message), `메시지: "${!v.ok ? v.message : ""}"`);
}

// ── Case 5 — 1명뿐인 운용 파트 A → 미운용 G 로 이동(A:1→0, G:0→1, 최종 6) → 허용 ─
console.log("\n[Case 5] 마지막 크루 이동에 따른 파트 교체(6→6) → 허용");
{
  // A는 딱 1명(u0). u0을 G로 옮기면 A는 draft 에서 사라지고 G 등장 → distinct 여전히 6.
  const before = draft(["A", "B", "C", "D", "E", "F"]); // A~F 각 1명
  ck(opCount(before) === 6, `이동 전 운용=6 (A 1명)`);
  const after = before.map((r) => (r.userId === "u0" ? { ...r, rawPart: "G" } : r));
  ck(opCount(after) === 6 && !after.some((r) => r.rawPart === "A"), `이동 후 운용=6 (A 미운용, G 운용)`);
  ck(validateWeekPositionRows(after).ok === true, `허용(단순 'G가 미운용?' 만으로 차단하지 않음)`);
}

// ── Case 6 — draft 누적 변경(5→6→7): 7번째 변경 시점 차단 ────────────────────
console.log("\n[Case 6] draft 누적 5→6→7 → 7번째 차단");
{
  const d = new Map<string, PositionDraftRow>();
  draft(["A", "B", "C", "D", "E"]).forEach((r) => d.set(r.userId, r)); // 운용 5
  // 1) 새 크루 x1 을 F 로 → 6 : 허용
  d.set("x1", { userId: "x1", rawPart: "F", positionCode: "regular" });
  const s1 = validateWeekPositionRows([...d.values()]);
  ck(opCount([...d.values()]) === 6 && s1.ok, `1차 변경 후 6 → 허용`);
  // 2) 또 다른 크루 x2 를 G 로 → 7 : 차단(직전 값 유지)
  const trial = new Map(d);
  trial.set("x2", { userId: "x2", rawPart: "G", positionCode: "regular" });
  const s2 = validateWeekPositionRows([...trial.values()]);
  ck(opCount([...trial.values()]) === 7 && !s2.ok, `2차 변경(7) → 차단`);
  ck(!s2.ok && MSG_RE.test(s2.message), `메시지 일치`);
}

// ── Case 7 — validateOperatedPartLimit 단독(다른 validation 과 독립) ─────────
console.log("\n[Case 7] validateOperatedPartLimit 단독 판정");
{
  ck(validateOperatedPartLimit(draft(["A", "B", "C", "D", "E", "F"])).ok === true, `6 → ok`);
  ck(validateOperatedPartLimit(draft(["A", "B", "C", "D", "E", "F", "G"])).ok === false, `7 → 차단`);
  // '일반' 도 운용 파트로 카운트(SoT 일치): 일반+6 = 7 → 차단.
  const withGen = validateOperatedPartLimit(draft(["일반", "A", "B", "C", "D", "E", "F"]));
  ck(withGen.ok === false, `'일반' 포함 7 → 차단('일반'도 운용 파트로 카운트)`);
}

// ── 기존 validation 과의 결합 순서(파트장≤1 · 심화≤정규 유지) ─────────────────
console.log("\n[결합] 기존 클래스 validation 미약화");
{
  // 파트장 2명(같은 파트) — 운용 파트 1개지만 파트장 유일성 위반이 먼저 잡혀야 함.
  const dupLeader: PositionDraftRow[] = [
    { userId: "a", rawPart: "A", positionCode: "advanced_part_leader" },
    { userId: "b", rawPart: "A", positionCode: "advanced_part_leader" },
  ];
  const v = validateWeekPositionRows(dupLeader);
  ck(!v.ok && /파트장/.test(v.message), `파트장 유일성 위반 유지: "${!v.ok ? v.message : ""}"`);
}

console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
process.exit(fail === 0 ? 0 : 1);
