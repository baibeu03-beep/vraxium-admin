/**
 * verify-detail-log-message-meta.ts
 *
 * Detail Log dl-alert 문구(a/b/c/d) 메타 산정 단위 검증.
 *   대상: lib/cluster4WeeklyCardsData.ts withDetailLogMessageMeta (백엔드 SoT)
 *   문구 분기: components/cluster-4-card/Cluster4CardContent.tsx (프론트)와 1:1로 재현.
 *
 * 실행: npx tsx scripts/verify-detail-log-message-meta.ts
 */
import { withDetailLogMessageMeta } from "../lib/cluster4WeeklyCardsData";
import type { Cluster4WeeklyCardDto } from "../shared/cluster4.contracts";

type Status =
  | "success"
  | "fail"
  | "official_rest"
  | "personal_rest"
  | "tallying"
  | "running";

// ── 프론트(Cluster4CardContent) 문구 분기 SoT 재현 ───────────────────────────
const NEW_SUCCESS = "이번 주, <성장 성공> 달성하셨어요! 열심히 달려온 당신께 찬사를!!";
const SUCCESS_THEN_FAIL =
  "앗..! 지난 주에 성장 성공하셨는데, 이번 주에 성장이 실패했다면, 이번 주에는 잠깐 컨디션이 안 좋았을 수 있어요! 다시 가다듬자구요!";
const FAIL_STREAK =
  "앗, 연속해서 주차 성장을 실패하셨다면.. 혹시 클럽의 규정이나 프로세스를 잘 인지하지 못하고 있을 가능성이 있어요! 지피지기면 백전백승! 한번 살펴보자구요!";

type Meta = NonNullable<Cluster4WeeklyCardDto["detailLogMessageMeta"]>;

function messageFor(meta: Meta | null | undefined): {
  case: "a" | "b" | "c" | "d" | "fallback";
  text: string;
  n: number | null;
} {
  if (!meta || !meta.currentWeekStatus) return { case: "fallback", text: "(fallback)", n: null };
  const { currentWeekStatus, previousWeekStatus, successStreakWeeks } = meta;
  if (currentWeekStatus === "success") {
    if (previousWeekStatus === "success") {
      const n =
        typeof successStreakWeeks === "number" && successStreakWeeks >= 2
          ? Math.min(successStreakWeeks, 10)
          : null;
      return n === null
        ? { case: "a", text: NEW_SUCCESS, n: null }
        : { case: "b", text: `지난 주에 이어, 이번주도 역시! 성장 흐름이 ${n}주 째 이어지고 있어요!!`, n };
    }
    return { case: "a", text: NEW_SUCCESS, n: null };
  }
  return previousWeekStatus === "success"
    ? { case: "c", text: SUCCESS_THEN_FAIL, n: null }
    : { case: "d", text: FAIL_STREAK, n: null };
}

// ── 테스트 카드 빌더 (함수가 읽는 필드만: startDate/isTransition/userWeekStatus) ──
let dayCursor = 1;
function card(status: Status): Cluster4WeeklyCardDto {
  const d = String(dayCursor++).padStart(2, "0");
  return {
    startDate: `2026-06-${d}`,
    isTransition: false,
    userWeekStatus: status,
  } as unknown as Cluster4WeeklyCardDto;
}
function transition(): Cluster4WeeklyCardDto {
  const d = String(dayCursor++).padStart(2, "0");
  return {
    startDate: `2026-06-${d}`,
    isTransition: true,
    userWeekStatus: "official_rest",
  } as unknown as Cluster4WeeklyCardDto;
}

type Case = {
  name: string;
  seq: Cluster4WeeklyCardDto[]; // chronological; 마지막 원소가 "현재 주차"
  expectCase: "a" | "b" | "c" | "d";
  expectN?: number | null;
  expectPrev?: Meta["previousWeekStatus"];
};

