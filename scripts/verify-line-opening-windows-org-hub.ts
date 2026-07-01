/**
 * verify-line-opening-windows-org-hub.ts
 * 라인 개설 예외 org+hub 스코핑 직접 검증(read/write — 테스트 행 정리됨).
 *
 * 실행(마이그 2026-07-01_line_opening_windows_org_hub.sql 적용 후):
 *   npx tsx --env-file=.env.local scripts/verify-line-opening-windows-org-hub.ts
 *
 * 검증(요청 스펙 1~5):
 *   1) 조직 범위 — encre 예외는 encre 에만, oranke/phalanx 미적용.
 *   2) 라인 종류 — experience 예외는 experience 에만, info/competency 미적용.
 *   3) 조합(encre+experience) → 그 org·hub 에서만 적용.
 *   4) 전체(all/all) → 모든 org·hub 적용.
 *   5) 삭제/비활성 → 즉시 해제.
 *   + assertWeekOpenable(휴식 주차) org+hub 스코프 게이트.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import {
  hasActiveAllLineException,
  getActiveAllLineExceptionWeekIds,
  findActiveLineOpeningException,
  createLineOpeningWindows,
  setLineOpeningWindowActive,
  deleteLineOpeningWindow,
  listLineOpeningWindows,
} from "@/lib/lineOpeningWindowsData";
import { assertWeekOpenable, isWeekOfficialRestById } from "@/lib/cluster4OfficialRestWeek";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`); }
}
const has = (s: Set<string>, id: string) => s.has(id);

async function main() {
  // 테스트 주차 — 휴식 주차(있으면 assertWeekOpenable throw 경로도 검증), 없으면 최신 주차.
  const { data: restWeek } = await sb
    .from("weeks").select("id,start_date").eq("is_official_rest", true)
    .order("start_date", { ascending: false }).limit(1).maybeSingle();
  const { data: anyWeek } = await sb
    .from("weeks").select("id,start_date").order("start_date", { ascending: false }).limit(1).maybeSingle();
  const week = (restWeek ?? anyWeek) as { id: string } | null;
  if (!week) throw new Error("weeks 행이 없습니다");
  const weekId = week.id;
  const restJudged = (await isWeekOfficialRestById(weekId)).rest;
  console.log(`테스트 주차: ${weekId} (공식 휴식=${restJudged})\n`);

  await sb.from("line_opening_windows").delete().eq("week_id", weekId);

  // ── [1·2·3] encre + experience 예외 ──
  console.log("[1·2·3] encre + experience 조합 예외");
  const w1 = await createLineOpeningWindows({
    weekId, activityTypeIds: null, organizationSlug: "encre", hub: "experience", createdBy: null,
  });
  const winId = w1[0].id;
  check("생성행 org=encre·hub=experience", w1[0].organizationSlug === "encre" && w1[0].hub === "experience");
  // 매칭 org+hub 만 true
  check("has(encre, experience)=true", (await hasActiveAllLineException(weekId, "encre", "experience")) === true);
  check("has(oranke, experience)=false (다른 org)", (await hasActiveAllLineException(weekId, "oranke", "experience")) === false);
  check("has(encre, competency)=false (다른 hub)", (await hasActiveAllLineException(weekId, "encre", "competency")) === false);
  check("has(encre, info)=false (다른 hub)", (await hasActiveAllLineException(weekId, "encre", "info")) === false);
  check("has(null, null)=false (전체 질의엔 org 스코프 예외 미포함)", (await hasActiveAllLineException(weekId, null, null)) === false);
  // 집합 API 동일 스코핑
  check("set(encre, experience) 포함", has(await getActiveAllLineExceptionWeekIds("encre", "experience"), weekId));
  check("set(oranke, experience) 미포함", !has(await getActiveAllLineExceptionWeekIds("oranke", "experience"), weekId));
  check("set(encre, info) 미포함", !has(await getActiveAllLineExceptionWeekIds("encre", "info"), weekId));
  // info-lines 게이트(findActive) 도 org+hub 스코프
  check("findActive(encre, experience, 임의유형)=true", (await findActiveLineOpeningException(weekId, "wisdom", "encre", "experience")) === true);
  check("findActive(oranke, experience)=false", (await findActiveLineOpeningException(weekId, "wisdom", "oranke", "experience")) === false);

  // ── assertWeekOpenable(휴식 주차) org+hub 스코프 ──
  if (restJudged) {
    console.log("[게이트] assertWeekOpenable(휴식) org+hub");
    let threwMatch = false, threwOther = false;
    try { await assertWeekOpenable(weekId, "encre", "experience"); } catch { threwMatch = true; }
    try { await assertWeekOpenable(weekId, "oranke", "experience"); } catch { threwOther = true; }
    check("encre+experience 예외로 통과(throw 없음)", threwMatch === false);
    check("oranke+experience 은 예외 밖 → 422 throw", threwOther === true);
  } else {
    console.log("[게이트] (테스트 주차가 휴식 아님 → assertWeekOpenable throw 경로 생략)");
  }

  // ── [5] 비활성 → 즉시 해제 ──
  console.log("[5] 비활성/삭제 후 즉시 해제");
  await setLineOpeningWindowActive(winId, false);
  check("비활성 후 has(encre, experience)=false", (await hasActiveAllLineException(weekId, "encre", "experience")) === false);
  // 재활성(멱등 — 같은 org+hub 조합 되살림)
  const re = await createLineOpeningWindows({
    weekId, activityTypeIds: null, organizationSlug: "encre", hub: "experience", createdBy: null,
  });
  check("재활성 = 동일 행(중복 없음)", re[0].id === winId);
  await deleteLineOpeningWindow(winId);
  check("삭제 후 has(encre, experience)=false", (await hasActiveAllLineException(weekId, "encre", "experience")) === false);

  // ── [4] 전체(all/all) → 모든 org·hub 적용 ──
  console.log("[4] 전체(all/all) 예외");
  const wAll = await createLineOpeningWindows({
    weekId, activityTypeIds: null, organizationSlug: null, hub: null, createdBy: null,
  });
  check("has(encre, info)=true (전체)", (await hasActiveAllLineException(weekId, "encre", "info")) === true);
  check("has(oranke, competency)=true (전체)", (await hasActiveAllLineException(weekId, "phalanx", "competency")) === true);
  check("has(null, null)=true (전체)", (await hasActiveAllLineException(weekId, null, null)) === true);
  check("set(oranke, experience) 포함 (전체)", has(await getActiveAllLineExceptionWeekIds("oranke", "experience"), weekId));

  // 목록 sanity
  const windows = await listLineOpeningWindows();
  check("listLineOpeningWindows 에 전체 예외 포함(org=null·hub=null)", windows.some((w) => w.id === wAll[0].id && w.organizationSlug === null && w.hub === null));

  // 정리.
  await sb.from("line_opening_windows").delete().eq("week_id", weekId);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
