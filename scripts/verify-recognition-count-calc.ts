/**
 * 테스트: lib/weekRecognitionCount(N 산식) + lib/linePointBackfill(결정론 배정). 순수 함수·DB 불필요.
 *   npx tsx scripts/verify-recognition-count-calc.ts
 */
import {
  computeWeekRecognitionCount,
  type RecognitionActInput,
  type RecognitionLineInput,
} from "@/lib/weekRecognitionCount";
import { assignLinePoints, LINE_POINT_RATIO } from "@/lib/linePointBackfill";

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

// ── N 산식 ─────────────────────────────────────────────────────────────────
// 워크드 예시: A=20, B=47 → N=round(20+0.4×27)=round(30.8)=31.
const workedActs: RecognitionActInput[] = [
  { id: "req1", actType: "required", isOpen: true, pointA: 10, pointB: 5 }, // A&B +15
  { id: "opt1", actType: "optional", isOpen: true, pointA: 10, pointB: 2 }, // B +12
  { id: "sel1", actType: "selection", isOpen: true, pointA: 8, pointB: 2 }, // B +10
  { id: "bas1", actType: "basic", isOpen: true, pointA: 100, pointB: 100 }, // 제외
  { id: "req-closed", actType: "required", isOpen: false, pointA: 99, pointB: 99 }, // 미가동 제외
];
const workedLines: RecognitionLineInput[] = [
  { id: "expL", hub: "experience", isOpen: true, pointA: 3, pointB: 2 }, // A&B +5
  { id: "infoL", hub: "info", isOpen: true, pointA: 3, pointB: 2 }, // B +5
  { id: "comp-closed", hub: "competency", isOpen: false, pointA: 50, pointB: 50 }, // 미오픈 제외
];
const r = computeWeekRecognitionCount({ acts: workedActs, lines: workedLines });
ck("A(최소자)=20", r.minimalA === 20, { minimalA: r.minimalA });
ck("B(성실자)=47", r.diligentB === 47, { diligentB: r.diligentB });
ck("N=round(30.8)=31", r.recognitionCountN === 31, { N: r.recognitionCountN });
ck("basic 은 A·B 모두 제외", r.minimalA === 20 && r.diligentB === 47);
ck("미가동/미오픈 항목 제외", r.diligentB === 47);
ck("calcVersion=2", r.calcVersion === 2);

// ── 2026-07-27 평점 기준 정책 ───────────────────────────────────────────────
//   사용자 확정 워크드 예시(§2): 팀 1개당 도출 A1+B2=3 · 분석 A0+B2=2 · 견문 A0+B2=2
//     최소자 = (3+4)+(2+4)+(2+4) = 19 · 성실자 = (3+7)+(2+7)+(2+7) = 28
//     팀 3개 전부 오픈 → 최소자 57 · 성실자 84 (팀별 오픈 셀마다 합산).
const EXP_CFG: Array<{ type: string; a: number; b: number }> = [
  { type: "derive", a: 1, b: 2 },
  { type: "analysis", a: 0, b: 2 },
  { type: "research", a: 0, b: 2 },
];
const expCells = (teams: number, opts?: { withManagement?: boolean; withExpansion?: boolean }) => {
  const out: RecognitionLineInput[] = [];
  for (let t = 0; t < teams; t++) {
    for (const c of EXP_CFG) {
      out.push({
        id: `exp:t${t}:${c.type}`, hub: "experience", isOpen: true, pointA: c.a, pointB: c.b,
        role: "minimal_and_diligent", ratingMinimal: 4, ratingDiligent: 7,
      });
    }
    // 관리·확장 = 오픈돼 있어도 A·B·N 어디에도 기여하지 않는다(role="excluded").
    if (opts?.withManagement)
      out.push({ id: `exp:t${t}:management`, hub: "experience", isOpen: true, pointA: 2, pointB: 2, role: "excluded", ratingMinimal: 0, ratingDiligent: 0 });
    if (opts?.withExpansion)
      out.push({ id: `exp:t${t}:expansion`, hub: "experience", isOpen: true, pointA: 2, pointB: 1, role: "excluded", ratingMinimal: 0, ratingDiligent: 0 });
  }
  return out;
};

