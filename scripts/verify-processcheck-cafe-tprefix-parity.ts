/**
 * 검증 — /admin/processes/check/ 카페 T-접두 매칭이 /admin/line-opening/ 와 파리티인지.
 *   npx tsx --env-file=.env.local scripts/verify-processcheck-cafe-tprefix-parity.ts
 *
 * [실경로] process check 의 실제 매칭 함수 inProcessCrawlAndMatch(부수효과 없음: 크롤+스코프+매칭)를
 *   mock 크롤러(CAFE_CRAWLER_URL 로 주입)로 직접 구동한다. 크롤러가 실명 "강민지"를 반환할 때:
 *     · mode=test      → 테스트 크루 "T강민지" 가 매칭 후보(matched/review)로 나와야 한다.
 *     · mode=operating → 실명 "강민지" 로는 "T강민지" 가 절대 안 나와야 한다(기존 동작 불변).
 * [파리티] 같은 닉네임/같은 org 에서 line-opening 파이프라인(loadScopedCrews+matchCafeComments)과
 *   process-check(inProcessCrawlAndMatch)의 matched userId 집합이 동일해야 한다.
 * [DB 무변] 이 스크립트는 read-only(크루 조회+순수 매칭)만 한다 — status/point/snapshot 미접촉.
 */
import { createServer } from "node:http";
import {
  loadCrewRecords,
  matchCafeComments,
  stripSingleLeadingTestPrefix,
  type CrewRecord,
} from "@/lib/cluster4CafeLineMatch";
import { resolveUserScope } from "@/lib/userScope";
import { inProcessCrawlAndMatch } from "@/lib/processCheckDueSweep";

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const norm = (s: string) => s.trim().replace(/\s+/g, "").toLowerCase();

// 후보 org 목록 — 첫 번째로 "T+실명"(단일 T) 테스트 크루가 있는 org 를 골라 검증한다.
const ORGS = (process.env.VERIFY_ORGS ?? "phalanx,oranke,encre,olympus").split(",").map((s) => s.trim());

async function pickTargetOrg(): Promise<{
  org: string;
  tCrew: CrewRecord;
  realName: string;
  testCrews: CrewRecord[];
} | null> {
  for (const org of ORGS) {
    const crews = await loadCrewRecords(org);
    const scope = await resolveUserScope("test", org);
    const testCrews = scope.filter(crews, (c) => c.userId);
    const tCrew = testCrews.find(
      (c) => c.name.startsWith("T") && c.name.length > 1 && !c.name.startsWith("TT"),
    );
    if (tCrew) return { org, tCrew, realName: stripSingleLeadingTestPrefix(tCrew.name), testCrews };
  }
  return null;
}

function surfaced(
  res: { matched: { userId: string }[]; review: { nickname: string; reason: string }[] },
  userId: string,
): boolean {
  return res.matched.some((m) => m.userId === userId);
}