function run() {
  dayCursor = 1;
  const cases: Case[] = [
    {
      name: "없음 → 성공 = (a)",
      seq: [card("success")],
      expectCase: "a",
      expectPrev: "none",
    },
    {
      name: "실패 → 성공 = (a)",
      seq: [card("fail"), card("success")],
      expectCase: "a",
      expectPrev: "fail",
    },
    {
      name: "성공 → 성공 = (b) n=2",
      seq: [card("success"), card("success")],
      expectCase: "b",
      expectN: 2,
      expectPrev: "success",
    },
    {
      name: "성공·성공 → 성공 = (b) n=3",
      seq: [card("success"), card("success"), card("success")],
      expectCase: "b",
      expectN: 3,
      expectPrev: "success",
    },
    {
      name: "성공 | 집계중 | 실패 = (c)",
      seq: [card("success"), card("tallying"), card("fail")],
      expectCase: "c",
      expectPrev: "success",
    },
    {
      name: "성공 | 공식휴식 | 실패 = (c)",
      seq: [card("success"), card("official_rest"), card("fail")],
      expectCase: "c",
      expectPrev: "success",
    },
    {
      name: "성공 | 개인휴식 | 실패 = (c) [정책: 개인휴식도 skip]",
      seq: [card("success"), card("personal_rest"), card("fail")],
      expectCase: "c",
      expectPrev: "success",
    },
    {
      name: "실패 | 집계중 | 실패 = (d)",
      seq: [card("fail"), card("tallying"), card("fail")],
      expectCase: "d",
      expectPrev: "fail",
    },
    {
      name: "실패 → 실패 = (d)",
      seq: [card("fail"), card("fail")],
      expectCase: "d",
      expectPrev: "fail",
    },
    {
      name: "성공 | 공식휴식 | 성공 = (a) streak=1",
      seq: [card("success"), card("official_rest"), card("success")],
      expectCase: "a",
      expectPrev: "success",
    },
    {
      name: "성공 | 개인휴식 | 성공 = (a) streak=1",
      seq: [card("success"), card("personal_rest"), card("success")],
      expectCase: "a",
      expectPrev: "success",
    },
    {
      name: "성공 | 시즌경계(직접인접) | 실패 = (c)",
      seq: [card("success"), card("fail")],
      expectCase: "c",
      expectPrev: "success",
    },
    {
      name: "실패 | 시즌경계(직접인접) | 성공 = (a)",
      seq: [card("fail"), card("success")],
      expectCase: "a",
      expectPrev: "fail",
    },
    {
      name: "성공 | 전환주차 | 성공 = (a) streak=1 [전환은 streak 끊음]",
      seq: [card("success"), transition(), card("success")],
      expectCase: "a",
      expectPrev: "success",
    },
    {
      name: "성공 | 성공 | 성공(연속10 초과 캡) = (b) n=10",
      seq: Array.from({ length: 12 }, () => card("success")),
      expectCase: "b",
      expectN: 10,
      expectPrev: "success",
    },
    {
      // 실제 보고 사례 fixture
      name: "★ 실사례: 봄13 성공 → 봄14~16 휴식(공식) → 여름1 집계중 → 여름2 실패 = (c)",
      seq: [
        card("success"), // 봄13
        card("official_rest"), // 봄14
        card("official_rest"), // 봄15
        card("official_rest"), // 봄16
        card("tallying"), // 여름1
        card("fail"), // 여름2 (현재)
      ],
      expectCase: "c",
      expectPrev: "success",
    },
  ];

  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    dayCursor = 1; // reset so startDate 순서가 seq 인덱스와 일치
    const seq = c.seq.map((x, i) => ({
      ...x,
      startDate: `2026-06-${String(i + 1).padStart(2, "0")}`,
    })) as Cluster4WeeklyCardDto[];
    const withMeta = withDetailLogMessageMeta(seq);
    const current = withMeta[withMeta.length - 1];
    const meta = current.detailLogMessageMeta ?? null;
    const msg = messageFor(meta);

    const okCase = msg.case === c.expectCase;
    const okN = c.expectN === undefined ? true : msg.n === c.expectN;
    const okPrev =
      c.expectPrev === undefined ? true : meta?.previousWeekStatus === c.expectPrev;
    const ok = okCase && okN && okPrev;
    if (ok) pass++;
    else fail++;

    console.log(
      `${ok ? "✅" : "❌"} ${c.name}\n     case=${msg.case}${
        c.expectN !== undefined ? ` n=${msg.n}` : ""
      } prev=${meta?.previousWeekStatus ?? "-"} cur=${meta?.currentWeekStatus ?? "-"} streak=${
        meta?.successStreakWeeks ?? "-"
      }`,
    );
    if (!ok) {
      console.log(
        `     EXPECT case=${c.expectCase}${
          c.expectN !== undefined ? ` n=${c.expectN}` : ""
        }${c.expectPrev !== undefined ? ` prev=${c.expectPrev}` : ""}`,
      );
    }
  }

  // 실사례 문구 원문 대조
  console.log("\n── 실사례 최종 문구 ──");
  dayCursor = 1;
  const real = withDetailLogMessageMeta([
    { startDate: "2026-05-25", isTransition: false, userWeekStatus: "success" },
    { startDate: "2026-06-01", isTransition: false, userWeekStatus: "official_rest" },
    { startDate: "2026-06-08", isTransition: false, userWeekStatus: "official_rest" },
    { startDate: "2026-06-15", isTransition: false, userWeekStatus: "official_rest" },
    { startDate: "2026-06-29", isTransition: false, userWeekStatus: "tallying" },
    { startDate: "2026-07-06", isTransition: false, userWeekStatus: "fail" },
  ] as unknown as Cluster4WeeklyCardDto[]);
  const realMeta = real[real.length - 1].detailLogMessageMeta ?? null;
  const realMsg = messageFor(realMeta);
  console.log(`   meta = ${JSON.stringify(realMeta)}`);
  console.log(`   case = ${realMsg.case}  (기대: c)`);
  console.log(`   text = ${realMsg.text}`);
  const realOk = realMsg.case === "c" && realMsg.text === SUCCESS_THEN_FAIL;
  console.log(`   ${realOk ? "✅ 실사례 통과" : "❌ 실사례 실패"}`);
  if (!realOk) fail++;

  console.log(`\n=== 결과: ${pass} pass / ${fail} fail ===`);
  if (fail > 0) process.exit(1);
}

run();
