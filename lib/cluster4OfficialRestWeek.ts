// 공식 휴식 주차 판정(서버 가드 단일 SoT) — UI weeks-options.canOpen 과 동일 로직.
// ─────────────────────────────────────────────────────────────────────
// 라인 개설 차단 정책: 공식 휴식 주차에는 실무 경험 라인을 개설할 수 없다(operating/test 무관).
// UI(app/api/.../weeks-options)는 canOpen = !isOfficialRest 로 드롭다운을 비활성화하지만
// 서버 write 경로엔 가드가 없었다 → 직접 API POST 우회 가능. 이 모듈이 그 갭을 막는다.
//
// ⚠ UI 와 판정이 갈라지지 않도록 동일 함수를 재사용한다:
//     isOfficialRest = describeWeekByStartMs(startMs).isOfficialRest          (seasonCalendar rule)
//                    ∨ matchOfficialRestPeriods(weekStart..weekEnd, active)   (날짜형 휴식: 설/추석/임시)
//   weeks.is_official_rest(legacy) 컬럼은 UI 와 동일하게 참조하지 않는다.
// read-only 판정 — DB write/snapshot 무관.
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { describeWeekByStartMs } from "@/lib/cluster4WeekPolicy";
import { fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
import { matchOfficialRestPeriods } from "@/lib/officialRestPeriodsTypes";

// "YYYY-MM-DD" → 주차 시작 ms(UTC 자정). cluster4WeekPolicy 내부 기준과 동일.
function startDateToMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

// weekId 가 공식 휴식 주차인지(UI canOpen 과 동일 판정). found=false 면 weeks 행 없음.
export async function isWeekOfficialRestById(
  weekId: string,
): Promise<{ rest: boolean; found: boolean }> {
  const id = (weekId ?? "").trim();
  if (!id) return { rest: false, found: false };
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("start_date,end_date")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[officialRestWeek] weeks lookup failed", { weekId: id, error: error.message });
    return { rest: false, found: false };
  }
  const row = data as { start_date: string; end_date: string } | null;
  if (!row) return { rest: false, found: false };

  const info = describeWeekByStartMs(startDateToMs(row.start_date));
  const weekStart = info?.weekStart ?? row.start_date;
  const weekEnd = info?.weekEnd ?? row.end_date;
  const ruleRest = info?.isOfficialRest ?? false; // seasonCalendar rule
  const dateRest =
    matchOfficialRestPeriods(
      { startDate: weekStart, endDate: weekEnd },
      await fetchActiveRestPeriods(),
    ).length > 0; // 날짜형 공식 휴식
  return { rest: ruleRest || dateRest, found: true };
}

// 라인 개설/저장 write 직전 가드 — 공식 휴식 주차면 422 throw(write 중단).
//   operating/test 무관(주차 정책은 모드와 독립). weeks 행 미존재(found=false)는 통과
//   (호출부의 기존 주차 404 처리에 위임 — 휴식 판정과 별개 사유).
export async function assertWeekOpenable(weekId: string): Promise<void> {
  const { rest } = await isWeekOfficialRestById(weekId);
  if (rest) {
    throw Object.assign(
      new Error("공식 휴식 주차에는 라인을 개설할 수 없습니다."),
      { status: 422 },
    );
  }
}