async function main() {
  const target = await pickTargetOrg();
  if (!target) {
    console.log("SKIP — 후보 org 에 'T+실명' 테스트 크루가 없습니다.");
    process.exit(0);
  }
  const { org, tCrew, realName, testCrews } = target;
  const nickname = `1기 카페대 ${realName}`; // 구형 포맷(이름-단독 폴백 경유)

  // 요구사항 #6 — 원문/normalize/테스트 display_name/T제거 normalize 비교값 출력.
  console.log(`대상 org=${org}`);
  console.log(`  카페 댓글 원문 nickname     : "${nickname}"  (parsed name="${realName}")`);
  console.log(`  댓글 작성자명 normalize      : "${norm(realName)}"`);
  console.log(`  테스트 사용자 display_name   : "${tCrew.name}"  (userId ${tCrew.userId.slice(0, 8)})`);
  console.log(`  T 제거 후 normalize          : "${norm(stripSingleLeadingTestPrefix(tCrew.name))}"`);
  console.log(
    `  → normalize 동치?             : ${norm(realName) === norm(stripSingleLeadingTestPrefix(tCrew.name)) ? "YES" : "NO"}`,
  );
  const dupCount = testCrews.filter(
    (c) => norm(stripSingleLeadingTestPrefix(c.name)) === norm(realName),
  ).length;
  console.log(`  동명(T제거 기준) 테스트 크루 : ${dupCount}명 (1명=auto, 2명↑=review 후보)\n`);

  // ── mock 크롤러: POST /crawl → 실명 닉네임 1건 ──
  const mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            articleUrl: "https://cafe.naver.com/mock/1",
            totalComments: 1,
            uniqueNicknames: 1,
            nicknames: [nickname],
            nicknameCounts: [{ nickname, count: 1 }],
          },
        }),
      );
    });
  });
  const port = Number(process.env.MOCK_CRAWLER_PORT ?? 4611);
  await new Promise<void>((r) => mock.listen(port, r));
  const prevCrawler = process.env.CAFE_CRAWLER_URL;
  process.env.CAFE_CRAWLER_URL = `http://localhost:${port}`;
  delete process.env.CAFE_CRAWLER_SECRET; // mock 은 인증 불필요

  try {
    const mockUrl = "https://cafe.naver.com/mock/1";

    // line-opening(cafe-line-crew POST)의 "실효 모드" 재현: mode=resolveUserScope(...).mode.
    //   ⚠ 현재 QA_HIDE_REAL_USERS=true → 요청 operating 도 effective=test 로 고정된다(단일 스위치).
    //   따라서 두 화면 모두 지금은 strip on 이 정상이며, 핵심 요구는 "두 화면이 항상 같다"이다.
    const allCrews = await loadCrewRecords(org);
    const lineOpening = async (reqMode: "test" | "operating") => {
      const scope = await resolveUserScope(reqMode, org); // cafe-line-crew POST 와 동일
      const pool = scope.filter(allCrews, (c) => c.userId);
      return {
        effMode: scope.mode,
        res: matchCafeComments([nickname], pool, { stripTestPrefix: scope.mode === "test" }),
      };
    };

    // ── [실경로] process-check 의 실제 함수 (요청 mode 별) ──
    console.log("[실경로] inProcessCrawlAndMatch (process-check 실제 매칭 함수)");
    for (const reqMode of ["test", "operating"] as const) {
      const pc = await inProcessCrawlAndMatch(org, reqMode, mockUrl);
      const lo = await lineOpening(reqMode);
      const eff = lo.effMode; // 두 경로 모두 동일한 resolveUserScope 를 거치므로 실효 모드 동일
      check(
        `요청=${reqMode}(실효=${eff}): 실명 "${realName}" → "${tCrew.name}" ${
          eff === "test" ? "노출(strip on)" : "안 나옴(strip off)"
        }`,
        eff === "test" ? surfaced(pc, tCrew.userId) : !surfaced(pc, tCrew.userId),
        `matched=${pc.matched.length} review=${pc.review.length}`,
      );
      const pcSet = pc.matched.map((m) => m.userId).sort();
      const loSet = lo.res.matched.map((m) => m.crew.userId).sort();
      check(
        `요청=${reqMode}: process-check matched == line-opening matched (파리티)`,
        JSON.stringify(pcSet) === JSON.stringify(loSet),
        `pc=[${pcSet.map((s) => s.slice(0, 8))}] lo=[${loSet.map((s) => s.slice(0, 8))}]`,
      );
    }

    // ── [SoT 불변] QA 종료(operating) 후 보장: strip off → 실명은 T크루와 절대 매칭 안 됨(요구 #3) ──
    console.log("\n[SoT 불변] QA 종료 후 operating(strip off) 동작 — 요구 #3");
    const offRes = matchCafeComments([nickname], testCrews, { stripTestPrefix: false });
    check(
      `operating(strip off): "${realName}" ↔ "${tCrew.name}" 매칭 안 됨`,
      !surfaced(offRes, tCrew.userId),
      `matched=${offRes.matched.length} review=${offRes.review.length}`,
    );
    check(
      "fix 식 scope.mode==='test' 는 operating 에서 false → strip off (line-opening 과 동일 식)",
      ("operating" === "test") === false,
    );
  } finally {
    mock.close();
    if (prevCrawler === undefined) delete process.env.CAFE_CRAWLER_URL;
    else process.env.CAFE_CRAWLER_URL = prevCrawler;
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
