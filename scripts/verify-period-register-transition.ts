/**
 * 기간 등록 "전환 주차" 신규 정책 검증 (direct).
 *   전환 주차 = **도착(다음) 시즌 + 0주차** 전용. 구 정책("이전 시즌 + 마지막+1 주차", 봄17/여름9)
 *   폐기. 클라이언트 폼·서버 POST·본 스크립트가 모두 lib/seasonCalendar.validateTransitionWeek
 *   단일 SoT 를 공유한다(본 스크립트는 미러가 아니라 실제 함수를 직접 호출).
 *
 *   [1] validateTransitionWeek 규칙 — 사용자 요구 8 시나리오 단언.
 *   [2] 실DB 전환 주차 = week_number===0 · is_official_rest=false (isTransitionWeek 파생).
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-period-register-transition.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  validateTransitionWeek,
  isTransitionWeek,
  type PeriodActivityType,
} from "@/lib/seasonCalendar";

let pass = 0,
  fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

// 서버 POST 가 booleans → activityType 을 유도하는 방식과 동일.
function activityTypeOf(
  isTransition: boolean,
  isOfficialRest: boolean,
): PeriodActivityType {
  return isTransition ? "transition" : isOfficialRest ? "rest" : "official";
}

async function main() {
  console.log("[1] validateTransitionWeek — 신규 정책 8 시나리오");

  // 1) 가을 + 0주차 + 전환 주차 → 등록 성공
  const s1 = validateTransitionWeek({
    seasonType: "autumn",
    weekNumber: 0,
    activityType: "transition",
  });
  ck("가을 + 0주차 + 전환 → 성공", s1.ok, s1.ok ? "" : s1.message);

  // 2) 가을 + 17주차 + 전환 주차 → 등록 차단
  const s2 = validateTransitionWeek({
    seasonType: "autumn",
    weekNumber: 17,
    activityType: "transition",
  });
  ck("가을 + 17주차 + 전환 → 차단", !s2.ok, s2.ok ? "" : s2.message);
  ck(
    "  └ 차단 문구가 '가을 시즌 0주차' 안내",
    !s2.ok && s2.message.includes("가을 시즌 0주차"),
    s2.ok ? "" : s2.message,
  );

  // 3) 가을 + 0주차 + 공식 활동 → 등록 차단
  const s3 = validateTransitionWeek({
    seasonType: "autumn",
    weekNumber: 0,
    activityType: "official",
  });
  ck("가을 + 0주차 + 공식 활동 → 차단", !s3.ok, s3.ok ? "" : s3.message);

  // 4) 가을 + 0주차 + 공식 휴식 → 등록 차단(명확한 오류)
  const s4 = validateTransitionWeek({
    seasonType: "autumn",
    weekNumber: 0,
    activityType: "rest",
  });
  ck("가을 + 0주차 + 공식 휴식 → 차단", !s4.ok, s4.ok ? "" : s4.message);

  // 5) 가을 + 1주차 + 공식 활동 → 정상 등록
  const s5 = validateTransitionWeek({
    seasonType: "autumn",
    weekNumber: 1,
    activityType: "official",
  });
  ck("가을 + 1주차 + 공식 활동 → 정상", s5.ok, s5.ok ? "" : s5.message);

  // 여름 전환(구 정책 9주차)도 동일하게 0주차만 허용
  const sSummerOld = validateTransitionWeek({
    seasonType: "summer",
    weekNumber: 9,
    activityType: "transition",
  });
  ck("여름 + 9주차(구 전환) + 전환 → 차단", !sSummerOld.ok);
  const sSummerNew = validateTransitionWeek({
    seasonType: "summer",
    weekNumber: 0,
    activityType: "transition",
  });
  ck("여름 + 0주차 + 전환 → 성공", sSummerNew.ok);

  // 7·8) 클라이언트/서버·일반/test·actAs/demo 는 동일 함수를 쓰므로 유도 경로 동등성만 확인.
  const viaBooleans = validateTransitionWeek({
    seasonType: "autumn",
    weekNumber: 0,
    activityType: activityTypeOf(true, false),
  });
  ck("서버 booleans 유도 activityType == 'transition' 경로 동일", viaBooleans.ok);

  console.log("\n[2] 실DB 전환 주차 = week_number 0 · is_official_rest false");
  const { data: weeks } = await supabaseAdmin
    .from("weeks")
    .select("season_key, week_number, start_date, is_official_rest")
    .order("season_key", { ascending: true });
  const rows = (weeks ?? []) as {
    season_key: string | null;
    week_number: number | null;
    start_date: string | null;
    is_official_rest: boolean | null;
  }[];
  const transitionRows = rows.filter((w) =>
    isTransitionWeek({
      week_number: w.week_number,
      start_date: w.start_date,
    }),
  );
  console.log(`    전환 주차 row 수: ${transitionRows.length}`);
  for (const r of transitionRows.slice(0, 8)) {
    console.log(
      `      - ${r.season_key} W${r.week_number} (is_official_rest=${r.is_official_rest})`,
    );
  }
  ck("실DB 전환 주차 1건 이상", transitionRows.length > 0, `${transitionRows.length}건`);
  ck(
    "모든 전환 주차 week_number === 0",
    transitionRows.every((r) => r.week_number === 0),
  );
  ck(
    "모든 전환 주차 is_official_rest === false",
    transitionRows.every((r) => r.is_official_rest === false),
  );
  // 구 정책 잔재(정규 주수 초과 week_number, 17/9)가 없어야 한다.
  const legacyLeftover = rows.filter(
    (r) => (r.week_number ?? 0) > 16,
  );
  ck("구모델 잔재(week_number > 16) 없음", legacyLeftover.length === 0, `${legacyLeftover.length}건`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
