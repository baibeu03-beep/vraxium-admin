import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { excludeSuperAdmins } from "@/lib/superAdmins";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";
import { loadEvaluationEligibility } from "@/lib/evaluationEligibility";
import { resolveCurrentWeekStartDate } from "@/lib/teamWeekPositionOverride";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  profile_photo_url: string | null;
  organization_slug: string | null;
};

// 실무 정보 라인 개설 대상 크루 체크리스트(PracticalInfoManager) 전용 소비처.
//   실무 경험·역량·커리어의 개설 대상 선택(listCrewsForTargetSelection)과 같은 성격의 화면이라
//   집합②(실무 평가 가능 = 팀·파트 활동 가능 − 엘리트(졸업) − 바사노스)로 동일하게 좁힌다.
//   이 화면은 weekId 를 받지 않는 메타 조회라 기준 시점은 "현재 주차" 고정(형제 화면의 미지정 기본값과 동일).
export async function listCluster4Users(options?: {
  organization?: string | null;
  mode?: ScopeMode;
}) {
  let query = supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,profile_photo_url,organization_slug")
    .order("display_name", { ascending: true });

  query = excludeSuperAdmins(query);

  if (options?.organization) {
    query = query.eq("organization_slug", options.organization);
  }

  const { data, error } = await query;
  if (error) throw error;

  const scope = await resolveUserScope(options?.mode ?? "operating", null);
  let rows = scope.filter((data ?? []) as UserProfileRow[], (row) => row.user_id);

  const currentWeekStart = await resolveCurrentWeekStartDate(getCurrentActivityDateIso());
  if (currentWeekStart && rows.length > 0) {
    const eligibility = await loadEvaluationEligibility({
      userIds: rows.map((r) => r.user_id),
      weekStartDate: currentWeekStart,
    });
    rows = rows.filter((r) => eligibility.isEvaluable(r.user_id));
  }

  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name ?? null,
    profileImg: row.profile_photo_url,
    organization: row.organization_slug,
  }));
}
