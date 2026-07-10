// 운영 식별자 크루 코드(crew_code) 조회 — user_profiles.crew_code (마이그레이션 2026-06-17).
//
// 공식: (년생2)(성별1)(이름순3)-(클럽1)(YY2 시즌1 WW2)(성적1) 예) 036003-1254053. SoT=lib/crewCode.ts.
// best-effort: 컬럼이 아직 없으면(마이그레이션 미적용) 빈 Map 을 돌려준다 → 호출부는 crewCode=null.
// 기존 select 에 crew_code 를 직접 넣지 않고 별도 조회로 분리해, 컬럼 미존재 시에도 기존 검색/매칭이
// 깨지지 않게 한다. 내부 저장/조회 SoT 는 그대로 user_id(UUID) — crew_code 는 표시 식별자.
//   crew_no(4자리 일련번호)와는 별개 컬럼 — 서로 대체하지 않는다([[project_english-name-column]] 유사 패턴).

import { supabaseAdmin } from "@/lib/supabaseAdmin";

function isMissingColumn(error: { code?: string; message?: string }): boolean {
  const msg = error.message ?? "";
  return (
    error.code === "42703" || // undefined_column
    error.code === "PGRST204" ||
    /crew_code/i.test(msg)
  );
}

// userId → crew_code 맵. 미적용/오류 시 빈 맵(graceful). PostgREST .in() 1000행 cap 대비 청크 순회.
//   crew_code 가 NULL 인(미생성) 행은 맵에 넣지 않는다 → 호출부는 crewCode=null 로 "-" 표시.
export async function fetchCrewCodeMap(
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return map;

  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,crew_code")
      .in("user_id", slice);
    if (error) {
      if (isMissingColumn(error)) return new Map(); // 컬럼 미존재 → 전체 graceful 비움
      console.warn("[crew_code] lookup failed:", error.message);
      return map;
    }
    for (const row of (data ?? []) as Array<{
      user_id: string;
      crew_code: string | null;
    }>) {
      const code = row.crew_code?.trim();
      if (code) map.set(row.user_id, code);
    }
  }
  return map;
}
