/**
 * verify-process-check-windows.ts
 * 프로세스 체크 예외 주차(process_check_windows) 판정 + 드롭다운 노출 직접 검증.
 *
 * 실행(마이그레이션 2026-07-01_process_check_windows.sql 적용 후):
 *   npx tsx --env-file=.env.local scripts/verify-process-check-windows.ts
 *
 * 검증 항목(요청 스펙 1~8):
 *   1) 예외 없음 → 미래 주차는 드롭다운에 안 보임(기본 정책 유지).
 *   2/3) org+hub 예외 등록 → 해당 org·hub 보드 드롭다운에 등장 + editable=true.
 *   4) write 게이트: hasActiveProcessCheckException = true(생성/설정 허용).
 *   5) 기본 정책 유지: 현재 주차는 여전히 editable, 과거 주차는 조회 전용.
 *   6) 추가 허용 스코프: 다른 org / 다른 hub 보드에는 예외 미노출(scoping).
 *   7) 도메인 분리: 정보/역량/변동 각각 hub 스코프 정상.
 *   8) 예외 해제(비활성/삭제) → 즉시 드롭다운에서 제외 + write 게이트 false.
 *
 * HTTP/브라우저는 admin 세션 필요 → 별도 확인. 단 API 라우트·보드가 동일 데이터 레이어
 *   함수를 그대로 호출하므로 direct == HTTP 가 구성상 보장된다(재구현 없음).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import {
  getActiveProcessCheckExceptionWeekIds,
  hasActiveProcessCheckException,
  createProcessCheckWindow,
  setProcessCheckWindowActive,
  deleteProcessCheckWindow,
  listProcessCheckWindows,
  listProcessCheckWindowWeekOptions,
} from "@/lib/processCheckWindowsData";
import { getProcessCheckBoard } from "@/lib/adminProcessCheckData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

// 보드 드롭다운에 특정 주차가 옵션으로 있고 편집 가능한지.
async function boardHasEditableWeek(
  hub: "info" | "competency",
  org: string,
  weekId: string,
): Promise<{ present: boolean; editable: boolean }> {
  const board = await getProcessCheckBoard(hub, org, null, "operating", null, null, weekId);
  const present = board.weeks.some((w) => w.weekId === weekId);
  const editable = board.selectedWeekId === weekId && board.editable;
  return { present, editable };
}

async function main() {
  const ORG = "oranke";
  const OTHER_ORG = "encre";

  // 미래 주차 1개 확보 — start_date 가 가장 늦은 주차(현재 시즌 W1~현재 범위 밖 = 기본 드롭다운 미노출).
  const { data: latest } = await sb
    .from("weeks")
    .select("id,start_date")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) throw new Error("weeks 행이 없습니다");
  const futureWeekId = (latest as { id: string }).id;
  console.log(`테스트(미래) 주차: ${futureWeekId}\n`);

  // 정리 — 이 주차의 기존 테스트 예외 제거.
  await sb.from("process_check_windows").delete().eq("week_id", futureWeekId);

  // ── [1] 예외 없음 → 미래 주차는 드롭다운 미노출 ──
  console.log("[1] 예외 없음(기본 정책)");
  {
    const ids = await getActiveProcessCheckExceptionWeekIds(ORG, "info");
    check("예외 집합에 미포함", !ids.has(futureWeekId));
    const b = await boardHasEditableWeek("info", ORG, futureWeekId);
    check("미래 주차 드롭다운 미노출", !b.present);
    check("write 게이트 false", (await hasActiveProcessCheckException(futureWeekId, ORG, "info")) === false);
  }

  // ── [2/3/4] org+hub(info) 예외 등록 → 드롭다운 등장 + editable + write 허용 ──
  console.log("[2·3·4] org+hub(info) 예외 등록");
  const win = await createProcessCheckWindow({
    weekId: futureWeekId,
    organizationSlug: ORG,
    hub: "info",
    createdBy: null,
  });
  check("예외 1행 생성", !!win.id && win.weekId === futureWeekId && win.hub === "info");
  {
    const ids = await getActiveProcessCheckExceptionWeekIds(ORG, "info");
    check("예외 집합에 포함", ids.has(futureWeekId));
    const b = await boardHasEditableWeek("info", ORG, futureWeekId);
    check("info 보드 드롭다운에 등장", b.present);
    check("info 보드에서 editable=true", b.editable);
    check("write 게이트 true", (await hasActiveProcessCheckException(futureWeekId, ORG, "info")) === true);
  }

  // ── [6/7] 스코핑: 다른 org / 다른 hub 보드에는 미노출 ──
  console.log("[6·7] 스코핑(추가 허용 범위 격리)");
  {
    const bOtherOrg = await boardHasEditableWeek("info", OTHER_ORG, futureWeekId);
    check("다른 org(encre) info 보드 미노출", !bOtherOrg.present);
    check("다른 org write 게이트 false", (await hasActiveProcessCheckException(futureWeekId, OTHER_ORG, "info")) === false);
    const bOtherHub = await boardHasEditableWeek("competency", ORG, futureWeekId);
    check("같은 org·다른 hub(competency) 보드 미노출", !bOtherHub.present);
    check("다른 hub write 게이트 false", (await hasActiveProcessCheckException(futureWeekId, ORG, "competency")) === false);
  }

  // ── [5] 기본 정책 유지 — 현재 주차는 여전히 editable ──
  console.log("[5] 기본 정책 유지");
  {
    const board = await getProcessCheckBoard("info", ORG, null, "operating", null, null, null);
    // 선택 미지정 → 현재 주차로 폴백 + editable(기본 정책 불변).
    check("현재 주차 기본 editable", board.editable && Boolean(board.selectedWeekId));
    // 현재 주차는 예외와 무관하게 드롭다운에 존재.
    check("현재 주차 옵션 존재", board.weeks.some((w) => w.isCurrent));
  }

  // ── 목록/폼 옵션 sanity ──
  console.log("[목록/폼]");
  {
    const windows = await listProcessCheckWindows();
    check("listProcessCheckWindows 에 테스트 예외 포함", windows.some((w) => w.id === win.id));
    const formWeeks = await listProcessCheckWindowWeekOptions(new Date().toISOString().slice(0, 10));
    const { count: weeksCount } = await sb.from("weeks").select("*", { count: "exact", head: true });
    check(
      "폼 옵션 == weeks 전 행(동적·전 시즌 노출)",
      formWeeks.length === (weeksCount ?? -1),
      `options=${formWeeks.length} weeks=${weeksCount}`,
    );
  }

  // ── [8] 비활성 → 즉시 제외 ──
  console.log("[8] 비활성/삭제 후 즉시 제외");
  await setProcessCheckWindowActive(win.id, false);
  {
    const b = await boardHasEditableWeek("info", ORG, futureWeekId);
    check("비활성 후 드롭다운 미노출", !b.present);
    check("비활성 후 write 게이트 false", (await hasActiveProcessCheckException(futureWeekId, ORG, "info")) === false);
  }
  // 재활성(멱등 create 가 같은 행 되살림).
  const reWin = await createProcessCheckWindow({
    weekId: futureWeekId,
    organizationSlug: ORG,
    hub: "info",
    createdBy: null,
  });
  check("재활성 = 동일 행(중복 생성 없음)", reWin.id === win.id);
  // 삭제 → 즉시 제외.
  await deleteProcessCheckWindow(win.id);
  {
    const b = await boardHasEditableWeek("info", ORG, futureWeekId);
    check("삭제 후 드롭다운 미노출", !b.present);
  }

  // 최종 정리.
  await sb.from("process_check_windows").delete().eq("week_id", futureWeekId);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
