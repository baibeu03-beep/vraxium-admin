/**
 * 검수 완료 상태지만 활성 결과 snapshot이 없는 과거 주차를 기존 publish command로 복구한다.
 *
 * 기본은 dry-run이며 `--apply`에서만 쓰기 작업을 수행한다.
 * 미래 주차(start_date > currentActivityDate)는 항상 감사 목록으로만 남기고 자동 처리하지 않는다.
 */
import { publishCrewWeekResult, fromFinalizeRunScope } from "@/lib/crewWeekPublish";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { isOrganizationSlug } from "@/lib/organizations";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type StateRow = {
  week_id: string;
  organization_slug: string;
  scope: string;
  status: string;
};

type RunRow = {
  week_id: string;
  organization_slug: string | null;
  scope: string | null;
  snapshot_captured: boolean | null;
};

type WeekRow = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  end_date: string | null;
};

const apply = process.argv.includes("--apply");
const actorEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const key = (weekId: string, org: string | null, scope: string) =>
  `${weekId}|${org}|${scope}`;

async function findActorId(): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: actorEmail,
  });
  if (error || !data.user?.id) {
    throw new Error(
      `backfill 실행 관리자 계정을 찾을 수 없습니다: ${error?.message ?? actorEmail}`,
    );
  }
  return data.user.id;
}

async function main() {
  const activityDate = getCurrentActivityDateIso();
  const { data: states, error: stateError } = await supabaseAdmin
    .from("cluster4_week_org_result_states")
    .select("week_id,organization_slug,scope,status")
    .eq("status", "published");
  if (stateError) throw new Error(`검수 상태 조회 실패: ${stateError.message}`);

  const published = (states ?? []) as StateRow[];
  const weekIds = [...new Set(published.map((row) => row.week_id))];
  const [{ data: runs, error: runError }, { data: weeks, error: weekError }] =
    await Promise.all([
      supabaseAdmin
        .from("cluster4_week_finalize_runs")
        .select("week_id,organization_slug,scope,snapshot_captured")
        .in("week_id", weekIds)
        .is("reverted_at", null),
      supabaseAdmin
        .from("weeks")
        .select("id,season_key,week_number,start_date,end_date")
        .in("id", weekIds),
    ]);
  if (runError) throw new Error(`활성 공표 조회 실패: ${runError.message}`);
  if (weekError) throw new Error(`주차 조회 실패: ${weekError.message}`);

  const activeSnapshotKeys = new Set(
    ((runs ?? []) as RunRow[])
      .filter((run) => run.snapshot_captured === true)
      .map((run) =>
        key(run.week_id, run.organization_slug, fromFinalizeRunScope(run.scope)),
      ),
  );
  const weekById = new Map(((weeks ?? []) as WeekRow[]).map((week) => [week.id, week]));

  const missing = published
    .filter(
      (state) =>
        !activeSnapshotKeys.has(
          key(state.week_id, state.organization_slug, state.scope),
        ),
    )
    .map((state) => ({ state, week: weekById.get(state.week_id) ?? null }));

  const future = missing.filter(
    ({ week }) => week?.start_date != null && week.start_date > activityDate,
  );
  const eligible = missing.filter(
    ({ state, week }) =>
      week?.start_date != null &&
      week.start_date <= activityDate &&
      week.end_date != null &&
      week.end_date < activityDate &&
      isOrganizationSlug(state.organization_slug) &&
      (state.scope === "operating" || state.scope === "test"),
  );

  console.log(
    `activityDate=${activityDate} · snapshot 없음=${missing.length} · backfill 대상=${eligible.length} · 미래 감사=${future.length}`,
  );
  for (const { state, week } of future) {
    console.log(
      `[미래 제외] ${week?.season_key} W${week?.week_number} ${state.organization_slug}/${state.scope} start=${week?.start_date}`,
    );
  }
  for (const { state, week } of eligible) {
    console.log(
      `[${apply ? "APPLY" : "DRY"}] ${week?.season_key} W${week?.week_number} ${state.organization_slug}/${state.scope}`,
    );
  }

  if (!apply) {
    console.log("쓰기 없음. 적용하려면 --apply를 지정하세요.");
    return;
  }

  const actorId = await findActorId();
  let completed = 0;
  for (const { state } of eligible) {
    if (!isOrganizationSlug(state.organization_slug)) continue;
    await publishCrewWeekResult({
      organization: state.organization_slug,
      weekId: state.week_id,
      scope: state.scope === "test" ? "test" : "operating",
      actorId,
    });
    completed++;
    console.log(
      `[완료 ${completed}/${eligible.length}] ${state.week_id} ${state.organization_slug}/${state.scope}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
