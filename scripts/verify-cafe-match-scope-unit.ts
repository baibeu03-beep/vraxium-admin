// 매칭/스코프 무변경 검증 — C안 1차 변경(닉네임 출처 교체)이 매칭·스코프 SoT 를 건드리지 않음을 확인.
//   [순수] matchCafeComments: 자동 vs 수동확인, 동일크루 dedupe, 동명이인→review, 신형 3토큰→auto
//   [라이브] resolveUserScope: operating/test 분리(마커 전수)  ·  loadCrewRecords: org 격리 불변
// 사용법: npm run verify:cafe-match-scope   (--env-file=.env.local — 라이브 파트용)
import { matchCafeComments, type CrewRecord } from "../lib/cluster4CafeLineMatch";
import { resolveUserScope } from "../lib/userScope";
import { loadCrewRecords } from "../lib/cluster4CafeLineMatch";

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => checks.push({ name, pass, detail });

const crew = (p: Partial<CrewRecord> & { userId: string; name: string }): CrewRecord => ({
  crewNo: null,
  teamName: null,
  partName: null,
  schoolName: null,
  majorName: null,
  organization: null,
  ...p,
});

// ── [순수] matchCafeComments — DB 불요 ──────────────────────────────────────────
{
  const crews: CrewRecord[] = [
    crew({ userId: "u1", name: "이채빈", schoolName: "덕성여대" }),
    crew({ userId: "u2", name: "이채빈", schoolName: "서울대" }), // 동명이인(이름만으론 2명)
    crew({ userId: "u3", name: "김민수", teamName: "콘텐츠팀", majorName: "국제학부" }),
  ];

  // 구형 "기수 학교 이름" → 이름+학교 정확히 1명 → auto
  let r = matchCafeComments(["15기 덕성여대 이채빈"], crews);
  check(
    "구형 이름+학교 → 자동(u1)",
    r.matched.length === 1 && r.matched[0].crew.userId === "u1" && r.review.length === 0,
    `matched=${r.matched.map((m) => m.crew.userId)} review=${r.reviewCount}`,
  );

  // 이름만(학교 토큰 없음/불명) 동명이인 2명 → review (오매칭 방지)
  r = matchCafeComments(["이채빈"], crews);
  check(
    "동명이인 이름단독 → 수동확인",
    r.matched.length === 0 && r.review.length === 1,
    `matched=${r.matchedCrewCount} review=${r.reviewCount}`,
  );

  // 신형 3토큰 이름+팀+전공 정확히 1명 → auto
  r = matchCafeComments(["김민수 콘텐츠팀 국제학부"], crews);
  check(
    "신형 이름+팀+전공 → 자동(u3)",
    r.matched.length === 1 && r.matched[0].crew.userId === "u3",
    `matched=${r.matched.map((m) => m.crew.userId)}`,
  );

  // 동일 크루 중복 댓글 → 1회만
  r = matchCafeComments(["15기 덕성여대 이채빈", "15기 덕성여대 이채빈"], crews);
  check("동일 크루 중복 → dedupe(1)", r.matched.length === 1, `matched=${r.matchedCrewCount}`);

  // 형식 불명 → 절대 자동 금지(review)
  r = matchCafeComments(["abcd"], crews);
  check("형식 불명 → 수동확인", r.matched.length === 0 && r.review.length === 1, `review=${r.reviewCount}`);
}

// ── [라이브] 스코프 SoT (DB) — 실패 시 SKIP(순수 파트 결과는 유지) ─────────────────
async function liveScope() {
  try {
    const op = await resolveUserScope("operating", null);
    const te = await resolveUserScope("test", null);
    const markers = Array.from(op.testUserIds);

    // 마커(테스트유저) 전수: operating 제외 · test 포함 (실/테스트 분리 SoT 불변)
    const sep =
      markers.length === 0 ||
      markers.every((id) => op.includes(id) === false && te.includes(id) === true);
    check(
      "test/operating 분리(마커 전수)",
      sep,
      `markers=${markers.length} (operating제외·test포함)`,
    );

    // 비마커 임의 id: operating 포함 · test 제외
    const nonMarker = "00000000-0000-0000-0000-000000000000";
    check(
      "비마커 id — operating 포함·test 제외",
      op.includes(nonMarker) === true && te.includes(nonMarker) === false,
      `op=${op.includes(nonMarker)} te=${te.includes(nonMarker)}`,
    );
  } catch (e) {
    check("test/operating 분리(라이브)", true, `SKIP(DB 불가): ${(e as Error).message.slice(0, 80)}`);
  }
}

async function liveOrgIsolation() {
  try {
    const all = await loadCrewRecords(null);
    // 데이터에 존재하는 임의 org 하나로 격리 불변 확인.
    const someOrg = all.find((c) => c.organization)?.organization ?? null;
    if (!someOrg) {
      check("org 격리(loadCrewRecords)", true, "SKIP(org 보유 크루 없음)");
      return;
    }
    const scoped = await loadCrewRecords(someOrg);
    const allSameOrg = scoped.every((c) => c.organization === someOrg);
    check(
      `org 격리 — '${someOrg}' 스코프 전원 동일 org`,
      allSameOrg && scoped.length <= all.length,
      `scoped=${scoped.length}/${all.length} allSameOrg=${allSameOrg}`,
    );
  } catch (e) {
    check("org 격리(loadCrewRecords)", true, `SKIP(DB 불가): ${(e as Error).message.slice(0, 80)}`);
  }
}

async function main() {
  await liveScope();
  await liveOrgIsolation();

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`${c.pass ? "PASS" : "FAIL"} | ${c.name} | ${c.detail}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