const one = computeWeekRecognitionCount({ acts: [], lines: expCells(1) });
ck("팀1: 최소자 19 = (3+4)+(2+4)+(2+4)", one.minimalA === 19, { minimalA: one.minimalA });
ck("팀1: 성실자 28 = (3+7)+(2+7)+(2+7)", one.diligentB === 28, { diligentB: one.diligentB });

const three = computeWeekRecognitionCount({ acts: [], lines: expCells(3) });
ck("팀3: 최소자 57 = 19×3 (팀별 오픈 셀 합산)", three.minimalA === 57, { minimalA: three.minimalA });
ck("팀3: 성실자 84 = 28×3", three.diligentB === 84, { diligentB: three.diligentB });
ck("팀3: N=round(57+0.4×27)=68", three.recognitionCountN === 68, { N: three.recognitionCountN });

const withMgmt = computeWeekRecognitionCount({ acts: [], lines: expCells(3, { withManagement: true, withExpansion: true }) });
ck("관리·확장 오픈은 A/B/N 무영향",
  withMgmt.minimalA === three.minimalA && withMgmt.diligentB === three.diligentB && withMgmt.recognitionCountN === three.recognitionCountN,
  { A: withMgmt.minimalA, B: withMgmt.diligentB, N: withMgmt.recognitionCountN });

// 체크되지 않은 셀은 계산하지 않는다(isOpen=false).
const closed = computeWeekRecognitionCount({
  acts: [],
  lines: expCells(3).map((l, i) => (i % 3 === 0 ? { ...l, isOpen: false } : l)),
});
ck("미체크 셀 제외 → 도출 3칸 빠짐 (57−7×3=36)", closed.minimalA === 36, { minimalA: closed.minimalA });

// 실무 정보/역량은 성실자에만 기여하고 기준 평점 가산 없음(기존 정책 불변).
const infoOnly = computeWeekRecognitionCount({
  acts: [],
  lines: [{ id: "info:x", hub: "info", isOpen: true, pointA: 3, pointB: 2, role: "diligent_only" }],
});
ck("info 라인 = B 만 +5, A 기여 0", infoOnly.minimalA === 0 && infoOnly.diligentB === 5, infoOnly);

// 평점 가산은 강화 시 포인트를 대체하지 않는다(A+B 가 보존된 채 더해진다).
const zeroCfg = computeWeekRecognitionCount({
  acts: [],
  lines: [{ id: "exp:z", hub: "experience", isOpen: true, pointA: 0, pointB: 0, role: "minimal_and_diligent", ratingMinimal: 4, ratingDiligent: 7 }],
});
ck("강화 포인트 0 이어도 기준 평점은 가산(4/7)", zeroCfg.minimalA === 4 && zeroCfg.diligentB === 7, zeroCfg);

// 빈 입력.
const empty = computeWeekRecognitionCount({ acts: [], lines: [] });
ck("빈 입력 → 0/0/0", empty.minimalA === 0 && empty.diligentB === 0 && empty.recognitionCountN === 0);

// B ≥ A 불변식(랜덤 구성 100회).
let invariantOk = true;
const types = ["required", "optional", "selection", "basic"] as const;
const hubs = ["info", "experience", "competency"] as const;
for (let i = 0; i < 100; i++) {
  const acts: RecognitionActInput[] = [];
  const lines: RecognitionLineInput[] = [];
  for (let j = 0; j < 8; j++) {
    const a = assignLinePoints(`inv-${i}-${j}`);
    if (j % 2 === 0) acts.push({ id: `${i}-${j}`, actType: types[j % 4], isOpen: j % 5 !== 0, pointA: a.pointA, pointB: a.pointB });
    else lines.push({ id: `${i}-${j}`, hub: hubs[j % 3], isOpen: j % 4 !== 0, pointA: a.pointA, pointB: a.pointB });
  }
  const rr = computeWeekRecognitionCount({ acts, lines });
  if (rr.diligentB < rr.minimalA) invariantOk = false;
  if (rr.recognitionCountN < rr.minimalA || rr.recognitionCountN > rr.diligentB) invariantOk = false;
}
ck("불변식 B≥A 이고 A≤N≤B (100회)", invariantOk);

