import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSeasonRestUserIds, resolveCurrentSeasonKey } from "@/lib/currentSeasonRest";

// weekId → "그 주차 시즌의 시즌 휴식자 집합" 어댑터 (server-only).
//
// ⚠ 정책은 여기에 없다. 판정 규칙의 단일 권위 원천은 lib/currentSeasonRest 이고
//   (시즌 휴식 ⟺ user_season_statuses(season_key, user_id).status === 'rest'),
//   이 파일은 **weekId(uuid) → season_key 해소**만 담당하는 얇은 어댑터다.
//   currentSeasonRest 는 week_start_date 기준(resolveSeasonKeyForWeekStart)만 제공하는데,
//   라인 개설 후보/카페 매칭 후보 API 는 화면에서 weekId(uuid)를 그대로 들고 오므로 그 간극을 메운다.
//
// 새 화면이 `getCurrentSeasonRestUserIds()` 를 쓰지 말 것 — 그건 조회 주차와 무관하게 **현재 시즌**을
//   고정 적용해, 과거 주차 화면에서 "지금 휴식이면 그때도 휴식"이라는 소급 오류를 만든다.
//   weekId 를 알 수 있으면 반드시 이 함수를 쓰고, 정말 현재 시점만 보는 화면에서만 weekId=null 을 넘긴다.
//
// (정리 예정) lib/currentSeasonRest 가 안정화되면 이 어댑터를 그쪽으로 접을 것.

/** weekId(weeks.id) 가 속한 season_key. 미지정/미존재면 현재 주차 시즌으로 폴백(종전 동작). */
export async function resolveSeasonKeyForWeekId(
  weekId: string | null | undefined,
): Promise<string | null> {
  const id = weekId?.trim();
  if (!id) return resolveCurrentSeasonKey();
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("season_key")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const key = (data as { season_key?: string | null } | null)?.season_key ?? null;
  // 주차 행이 없거나 season_key 가 비면 현재 시즌으로 폴백한다(빈 집합으로 두면 휴식자가 새어 들어온다).
  return key ?? (await resolveCurrentSeasonKey());
}

/** weekId 가 속한 시즌의 시즌 휴식자 집합. weekId 미지정 = 현재 시즌(종전 동작 보존). */
export async function getSeasonRestUserIdsForWeekId(
  weekId: string | null | undefined,
): Promise<Set<string>> {
  return getSeasonRestUserIds(await resolveSeasonKeyForWeekId(weekId));
}

/** weekId(weeks.id) 의 week_start_date. 주차 기준 effective 배정 계산(resolvePositionAtBatch)용. */
export async function resolveWeekStartDateForWeekId(
  weekId: string | null | undefined,
): Promise<string | null> {
  const id = weekId?.trim();
  if (!id) return null;
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("start_date")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const d = (data as { start_date?: string | null } | null)?.start_date ?? null;
  return d ? String(d).slice(0, 10) : null;
}
