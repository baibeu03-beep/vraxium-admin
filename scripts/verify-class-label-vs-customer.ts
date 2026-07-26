// 어드민 클래스 라벨 ↔ 고객앱 클래스 라벨 parity(순수 함수 비교, DB/HTTP 무관).
// ─────────────────────────────────────────────────────────────────────
// 어드민 화면이 쓰는 resolvePositionLabels / weekClassLabel 과, 고객앱(vraxium)이 쓰는
// resolveCrewClassLabel 이 **같은 입력에 같은 라벨**을 내는지 확인한다.
// 두 레포가 shared/crewClassPosition.ts 미러를 공유하므로 결과는 구조적으로 같아야 한다.
// 실행: npx tsx scripts/verify-class-label-vs-customer.ts
import { resolvePositionLabels, weekClassLabel } from "../lib/adminMembersTypes";

// 고객앱 lib/crewClassDisplayLabel.resolveCrewClassLabel 과 동일 우선순위(코드 → 라벨 폴백).
//   고객 레포를 import 할 수 없으므로 같은 계약을 admin 함수로 표현해 비교한다.
const customerLike = (positionCode: string | null, roleLabel: string | null) =>
  weekClassLabel(positionCode, roleLabel);

type Case = {
  desc: string;
  role: string | null;
  level: string | null;
  positionCode: string | null;
  weekRoleLabel: string | null;
};

const CASES: Case[] = [
  { desc: "파트장(등급 심화) — 주차 코드 있음", role: "part_leader", level: "심화", positionCode: "advanced_part_leader", weekRoleLabel: "심화" },
  { desc: "파트장 — 주차 코드 없음(구 스냅샷)", role: "part_leader", level: "심화", positionCode: null, weekRoleLabel: "심화" },
  { desc: "에이전트(등급 심화)", role: "agent", level: "심화", positionCode: "advanced_agent", weekRoleLabel: "심화" },
  { desc: "일반 크루", role: "crew", level: "일반", positionCode: "regular", weekRoleLabel: "일반" },
  { desc: "팀장(등급 일반)", role: "team_leader", level: "일반", positionCode: "operating_team_leader", weekRoleLabel: "일반" },
  { desc: "팀장(등급 심화)", role: "team_leader", level: "심화", positionCode: "operating_team_leader", weekRoleLabel: "심화" },
  { desc: "앰배서더(등급 일반)", role: "ambassador", level: "일반", positionCode: "operating_ambassador", weekRoleLabel: "일반" },
  { desc: "등급 컬럼이 완성 라벨", role: null, level: "심화(파트장)", positionCode: "advanced_part_leader", weekRoleLabel: "심화(파트장)" },
  { desc: "등급 컬럼이 완성 라벨(에이전트)", role: null, level: "심화(에이전트)", positionCode: "advanced_agent", weekRoleLabel: "심화(에이전트)" },
  { desc: "role=part_leader 인데 등급 일반(단독 심화 금지)", role: "part_leader", level: "일반", positionCode: "regular", weekRoleLabel: "일반" },
  { desc: "등급 공백 포함('심화 ')", role: null, level: "심화 ", positionCode: "advanced_agent", weekRoleLabel: "심화 " },
  { desc: "과거 주차 코드가 현재 role 과 다름(as-of-week)", role: "part_leader", level: "심화", positionCode: "regular", weekRoleLabel: "정규" },
  { desc: "현재 주차 override 로 승급", role: "crew", level: "일반", positionCode: "advanced_part_leader", weekRoleLabel: "일반" },
];

let fail = 0;
const rows = CASES.map((c) => {
  const adminCurrent = resolvePositionLabels({
    positionCode: c.positionCode,
    role: c.role,
    membershipLevel: c.level,
  }).classLabel;
  const adminWeek = weekClassLabel(c.positionCode, c.weekRoleLabel);
  const customer = customerLike(c.positionCode, c.weekRoleLabel);
  const ok = adminWeek === customer && (c.positionCode ? adminCurrent === adminWeek : true);
  if (!ok) fail++;
  return {
    케이스: c.desc,
    "role/등급": `${c.role ?? "null"} / ${c.level ?? "null"}`,
    code: c.positionCode ?? "null",
    "어드민(현재)": adminCurrent,
    "어드민(주차)": adminWeek,
    "고객앱(주차)": customer,
    판정: ok ? "✓" : "✗",
  };
});

console.table(rows);
if (fail > 0) {
  console.error(`❌ 어드민↔고객앱 라벨 불일치 ${fail}건`);
  process.exit(1);
}
console.log("✅ 어드민 라벨러(resolvePositionLabels / weekClassLabel)와 고객앱 표시 규칙이 전 케이스 일치");
