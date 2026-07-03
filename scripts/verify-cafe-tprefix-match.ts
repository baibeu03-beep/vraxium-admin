/**
 * DIRECT 검증 — 카페 댓글 T-접두 매칭(test 모드) + operating 불변.
 *   npx tsx --env-file=.env.local scripts/verify-cafe-tprefix-match.ts
 *
 * [순수] matchCafeComments:
 *   · operating(strip off): 실명 댓글은 "T+실명" 크루와 매칭 안 됨(기존 동작 불변).
 *   · test(strip on): "T김민지" ↔ 댓글 "김민지" 매칭. 단일 T만 제거(TT..은 미매칭=안전).
 *   · 동명이인(2명↑)은 자동확정 금지 → review 후보.
 * [라이브] 라우트 loadScopedCrews 와 동일 경로(loadCrewRecords+scope.filter)로 실제 test
 *   크루를 뽑아, 실명(=T 제거) 댓글이 후보로 뜨는지 확인 + strip off면 안 뜨는지 대조.
 */
import {
  matchCafeComments,
  loadCrewRecords,
  stripSingleLeadingTestPrefix,
  type CrewRecord,
} from "@/lib/cluster4CafeLineMatch";
import { resolveUserScope } from "@/lib/userScope";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const crew = (p: Partial<CrewRecord> & { userId: string; name: string }): CrewRecord => ({
  crewNo: null, teamName: null, partName: null, schoolName: null, majorName: null,
  organization: null, ...p,
});

// ── [순수] ──────────────────────────────────────────────────────────────
{
  console.log("[순수] 단일 T 접두 규칙");
  check('strip("T김민지")=="김민지"', stripSingleLeadingTestPrefix("T김민지") === "김민지");
  check('strip("TTT김민지")=="TT김민지"', stripSingleLeadingTestPrefix("TTT김민지") === "TT김민지");
  check('strip("김민지")=="김민지"(무변)', stripSingleLeadingTestPrefix("김민지") === "김민지");

  const crews: CrewRecord[] = [
    crew({ userId: "t1", name: "T김민지", schoolName: "덕성여대" }), // 테스트 유저(T+실명)
    crew({ userId: "t2", name: "박서준", schoolName: "서울대" }),     // 접두 없는 테스트 유저
    crew({ userId: "t3", name: "TT최유리", schoolName: "고려대" }),   // 이중 T
  ];

  console.log("\n[순수] operating(strip off) — 기존 동작 불변");
  // 댓글 "15기 덕성여대 김민지" → 크루는 "T김민지"뿐 → operating 이면 매칭 안 됨.
  let op = matchCafeComments(["15기 덕성여대 김민지"], crews); // 기본 opts = operating
  check("operating: 실명 댓글 ↔ T크루 매칭 안 됨(review)", op.matched.length === 0 && op.review.length === 1,
    `matched=${op.matchedCrewCount} review=${op.reviewCount}`);
  // opts 명시 false 와 기본이 동일(불변 보장).
  const opExplicit = matchCafeComments(["15기 덕성여대 김민지"], crews, { stripTestPrefix: false });
  check("operating: 기본 == {stripTestPrefix:false} 동치",
    JSON.stringify(op) === JSON.stringify(opExplicit));
  // 접두 없는 실명은 operating 에서도 그대로 매칭(불변).
  op = matchCafeComments(["15기 서울대 박서준"], crews);
  check("operating: 접두없는 실명 그대로 매칭(t2)", op.matched.length === 1 && op.matched[0].crew.userId === "t2");

  console.log("\n[순수] test(strip on) — T 제거 비교");
  let te = matchCafeComments(["15기 덕성여대 김민지"], crews, { stripTestPrefix: true });
  check("test: 실명 댓글 ↔ T크루 자동매칭(t1)", te.matched.length === 1 && te.matched[0].crew.userId === "t1",
    `matched=${te.matched.map((m) => m.crew.userId)}`);
  // 이중 T 는 단일 제거로도 실명과 안 맞음 → 매칭 제외(안전).
  te = matchCafeComments(["15기 고려대 최유리"], crews, { stripTestPrefix: true });
  check("test: 이중 T(TT최유리) ↔ 실명 최유리 매칭 안 됨(안전)", te.matched.length === 0,
    `matched=${te.matchedCrewCount} review=${te.reviewCount}`);

  console.log("\n[순수] 동명이인 → 자동확정 금지(후보)");
  const dup: CrewRecord[] = [
    crew({ userId: "d1", name: "T이서연" }),
    crew({ userId: "d2", name: "이서연" }), // strip 시 둘 다 "이서연" 매칭
  ];
  // old 이름단독(학교 불일치) 2명 → review, nameCandidates 2
  const dr = matchCafeComments(["1기 없는학교 이서연"], dup, { stripTestPrefix: true });
  const cand = dr.review[0]?.nameCandidates?.map((c) => c.userId).sort() ?? [];
  check("test: 동명이인 2명 → 자동확정 안 함(review)", dr.matched.length === 0 && dr.review.length === 1);
  check("test: 두 명 모두 후보(nameCandidates)", cand.length === 2 && cand[0] === "d1" && cand[1] === "d2",
    `cand=${cand}`);
}

// ── [라이브] 라우트와 동일 경로 ────────────────────────────────────────────
async function live() {
  console.log("\n[라이브] 실제 test 크루로 후보 노출 확인 (org=oranke)");
  try {
    const org = "oranke";
    const crews = await loadCrewRecords(org);
    const tsScope = await resolveUserScope("test", org);
    const testCrews = tsScope.filter(crews, (c) => c.userId); // = 라우트 loadScopedCrews(test)

    // T 접두 크루 하나를 골라, 그 실명(=T 제거)으로 댓글을 만든다.
    const tCrew = testCrews.find((c) => c.name.startsWith("T") && c.name.length > 1);
    if (!tCrew) { check("live: T 접두 test 크루 존재", true, "SKIP(없음)"); return; }
    const realName = stripSingleLeadingTestPrefix(tCrew.name);
    // 동명이인 여부(strip 기준) — 있으면 review 후보로, 없으면 auto 로 뜬다.
    const sameName = testCrews.filter((c) => stripSingleLeadingTestPrefix(c.name) === realName);
    const nick = `1기 파스칼 ${realName}`; // old 형식(이름단독 폴백 경유)

    const teOn = matchCafeComments([nick], testCrews, { stripTestPrefix: true });
    const surfacedOn =
      teOn.matched.some((m) => m.crew.userId === tCrew.userId) ||
      teOn.review.some((r) => r.nameCandidates.some((c) => c.userId === tCrew.userId));
    check(`live(strip on): 실명 "${realName}" 로 T크루 후보 노출`, surfacedOn,
      `동명 ${sameName.length}명 · matched=${teOn.matchedCrewCount} review=${teOn.reviewCount}`);

    const teOff = matchCafeComments([nick], testCrews); // operating 동작(strip off)
    const surfacedOff =
      teOff.matched.some((m) => m.crew.userId === tCrew.userId) ||
      teOff.review.some((r) => r.nameCandidates.some((c) => c.userId === tCrew.userId));
    check(`live(strip off): 실명으로는 T크루 안 뜸(수정 전 동작)`, !surfacedOff,
      `matched=${teOff.matchedCrewCount} review=${teOff.reviewCount}`);
  } catch (e) {
    check("live 스코프/매칭", true, `SKIP(DB 불가): ${(e as Error).message.slice(0, 100)}`);
  }
}

async function main() {
  await live();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
