// 운영 기준 시즌(operationalSeasonDbKey)의 "현재 시즌 참여자" 단일 SoT (server-only).
//
// 현재 시즌 참여자 = user_season_statuses 에 해당 season_key 행을 가진 사용자.
//   status 가 active/rest/stopped 인 행 모두 "참여자"로 본다(휴식·중단도 현재 운영 대상자).
//
// "현재 운영 대상자 목록/관리/결과/집계" 성격의 어드민 화면은 이 모집단을 기준으로 한다 —
// 과거 시즌 전용 인원/현재 시즌 비대상자가 섞이지 않도록 한 곳에서 모집단을 한정한다.
//   · /admin/members 크루 목록(lib/adminMembersData.listMembersRoster)
//   · /admin/week-recognitions 주차 인정 결과(lib/adminWeekRecognitionsData.getWeekRecognitions)
// 두 화면이 종전엔 동일 로직을 각자 복제했는데(drift 위험), 이제 이 헬퍼를 공유한다.
//
// 조회 방식: season_key 단건 .eq + range 페이지네이션(PostgREST 1000행 cap 우회).
//   대량 .in("user_id", …) 을 쓰지 않으므로 GET URL 길이 폭주가 없다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso, operationalSeasonDbKey } from "@/lib/seasonCalendar";

export type SeasonParticipantCounts = {
  total: number; // user_season_statuses 행 수(시즌 참여 행)
  active: number;
  rest: number;
  stopped: number;
};

export type OperationalSeasonParticipants = {
  // 해소된 운영 기준 season_key. off-season 등 미해소 시 null → 호출부는 전수 폴백 판단에 사용.
  seasonKey: string | null;
  // 참여자 user_id 배열(중복 제거, user_id 오름차순). seasonKey=null 이면 [].
  ids: string[];
  // ids 와 동일 집합의 Set(멤버십 판정용). seasonKey=null 이면 빈 Set.
  idSet: Set<string>;
  // active/rest/stopped 카운트(요약 표기용). 단일 스캔으로 ids 와 함께 산출.
  counts: SeasonParticipantCounts;
  // user_id → 시즌 상태(active/rest/stopped/그 외). scope 적용 카운트 재집계용(roster).
  //   counts 는 전체(un-scoped)라, 모드/조직 scope 가 적용된 부분집합의 카운트가 필요할 때 사용.
  statusByUser: Map<string, string>;
};

// 주어진 season_key 의 시즌 참여자 id 집합 + active/rest/stopped 카운트를 단일 패스로 산출.
//   seasonKey=null 이면 빈 결과(participants 0). user_season_statuses 를 두 번 스캔하지 않는다.
export async function fetchSeasonParticipants(
  seasonKey: string | null,
): Promise<OperationalSeasonParticipants> {
  const ids: string[] = [];
  const idSet = new Set<string>();
  const statusByUser = new Map<string, string>();
  const counts: SeasonParticipantCounts = {
    total: 0,
    active: 0,
    rest: 0,
    stopped: 0,
  };
  if (!seasonKey) return { seasonKey: null, ids, idSet, counts, statusByUser };

  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_season_statuses")
      .select("user_id,status")
      .eq("season_key", seasonKey)
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ user_id: string; status: string }>;
    for (const r of rows) {
      if (!idSet.has(r.user_id)) {
        idSet.add(r.user_id);
        ids.push(r.user_id);
        statusByUser.set(r.user_id, r.status);
      }
      counts.total += 1;
      if (r.status === "active") counts.active += 1;
      else if (r.status === "rest") counts.rest += 1;
      else if (r.status === "stopped") counts.stopped += 1;
    }
    if (rows.length < 1000) break;
  }
  return { seasonKey, ids, idSet, counts, statusByUser };
}

// 운영 기준 시즌(operationalSeasonDbKey(today))의 참여자. today 미지정 시 오늘(UTC) 기준.
export async function fetchOperationalSeasonParticipants(
  today: string = getCurrentActivityDateIso(),
): Promise<OperationalSeasonParticipants> {
  return fetchSeasonParticipants(operationalSeasonDbKey(today));
}
