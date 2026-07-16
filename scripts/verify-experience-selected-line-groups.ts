/**
 * verify-experience-selected-line-groups.ts
 * 실무경험 개설 완료 — 사용자별 선택 라인(selected_line_id) 보존(2026-07-16) 순수 단위 검증(DB write 0).
 *
 * 배경: 크루 페이지 라인명 = cluster4_lines.experience_line_master_id → master.line_name.
 *   구 resolveCategoryLineGroups 는 도출/분석=candidates[0], 견문=누적주차, 관리=역할로 카테고리를
 *   1~2개 라인으로 축약 → 같은 팀/파트의 A/B/C 가 서로 다른 라인을 골라도 전부 첫 라인으로 표시됐다.
 *   resolveSelectedLineGroups 는 각 대상의 selected_line_id(=bridged_master_id)로 그룹핑해 분리 개설한다.
 *
 * 실행: npx tsx scripts/verify-experience-selected-line-groups.ts   (env 불필요 — 순수 함수)
 */
import {
  resolveSelectedLineGroups,
  type RegLine,
  type RoutingTarget,
} from "@/lib/adminExperienceTeamOverall";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// RegLine.bridgedMasterId 가 selected_line_id 와 매칭되는 키.
function mkReg(masterId: string, code: string, name: string): RegLine {
  return { bridgedMasterId: masterId, lineCode: code, lineName: name, mainTitle: name, outputImages: null, outputLinks: null };
}
function mkTarget(userId: string, selectedLineId: string, opts: Partial<RoutingTarget> = {}): RoutingTarget {
  return { userId, score: 7, isPartLeader: false, statusLabel: "일반", cumulativeWeeks: 0, selectedLineId, ...opts };
}

// 도출 후보 3종(A/B/C) — 같은 카테고리, 서로 다른 마스터.
const DERIV = [
  mkReg("m-A", "EXOK-EN0002", "[콘텐츠] 마케팅 실무_기획"),
  mkReg("m-B", "EXOK-EN0005", "[콘텐츠] 마케팅 실무_분석"),
  mkReg("m-C", "EXOK-EN0006", "[콘텐츠] 마케팅 실무_운영"),
];

console.log("=== resolveSelectedLineGroups 순수 단위 검증 ===");

// 1) 핵심: A/B/C 가 서로 다른 도출 라인을 고르면 각자 그 라인으로 분리 개설.
{
  const targets = [
    mkTarget("A", "m-A"),
    mkTarget("B", "m-B"),
    mkTarget("C", "m-C"),
  ];
  const warns: string[] = [];
  const groups = resolveSelectedLineGroups("derivation", DERIV, targets, warns);
  check("3그룹 분리 개설(사용자별 라인 보존)", groups.length === 3, `groups=${groups.length}`);
  const lineOf = (u: string) =>
    groups.find((g) => g.targets.some((t) => t.userId === u))?.reg.bridgedMasterId;
  check("A → 라인 A(m-A)", lineOf("A") === "m-A", String(lineOf("A")));
  check("B → 라인 B(m-B)", lineOf("B") === "m-B", String(lineOf("B")));
  check("C → 라인 C(m-C)", lineOf("C") === "m-C", String(lineOf("C")));
  check("각 그룹 대상 1명(교차 오염 없음)", groups.every((g) => g.targets.length === 1));
  check("경고 없음", warns.length === 0, warns.join("|"));
}

// 2) 같은 라인을 고른 사용자는 1그룹으로 병합(라인 중복 생성 없음).
{
  const targets = [
    mkTarget("A", "m-A"),
    mkTarget("B", "m-A"),
    mkTarget("C", "m-B"),
  ];
  const groups = resolveSelectedLineGroups("analysis", DERIV, targets, []);
  const gA = groups.find((g) => g.reg.bridgedMasterId === "m-A");
  const gB = groups.find((g) => g.reg.bridgedMasterId === "m-B");
  check("동일 라인 A 선택 2명 → 1그룹 2대상", !!gA && gA.targets.map((t) => t.userId).sort().join(",") === "A,B");
  check("다른 라인 B 선택 1명 → 별도 그룹", !!gB && gB.targets.length === 1 && gB.targets[0].userId === "C");
  check("총 2그룹", groups.length === 2);
}

// 3) 미매칭 선택(등록 비활성화 등) → 폴백 금지: 경고 후 제외, 타 사용자 무영향.
{
  const targets = [
    mkTarget("A", "m-A"),
    mkTarget("X", "m-GONE"), // 후보에 없는 마스터.
  ];
  const warns: string[] = [];
  const groups = resolveSelectedLineGroups("derivation", DERIV, targets, warns);
  check("미매칭 사용자는 어느 라인에도 미배정(첫 라인 폴백 금지)", groups.every((g) => !g.targets.some((t) => t.userId === "X")));
  check("정상 사용자 A 는 자기 라인 유지", groups.some((g) => g.reg.bridgedMasterId === "m-A" && g.targets.some((t) => t.userId === "A")));
  check("미매칭 경고 발생", warns.some((w) => w.includes("m-GONE")), warns.join("|"));
}

// 4) 견문·관리·확장도 동일 규칙(카테고리 무관 — selected_line_id 만 기준).
{
  const evalCands = [mkReg("m-L", "EXOK-EN0001", "마케터 Launch"), mkReg("m-F", "EXOK-EN0004", "상호 피드백")];
  // 신규(cw0)인데도 상호 피드백(m-F)을 명시 선택했다면 그대로 반영(누적주차 자동분기 아님).
  const groups = resolveSelectedLineGroups(
    "evaluation",
    evalCands,
    [mkTarget("A", "m-F", { cumulativeWeeks: 0 }), mkTarget("B", "m-L", { cumulativeWeeks: 9 })],
    [],
  );
  check("견문: 선택값 우선(누적주차 무시)", groups.find((g) => g.targets.some((t) => t.userId === "A"))?.reg.bridgedMasterId === "m-F");
  check("견문: B 는 선택한 Launch(m-L)", groups.find((g) => g.targets.some((t) => t.userId === "B"))?.reg.bridgedMasterId === "m-L");

  const mgmt = [mkReg("m-PL", "EXBS-EL0001", "_파트장"), mkReg("m-AG", "EXBS-EL0002", "_에이전트")];
  const mg = resolveSelectedLineGroups(
    "management",
    mgmt,
    [mkTarget("pl", "m-PL", { isPartLeader: true, statusLabel: "파트장" }), mkTarget("ag", "m-AG", { statusLabel: "에이전트" })],
    [],
  );
  check("관리: 파트장→선택한 _파트장(m-PL)", mg.find((g) => g.targets.some((t) => t.userId === "pl"))?.reg.bridgedMasterId === "m-PL");
  check("관리: 에이전트→선택한 _에이전트(m-AG)", mg.find((g) => g.targets.some((t) => t.userId === "ag"))?.reg.bridgedMasterId === "m-AG");
}

// 5) 순수성/순서 — 동일 입력 동일 출력(operating/test/demo 동일), 입력 순서 보존.
{
  const t = [mkTarget("x", "m-B"), mkTarget("y", "m-A")];
  const g1 = resolveSelectedLineGroups("derivation", DERIV, t, []);
  const g2 = resolveSelectedLineGroups("derivation", DERIV, t, []);
  check("순수성: 동일입력 동일출력", JSON.stringify(g1) === JSON.stringify(g2));
  check("순서 보존: 첫 등장(m-B) 먼저", g1[0].reg.bridgedMasterId === "m-B");
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
