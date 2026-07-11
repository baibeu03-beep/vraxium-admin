// 운영용 크루 번호(crew_no) 조회 — user_profiles.crew_no (마이그레이션 2026-06-09).
//
// best-effort: 컬럼이 아직 없으면(마이그레이션 미적용) 빈 Map 을 돌려준다 → 호출부는 crewNo=null.
// 기존 select 에 crew_no 를 직접 넣지 않고 별도 조회로 분리해, 컬럼 미존재 시에도 기존 기능이
// 깨지지 않게 한다. SoT 는 user_id(UUID) — crew_no 는 표시/검색 보조 키.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { IN_FILTER_ID_CHUNK } from "@/lib/supabaseInChunk";

function isMissingColumn(error: { code?: string; message?: string }): boolean {
  const msg = error.message ?? "";
  return (
    error.code === "42703" || // undefined_column
    error.code === "PGRST204" ||
    /crew_no/i.test(msg)
  );
}

// userId → crew_no 맵. 미적용/오류 시 빈 맵(graceful).
//   청크: 요청 URL 길이 상한(IN_FILTER_ID_CHUNK) — 500개 .in() 은 URL ~18KB 로 fetch 실패/30s 지연.
export async function fetchCrewNoMap(
  userIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return map;

  const CHUNK = IN_FILTER_ID_CHUNK;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,crew_no")
      .in("user_id", slice);
    if (error) {
      if (isMissingColumn(error)) return new Map(); // 컬럼 미존재 → 전체 graceful 비움
      console.warn("[crew_no] lookup failed:", error.message);
      return map;
    }
    for (const row of (data ?? []) as Array<{
      user_id: string;
      crew_no: number | null;
    }>) {
      if (row.crew_no != null) map.set(row.user_id, row.crew_no);
    }
  }
  return map;
}
