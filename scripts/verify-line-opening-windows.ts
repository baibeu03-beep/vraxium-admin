/**
 * verify-line-opening-windows.ts
 * 라인 개설 예외(line_opening_windows) 판정 직접 검증 (read/write — 테스트 행은 정리됨).
 *
 * 실행(마이그레이션 적용 후):
 *   npx tsx --env-file=.env.local scripts/verify-line-opening-windows.ts
 *
 * 검증 항목(스펙 1·4·5·6·7):
 *   1) findActiveLineOpeningException direct 결과
 *   4) 자동 정책 주차 정상 — (게이트 로직: auto week 은 예외 없이도 허용. 본 스크립트는 예외 함수만 검증)
 *   5) 예외 허용 주차 정상 — 전체(주차) 예외 → 모든 활동유형 true
 *   6) 특정 라인만 허용 정상 — 라인 스코프 예외 → 해당 유형만 true, 그 외 false
 *   7) 예외 삭제/비활성 후 즉시 차단 — false 복귀
 *
 * HTTP/브라우저(2·3·11)는 admin 세션이 필요하므로 수동 확인. 단, API 라우트는
 *   동일 데이터 레이어 함수(findActiveLineOpeningException 등)를 그대로 호출하므로
 *   direct == HTTP 가 구성상 보장된다(별도 재구현 없음).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import {
  findActiveLineOpeningException,
  listActiveExceptionWeeks,
  listExceptionWeekFormOptions,
  createLineOpeningWindows,
  setLineOpeningWindowActive,
  deleteLineOpeningWindow,
  listLineOpeningWindows,
} from "@/lib/lineOpeningWindowsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

async function main() {
  // 테스트 대상 주차 1개 + 실무 정보 활동 유형 2개 확보.
  const { data: week } = await sb
    .from("weeks")
    .select("id,start_date")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!week) throw new Error("weeks 행이 없습니다");
  const weekId = (week as { id: string }).id;

  const { data: types } = await sb
    .from("activity_types")
    .select("id,name")
    .eq("cluster_id", "practical_info")
    .eq("is_active", true)
    .limit(2);
  const typeRows = (types ?? []) as Array<{ id: string; name: string }>;
  if (typeRows.length < 2)
    throw new Error("practical_info 활동 유형이 2개 이상 필요합니다");
  const [typeA, typeB] = typeRows;

  console.log(`테스트 주차: ${weekId}`);
  console.log(`활동유형 A: ${typeA.name} / B: ${typeB.name}\n`);

  // 정리: 기존 테스트 잔여 행 제거(같은 주차).
  await sb.from("line_opening_windows").delete().eq("week_id", weekId);

  // ── [1] 초기 상태 = 예외 없음 → false ──
  console.log("[1] 초기(예외 없음)");
  check(
    "typeA 예외 없음 → false",
    (await findActiveLineOpeningException(weekId, typeA.id)) === false,
  );

  // ── [5] 주차 전체 예외 → 모든 유형 true ──
  console.log("[5] 주차 전체 예외");
  const allRows = await createLineOpeningWindows({
    weekId,
    activityTypeIds: null,
    createdBy: null,
  });
  check("전체 예외 1행 생성", allRows.length === 1 && allRows[0].activityTypeId === null);
  check(
    "typeA → true",
    (await findActiveLineOpeningException(weekId, typeA.id)) === true,
  );
  check(
    "typeB → true (전체 허용)",
    (await findActiveLineOpeningException(weekId, typeB.id)) === true,
  );

  // ── [7] 비활성화 → 즉시 차단 ──
  console.log("[7] 비활성화 후 차단");
  await setLineOpeningWindowActive(allRows[0].id, false);
  check(
    "비활성 후 typeA → false",
    (await findActiveLineOpeningException(weekId, typeA.id)) === false,
  );
  // 재활성(멱등 createLineOpeningWindows 가 같은 행 되살림)
  const reAll = await createLineOpeningWindows({
    weekId,
    activityTypeIds: null,
    createdBy: null,
  });
  check("재활성 동일 행(중복 생성 없음)", reAll[0].id === allRows[0].id);
  check(
    "재활성 후 typeA → true",
    (await findActiveLineOpeningException(weekId, typeA.id)) === true,
  );

  // 전체 예외 제거 후 라인 스코프 테스트.
  await sb.from("line_opening_windows").delete().eq("week_id", weekId);

  // ── [6] 특정 라인만 예외 → 해당 유형만 true ──
  console.log("[6] 특정 라인만 예외");
  const lineRows = await createLineOpeningWindows({
    weekId,
    activityTypeIds: [typeA.id],
    createdBy: null,
  });
  check("라인 스코프 1행 생성", lineRows.length === 1 && lineRows[0].activityTypeId === typeA.id);
  check(
    "typeA(허용) → true",
    (await findActiveLineOpeningException(weekId, typeA.id)) === true,
  );
  check(
    "typeB(미허용) → false",
    (await findActiveLineOpeningException(weekId, typeB.id)) === false,
  );

  // ── 목록/연동 조회 sanity ──
  console.log("[목록/연동]");
  const windows = await listLineOpeningWindows();
  check(
    "listLineOpeningWindows 에 테스트 주차 포함",
    windows.some((w) => w.weekId === weekId),
  );
  const activeWeeks = await listActiveExceptionWeeks();
  const aw = activeWeeks.find((w) => w.id === weekId);
  check("listActiveExceptionWeeks 에 주차 포함", !!aw);
  check(
    "allowedActivityTypeIds = [typeA] (라인 스코프)",
    !!aw && aw.allowedActivityTypeIds?.length === 1 && aw.allowedActivityTypeIds[0] === typeA.id,
  );
  const todayIso = new Date().toISOString().slice(0, 10);
  const formWeeks = await listExceptionWeekFormOptions(todayIso);
  check("listExceptionWeekFormOptions 반환(>=1)", formWeeks.length >= 1);

  // ── [7-삭제] 삭제 후 즉시 차단 ──
  console.log("[7] 삭제 후 차단");
  await deleteLineOpeningWindow(lineRows[0].id);
  check(
    "삭제 후 typeA → false",
    (await findActiveLineOpeningException(weekId, typeA.id)) === false,
  );

  // 최종 정리.
  await sb.from("line_opening_windows").delete().eq("week_id", weekId);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
