// 검증: (1) 검수 write/read 스코프가 mode=test 여도 operating 으로 통일되는지,
//        (2) 현재/미래 주차 검수 완료 가드가 실제로 차단하는지(공표/검수 미실행),
//        (3) W1 이 operating 단일 저장소 read 로 카드에 정상 존재하는지(no_data 드롭 없음),
//        (4) 되돌리기(operating) 후에도 W1 이 tallying 으로 표시되어 사라지지 않는지(순수 판정).
//   npx tsx --env-file=.env.local scripts/verify-review-scope-and-guard.ts
//   ⚠ 쓰기 없음 — W2 가드는 write 이전에 throw, 나머지는 순수 read/compute.
import { createClient } from "@supabase/supabase-js";
import {
  resolveStateScopeForUser,
  resolveStateScopeFromMode,
  resolveStateScopeFromRequest,
} from "@/lib/operationalState";
import { markTeamPartsWeekReviewed, WeekDetailWriteError } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { resolveWeekResultStatus } from "@/lib/growthCore";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const W1_ID = "496656d0-8d92-4738-b69b-e5e28aa1d57a"; // 2026-summer W1 (past)
const W2_ID = "39aae7a0-216f-4262-8a67-6beef1bccf22"; // 2026-summer W2 (current)
const W1_START = "2026-06-29";
const SAMPLE_USER = "e649370f-ba2c-4d2f-b642-6800cb078d54"; // T김민준 (test user, encre)

function pass(b: boolean) { return b ? "✅ PASS" : "❌ FAIL"; }

async function main() {
  // (1) 스코프 통일 — mode=test 여도 operating.
  const fakeReq = { nextUrl: { searchParams: new URLSearchParams("mode=test") } } as any;
  const sReq = resolveStateScopeFromRequest(fakeReq);
  const sMode = resolveStateScopeFromMode("test");
  const sUser = await resolveStateScopeForUser(SAMPLE_USER); // 테스트 유저
  console.log("=== (1) 스코프 통일 (mode=test) ===");
  console.log(`  resolveStateScopeFromRequest(?mode=test) = ${sReq}  ${pass(sReq === "operating")}`);
  console.log(`  resolveStateScopeFromMode("test")        = ${sMode} ${pass(sMode === "operating")}`);
  console.log(`  resolveStateScopeForUser(testUser)       = ${sUser} ${pass(sUser === "operating")}`);
  console.log();

  // (3) W1 operating read → 카드 존재 + fail (no_data 드롭 없음). 순수 compute(쓰기 없음).
  console.log("=== (3) W1 카드 존재 (operating 단일 read) ===");
  const cards = await getCluster4WeeklyCardsForProfileUser(SAMPLE_USER);
  const w1card = cards.find((c: any) => c.startDate === W1_START || c.weekStartDate === W1_START) as any;
  console.log(`  W1 카드 = ${w1card ? (w1card.userWeekStatus ?? w1card.status) : "(없음/드롭)"}  ` +
    `${pass(!!w1card && (w1card.userWeekStatus ?? w1card.status) !== null)}`);
  console.log();

  // (2) W2(현재 주차) 검수 완료 가드 — 실제 markTeamPartsWeekReviewed 호출(가드가 write 이전 throw).
  console.log("=== (2) W2(현재 주차) 검수 완료 가드 ===");
  // 사전 상태(쓰기 없음 확인용): operating weeks + qa_weeks_state.
  const { data: beforeW2 } = await sb.from("weeks")
    .select("result_published_at,result_reviewed_at").eq("id", W2_ID).maybeSingle();
  let guardMsg = "", guardStatus = 0, threw = false;
  try {
    await markTeamPartsWeekReviewed(W2_ID, null, {
      scope: resolveStateScopeFromRequest(fakeReq), // = operating
      allowIncompleteTestData: true,
    });
  } catch (e) {
    threw = true;
    if (e instanceof WeekDetailWriteError) { guardStatus = e.status; guardMsg = e.message; }
    else guardMsg = `(예상외 예외) ${e instanceof Error ? e.message : String(e)}`;
  }
  const expectedMsg = "현재 진행 중인 주차는 아직 검수 완료할 수 없습니다. 주차가 종료된 후 검수 완료를 진행해주세요.";
  console.log(`  throw 여부 = ${threw}  status=${guardStatus}  ${pass(threw && guardStatus === 422)}`);
  console.log(`  메시지 일치 = ${pass(guardMsg === expectedMsg)}`);
  console.log(`  메시지: "${guardMsg}"`);
  // 쓰기 없음 확인: W2 공표/검수 플래그 불변.
  const { data: afterW2 } = await sb.from("weeks")
    .select("result_published_at,result_reviewed_at").eq("id", W2_ID).maybeSingle();
  const noWrite = JSON.stringify(beforeW2) === JSON.stringify(afterW2)
    && (afterW2 as any)?.result_published_at == null;
  console.log(`  W2 공표/검수 미실행(쓰기 없음) = ${pass(noWrite)}  (pub=${(afterW2 as any)?.result_published_at ?? "null"})`);
  console.log();

  // (4) 되돌리기(operating) 시나리오 순수 판정 — operating pub=null + uws=none + 과거주 → tallying(드롭 아님).
  console.log("=== (4) 되돌리기 후 W1 판정 (operating pub=null, uws=none, 과거주) ===");
  const reverted = resolveWeekResultStatus({
    uwsStatus: null,
    isCurrentWeek: false,
    isPublished: false,       // operating 되돌리기로 weeks.pub=null
    weekIsOfficialRest: false,
    experienceVerdictStatus: null,
  });
  console.log(`  status = ${reverted.status}  ${pass(reverted.status === "tallying")}  (드롭=null 아님 → 카드 유지)`);
  console.log();

  // 참고: 혼합 상태(구 버그) 재현 — operating pub=Y + uws=none 이면 드롭(null). 이제 write=read=operating 라
  //   되돌리기가 pub 도 함께 내려 이 조합이 생기지 않는다.
  const mixed = resolveWeekResultStatus({
    uwsStatus: null, isCurrentWeek: false, isPublished: true, weekIsOfficialRest: false, experienceVerdictStatus: null,
  });
  console.log(`  (참고) 구 혼합상태 판정(pub=Y,uws=none) = ${mixed.status}  ← 이 조합이 카드 사라짐의 원인이었음`);

  console.log("\n done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
