// 순수 단위 검증 (DB 불필요) — lib/positionResolver.ts::decidePositionAt 의 "시즌 경계 너머 멤버십
//   폴백 가드"(2026-08) 회귀 테스트. 운용 파트 carry-forward 버그(파트가 0명이 된 이후 미래 주차에서
//   현재 멤버십으로 자동 부활하던 문제)의 핵심 수정 지점을 DB 없이 직접 두드린다.
// 실행: npx tsx scripts/verify-operated-part-carry-forward-drift-guard.ts
import { decidePositionAt } from "@/lib/positionResolver";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`, detail ?? "");
  }
}

console.log("=== decidePositionAt — 드리프트 가드 순수 단위 검증 ===\n");

// ── 케이스 1: override 없음(한 번도) → 멤버십 그대로(무회귀, 가장 흔한 경우) ──
{
  const r = decidePositionAt(
    "u1",
    "2026-08-10",
    null, // ovr(시즌 경계 적용)
    null, // uphEntry
    { team: "A팀", part: "쿠키", code: "regular", role: null, level: "일반" },
    null, // rawPriorOverride — 한 번도 override 받은 적 없음
  );
  check("override 이력 없음 → 멤버십 그대로 폴백(rawPart=쿠키)", r.rawPart === "쿠키" && r.source === "membership", r);
}

// ── 케이스 2: 시즌 안 override 존재(carry-forward 정상 동작, 기존 분기 무회귀) ──
{
  const r = decidePositionAt(
    "u2",
    "2026-08-17", // 여름 7주차 가정
    { weekStartDate: "2026-08-03", rawTeam: "A팀", rawPart: "마카롱", positionCode: "regular" }, // 여름 6주차 override, 같은 시즌
    null,
    { team: "A팀", part: "쿠키", code: "regular", role: null, level: "일반" }, // 라이브 멤버십은 여전히 쿠키(갱신 안 됨)
    { weekStartDate: "2026-08-03", rawTeam: "A팀", rawPart: "마카롱", positionCode: "regular" },
  );
  check(
    "같은 시즌 override carry-forward → override 값(마카롱) 사용, source=override",
    r.rawPart === "마카롱" && r.source === "override",
    r,
  );
}

// ── 케이스 3(핵심 버그 재현) — 시즌 경계 너머(override 는 이전 시즌뿐), 라이브 멤버십이 그 override 이후
//    갱신 안 돼 "쿠키"로 낡아 있음 → 예전엔 멤버십 폴백으로 쿠키가 되살아났다. 이제는 미배정이어야 한다.
{
  const r = decidePositionAt(
    "u3",
    "2026-09-07", // 가을 1주차 가정(다른 시즌)
    null, // ovr(시즌 경계 적용) — 여름 override 는 가을로 이월되지 않아 null
    null, // uph 없음(현재 시즌 UPH 동결)
    { team: "A팀", part: "쿠키", code: "regular", role: null, level: "일반" }, // 라이브 멤버십 = 낡은 값(쿠키)
    { weekStartDate: "2026-08-03", rawTeam: "A팀", rawPart: "마카롱", positionCode: "regular" }, // 여름6 override(시즌 무관 탐색)
  );
  check(
    "시즌 경계 너머 + 멤버십 드리프트(쿠키≠마카롱) → 미배정(쿠키로 부활 금지)",
    r.rawPart === null && r.positionCode === null && r.source === "none",
    r,
  );
}

// ── 케이스 4 — 시즌 경계 너머지만, 라이브 멤버십이 override 값과 "같다"(드리프트 없음) → 정상 폴백 ──
{
  const r = decidePositionAt(
    "u4",
    "2026-09-07",
    null,
    null,
    { team: "A팀", part: "마카롱", code: "regular", role: null, level: "일반" }, // 멤버십도 이미 마카롱
    { weekStartDate: "2026-08-03", rawTeam: "A팀", rawPart: "마카롱", positionCode: "regular" },
  );
  check(
    "드리프트 없음(override 값 == 멤버십) → 정상 멤버십 폴백 허용",
    r.rawPart === "마카롱" && r.source === "membership",
    r,
  );
}

// ── 케이스 5 — 팀 자체가 바뀐 경우(다른 팀으로 override) → 팀 드리프트로도 억제되어야 함 ──
{
  const r = decidePositionAt(
    "u5",
    "2026-09-07",
    null,
    null,
    { team: "A팀", part: "쿠키", code: "regular", role: null, level: "일반" }, // 라이브는 여전히 A팀/쿠키
    { weekStartDate: "2026-08-03", rawTeam: "B팀", rawPart: "젤리", positionCode: "regular" }, // B팀으로 이동한 이력
  );
  check(
    "팀 자체 드리프트(A팀≠B팀) → 미배정",
    r.rawPart === null && r.source === "none",
    r,
  );
}

// ── 케이스 6 — rawPriorOverride 가 있어도 UPH 가 그 주차에 직접 존재하면 UPH 가 이긴다(기존 분기 무회귀) ──
{
  const r = decidePositionAt(
    "u6",
    "2026-05-04",
    null,
    { team: "A팀", part: "쿠키", code: "regular" }, // 그 주차 UPH 원본
    { team: "A팀", part: "마카롱", code: "regular", role: null, level: "일반" },
    { weekStartDate: "2026-04-01", rawTeam: "A팀", rawPart: "젤리", positionCode: "regular" },
  );
  check("UPH 존재 주차는 드리프트 가드 무관 → UPH 값 사용", r.rawPart === "쿠키" && r.source === "uph", r);
}

console.log(`\n합계: PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exit(1);
