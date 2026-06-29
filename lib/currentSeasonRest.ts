import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

// 라인 개설 대상자 풀(후보 목록) 시즌 휴식 제외 — 공용 SoT.
//
// 정책(2026-06-26 확정): 라인 개설/수정 대상자 선택 화면은 "현재 시즌(또는 지정 주차의 season_key)"
//   기준으로 시즌 전체 휴식자(user_season_statuses(season_key, status='rest'))를 후보에서 제외한다.
//   ⚠ whole-person user_profiles.growth_status 는 사용하지 않는다(과거 시즌 휴식 플래그가 영구 잔존해
//     시즌 오인). 과거 시즌 소급·기존 라인 참여 기록 무수정 — 오직 후보 목록 조회만 좁힌다.
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
