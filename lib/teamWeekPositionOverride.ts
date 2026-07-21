import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { PositionCode } from "@/lib/positionHistory";

// ── 주차별 (user × week × org × team) 파트/클래스 관리자 오버라이드 — effective coalesce SoT ──
//   원본 = user_position_histories(UPH, 이관·read 전용). 관리자 편집값 = cluster4_team_week_position_overrides.
//   effective = override ?? UPH. 한 유저가 같은 주차에 복수 팀 이력 가능 → key = userId::org::rawTeam.
//   ⚠ [A] 요약 · [B] 편집표 · 주차별 파트 운용 상태표가 **모두 이 loader 를 공유**해야 관리자 화면 진실이 하나다.
//   ⚠ 마이그레이션(cluster4_team_week_position_overrides) 미적용 환경에서는 테이블 부재(42P01)를 흡수해
//     **UPH-only 로 graceful degrade**(현재 동작 무회귀). 적용 즉시 override 가 자동 반영된다.

export type OverridePosition = {
  rawTeam: string;
  rawPart: string | null;
  positionCode: PositionCode;
};

export function makeAssignmentKey(input: {
  userId: string;
  organization: string;
  rawTeam: string;
}): string {
  return `${input.userId}::${input.organization}::${input.rawTeam}`;
}

// 특정 (organization, weekStartDate) 의 override 를 key(userId::org::rawTeam) → 값 Map 으로.
//   테이블 부재 시 빈 Map(=override 없음).
export async function loadWeekPositionOverrides(
  organization: string,
  weekStartDate: string,
): Promise<Map<string, OverridePosition>> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_week_position_overrides")
    .select("user_id,raw_team,raw_part,position_code")
    .eq("organization", organization)
    .eq("week_start_date", weekStartDate);
  const out = new Map<string, OverridePosition>();
  if (error) {
    // 마이그레이션 미적용 = 테이블 부재 → UPH-only degrade. Postgres(42P01)·PostgREST(PGRST205/schema cache)
    //   양쪽 신호를 흡수한다. 그 외 오류는 전파.
    const e = error as { code?: string; message?: string };
    const missing =
      e.code === "42P01" ||
      e.code === "PGRST205" ||
      /schema cache|could not find the table|does not exist/i.test(e.message ?? "");
    if (missing) return out;
    throw new Error(e.message);
  }
  for (const r of (data ?? []) as Array<{
    user_id: string;
    raw_team: string;
    raw_part: string | null;
    position_code: string;
  }>) {
    out.set(
      makeAssignmentKey({ userId: r.user_id, organization, rawTeam: r.raw_team }),
      { rawTeam: r.raw_team, rawPart: r.raw_part, positionCode: r.position_code as PositionCode },
    );
  }
  return out;
}