// 반올림 경계: A=0,B=5 → 0+0.4×5=2.0 → 2. A=0,B=3 → 1.2 → 1. A=0,B=4→1.6→2.
const rd = (a: number, b: number) =>
  computeWeekRecognitionCount({
    acts: [
      ...(a > 0 ? [{ id: "a", actType: "required", isOpen: true, pointA: a, pointB: 0 } as RecognitionActInput] : []),
      { id: "b", actType: "optional", isOpen: true, pointA: b - a, pointB: 0 } as RecognitionActInput,
    ],
    lines: [],
  }).recognitionCountN;
ck("반올림 0+0.4×5=2.0→2", rd(0, 5) === 2, { v: rd(0, 5) });
ck("반올림 0+0.4×3=1.2→1", rd(0, 3) === 1, { v: rd(0, 3) });
ck("반올림 0+0.4×4=1.6→2", rd(0, 4) === 2, { v: rd(0, 4) });

// ── 결정론적 라인 배정 ────────────────────────────────────────────────────
const a1 = assignLinePoints("line-abc-123");
const a2 = assignLinePoints("line-abc-123");
ck("동일 lineId → 동일 결과(재현성)", JSON.stringify(a1) === JSON.stringify(a2), { a1 });

// 범위·버킷 규칙(대량).
const N = 6000;
const dist = { a_only: 0, b_only: 0, both: 0 } as Record<string, number>;
let rangeOk = true;
let bucketRuleOk = true;
for (let i = 0; i < N; i++) {
  const a = assignLinePoints(`sample-${i}`);
  dist[a.bucket]++;
  if (a.pointA < 0 || a.pointA > 20 || a.pointB < 0 || a.pointB > 20) rangeOk = false;
  if (a.bucket === "a_only" && !(a.pointA >= 1 && a.pointB === 0)) bucketRuleOk = false;
  if (a.bucket === "b_only" && !(a.pointB >= 1 && a.pointA === 0)) bucketRuleOk = false;
  if (a.bucket === "both" && !(a.pointA >= 1 && a.pointB >= 1)) bucketRuleOk = false;
}
ck("모든 값 0~20", rangeOk);
ck("버킷 규칙(A만=B0·B만=A0·둘다=양쪽≥1)", bucketRuleOk);
const pA = dist.a_only / N, pB = dist.b_only / N, pBoth = dist.both / N;
const near = (x: number, t: number) => Math.abs(x - t) < 0.03;
ck("비율 ≈ 30/30/40 (±3%p)", near(pA, LINE_POINT_RATIO.aOnly) && near(pB, LINE_POINT_RATIO.bOnly) && near(pBoth, LINE_POINT_RATIO.both), { pA, pB, pBoth });

// ── 라인 등록 → config_key 도출 ─────────────────────────────────────────────
import { deriveLineConfigKey } from "@/lib/adminLinePointConfigsData";
ck("info → activity_types.id(전달값)", deriveLineConfigKey({ hub: "info", lineType: "일반", lineCode: "IFBS-NN0001", infoActivityTypeId: "wisdom" })?.configKey === "wisdom");
ck("info 활동유형 미지정 → null", deriveLineConfigKey({ hub: "info", lineType: "일반", lineCode: "IFBS-NN0001", infoActivityTypeId: "" }) === null);
ck("experience 도출 → derive", deriveLineConfigKey({ hub: "experience", lineType: "도출", lineCode: "X" })?.configKey === "derive");
ck("experience 평가 → research", deriveLineConfigKey({ hub: "experience", lineType: "평가", lineCode: "X" })?.configKey === "research");
ck("experience 확장 → expansion", deriveLineConfigKey({ hub: "experience", lineType: "확장", lineCode: "X" })?.configKey === "expansion");
ck("competency → line_code", deriveLineConfigKey({ hub: "competency", lineType: "원리", lineCode: "CPBS-NN0002" })?.configKey === "CPBS-NN0002");
ck("career → null(제외)", deriveLineConfigKey({ hub: "career", lineType: "일반", lineCode: "X" }) === null);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
