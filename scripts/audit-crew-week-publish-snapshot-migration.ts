/**
 * 주차 결과(크루) — **legacy 검수 완료 주차** 마이그레이션 대상 목록(읽기 전용).
 *
 *   대상 = cluster4_week_org_result_states.status = 'published' 인데
 *          활성 finalize run(reverted_at IS NULL) 의 snapshot_captured = true 가 **아닌** (주차 × 조직 × scope).
 *
 *   이 조합은 "검수 완료"이면서 표시할 공표 snapshot 이 없다 → 상세 화면이 결과를 표시할 수 없다.
 *   ⚠ 이 스크립트는 아무것도 쓰지 않는다. 값을 만들어 채우지도 않는다(live 폴백 금지 정책과 동일).
 *      복구 경로는 화면에서 [클럽 활동 검수(예비)] → [클럽 활동 검수(재공표)] 다.
 *
 *   Usage: npm run audit:crew-week-snapshot-migration
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fromFinalizeRunScope } from "@/lib/crewWeekPublish";

type StateRow = {
  week_id: string;
  organization_slug: string;
  scope: string;
  status: string;
  published_at: string | null;
  updated_at: string | null;
};
type RunRow = {
  id: string;
  week_id: string;
  organization_slug: string | null;
  scope: string | null;
  snapshot_captured: boolean | null;
  created_at: string;
};
type WeekRow = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  end_date: string | null;
};

const key = (weekId: string, org: string | null, scope: string) => `${weekId}|${org}|${scope}`;

async function main() {
  const { data: states, error: e1 } = await supabaseAdmin
    .from("cluster4_week_org_result_states")
    .select("week_id,organization_slug,scope,status,published_at,updated_at")
    .eq("status", "published");
  if (e1) throw new Error(`org result states 조회 실패: ${e1.message}`);

  const published = (states ?? []) as StateRow[];
  if (published.length === 0) {
    console.log("검수 완료(published) 조합이 없습니다.");
    return;
  }

  const weekIds = [...new Set(published.map((s) => s.week_id))];
  const [{ data: runs, error: e2 }, { data: weeks, error: e3 }] = await Promise.all([
    supabaseAdmin
      .from("cluster4_week_finalize_runs")
      .select("id,week_id,organization_slug,scope,snapshot_captured,created_at")
      .in("week_id", weekIds)
      .is("reverted_at", null),
    supabaseAdmin
      .from("weeks")
      .select("id,season_key,week_number,start_date,end_date")
      .in("id", weekIds),
  ]);
  if (e2) throw new Error(`finalize runs 조회 실패: ${e2.message}`);
  if (e3) throw new Error(`weeks 조회 실패: ${e3.message}`);

  // run.scope 는 'operating' | 'qa' 어휘다 — 상태 SoT 어휘로 변환해 비교한다(문자열 직접 비교 금지).
  const runByKey = new Map<string, RunRow>();
  for (const r of (runs ?? []) as RunRow[]) {
    runByKey.set(key(r.week_id, r.organization_slug, fromFinalizeRunScope(r.scope)), r);
  }
  const weekById = new Map(((weeks ?? []) as WeekRow[]).map((w) => [w.id, w]));

  const targets = published
    .map((s) => {
      const run = runByKey.get(key(s.week_id, s.organization_slug, s.scope)) ?? null;
      const w = weekById.get(s.week_id) ?? null;
      return {
        state: s,
        run,
        week: w,
        kind: run == null ? ("no_run" as const) : ("run_without_snapshot" as const),
      };
    })
    .filter((t) => t.run?.snapshot_captured !== true)
    .sort((a, b) => {
      const ak = `${a.week?.season_key ?? ""}${String(a.week?.week_number ?? 0).padStart(3, "0")}`;
      const bk = `${b.week?.season_key ?? ""}${String(b.week?.week_number ?? 0).padStart(3, "0")}`;
      return ak.localeCompare(bk) || a.state.organization_slug.localeCompare(b.state.organization_slug);
    });

  console.log(`검수 완료(published) 조합: ${published.length}`);
  console.log(`공표 snapshot 보유: ${published.length - targets.length}`);
  console.log(`── 마이그레이션 대상(공표 snapshot 없음): ${targets.length} ──`);
  for (const t of targets) {
    const w = t.week;
    console.log(
      [
        `${w?.season_key ?? "?"} W${w?.week_number ?? "?"}`,
        `org=${t.state.organization_slug}`,
        `scope=${t.state.scope}`,
        `kind=${t.kind}`,
        `weekId=${t.state.week_id}`,
        `period=${w?.start_date ?? "?"}~${w?.end_date ?? "?"}`,
        `publishedAt=${t.state.published_at ?? "-"}`,
        t.run ? `activeRun=${t.run.id}(snapshot=false)` : "activeRun=none",
      ].join(" · "),
    );
  }
  if (targets.length > 0) {
    console.log(
      "\n복구 경로: /admin/team-parts/info/crew-week-results/{org}/{weekId} 에서" +
        " [클럽 활동 검수(예비)] 실행 → [클럽 활동 검수(재공표)].",
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
