import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

// 시즌 휴식 = 그 시즌의 활동·평가 모집단 제외 — **단일 권위 원천**(server-only).
//
// 규칙은 하나뿐이다:
//   시즌 휴식(seasonKey, userId) ⟺ user_season_statuses(season_key=seasonKey, user_id).status === 'rest'
//
// 정책(2026-07-27 확정): 시즌 휴식자는 그 시즌 동안 **팀·파트가 배정되지 않은 상태**로 본다.
//   따라서 아래 모두에서 동일하게 빠진다 — 화면마다 다른 조건을 덧붙이지 않는다.
//     · /admin/members 클러빙_축소 (= 클러빙_확대 − 바사노스 − 시즌 휴식)
//     · /admin/team-parts/info/* 팀 소속 크루 · 파트 소속 크루 · <운용> 파트 판정
//     · 실무 경험/정보/역량 라인 개설 후보·평가 대상 모집단
//
// ⚠ 기준 시점은 **조회 중인 주차가 속한 시즌**이다. 현재 시즌 휴식을 과거 주차에 소급하지 않는다
//   (과거 시즌에 활동했으면 그 주차 화면에서는 소속·기록이 그대로 유지된다).
// ⚠ whole-person user_profiles.growth_status 는 사용하지 않는다(과거 시즌 휴식 플래그가 영구 잔존해
//   시즌 오인). 과거 시즌 소급·기존 라인 참여 기록 무수정 — 오직 모집단 조회만 좁힌다.
//   부하 방지: range pagination(1000)로 분할 조회(전체 회원 풀스캔/대량 .in 미사용).

// 오늘(또는 주어진 날짜)이 속한 주차의 season_key. 시즌 갭/전환이면 null.
export async function resolveCurrentSeasonKey(dateIso?: string): Promise<string | null> {
  const today = dateIso ?? getCurrentActivityDateIso();
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("season_key")
    .lte("start_date", today)
    .gte("end_date", today)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { season_key?: string } | null)?.season_key ?? null;
}

// 지정 시즌의 시즌 전체 휴식자 user_id 집합. season_key=null 이면 빈 집합(제외 없음 — 보수적).
export async function getSeasonRestUserIds(seasonKey: string | null): Promise<Set<string>> {
  const out = new Set<string>();
  if (!seasonKey) return out;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_season_statuses")
      .select("user_id")
      .eq("season_key", seasonKey)
      .eq("status", "rest")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ user_id: string }>;
    for (const r of rows) out.add(r.user_id);
    if (rows.length < 1000) break;
  }
  return out;
}

// 현재 시즌(오늘) 기준 시즌 전체 휴식자 user_id 집합 — 라인 개설 후보 풀 제외용.
export async function getCurrentSeasonRestUserIds(dateIso?: string): Promise<Set<string>> {
  return getSeasonRestUserIds(await resolveCurrentSeasonKey(dateIso));
}

// 특정 주차(week_start_date)가 속한 season_key. 주차 행이 없으면 null(제외 없음 — 보수적).
//   주차 로스터가 "그 주차의 시즌" 기준으로 휴식을 판정할 때 쓰는 단일 해소 경로.
export async function resolveSeasonKeyForWeekStart(
  weekStartDate: string | null | undefined,
): Promise<string | null> {
  if (!weekStartDate) return null;
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("season_key")
    .eq("start_date", weekStartDate)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { season_key?: string } | null)?.season_key ?? null;
}

// 이미 로드한 user_season_statuses 행들에서 "그 시즌 휴식인가" 를 판정하는 **동일 규칙의 단건 술어**.
//   bulk 집합(getSeasonRestUserIds)과 한 글자도 다르지 않은 조건을 쓴다 — 성장상태 계산
//   (lib/growthCore.computeAutoGrowthStatus 의 seasonRestActive)과 모집단 제외가 갈리지 않게 하는 지점.
//   ⚠ 새 화면이 `rows.some(r => r.status === 'rest' && ...)` 를 다시 손으로 쓰지 말 것.
export function isSeasonRestActiveIn(
  seasonRows: ReadonlyArray<{ season_key?: string | null; status?: string | null }>,
  seasonKey: string | null,
): boolean {
  if (!seasonKey) return false;
  return seasonRows.some((r) => r.status === "rest" && r.season_key === seasonKey);
}

// 시즌 중단(stopped) — 휴식과 같은 season-scoped 규칙(성장상태 계산에서 휴식보다 우선).
export function isSeasonStoppedActiveIn(
  seasonRows: ReadonlyArray<{ season_key?: string | null; status?: string | null }>,
  seasonKey: string | null,
): boolean {
  if (!seasonKey) return false;
  return seasonRows.some((r) => r.status === "stopped" && r.season_key === seasonKey);
}
