/**
 * 라인 강화 결과 저장 → user_week_statuses 수렴 진단 (READ-ONLY, 무손실).
 *   run: npx tsx --env-file=.env.local scripts/diag-line-save-uws-divergence.ts
 *
 * 목적: "라인/포인트 라이브 상태가 말하는 주차 결과(predictWeekStatusForUser)"와
 *       "저장된 user_week_statuses.status"가 어긋난 (테스트 유저, 주차)를 찾는다.
 *       어긋남 1건 = 과거 라인 저장이 uws 를 갱신하지 않아 생긴 발산(= 이번 §5.5 fix 대상).
 *       predictWeekStatusForUser 는 fix(recomputeDerivedAfterActMutation→rejudge)가 커밋 시
 *       쓰는 것과 "동일한 순수 판정"이므로, 여기서 나온 target == fix 적용 후 uws 값.
 *
 * 무손실: 오직 읽기만 한다(쓰기 없음). 테스트 유저(test_user_markers)만 대상.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { predictWeekStatusForUser } from "@/lib/crewWeekGrowthRejudge";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

type WeekRow = {
  id: string;
  start_date: string | null;
  season_key: string | null;
  iso_year: number | null;
  iso_week: number | null;
  is_official_rest: boolean | null;
  result_published_at: string | null;
};

async function main() {
  // 1) 테스트 유저 집합.
  const { data: markerRows } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testUserIds = new Set(((markerRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
  console.log(`[테스트 유저] ${testUserIds.size}명`);
  if (testUserIds.size === 0) return;

  // 2) 공표된 성장 주차(비-공식휴식, 신정책 시행 이후).
  const { data: weekRows } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,season_key,iso_year,iso_week,is_official_rest,result_published_at")
    .not("result_published_at", "is", null)
    .order("start_date", { ascending: false });
  const weeks = ((weekRows ?? []) as WeekRow[]).filter(
    (w) =>
      w.start_date &&
      w.start_date >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM &&
      w.is_official_rest !== true &&
      w.iso_year != null &&
      w.iso_week != null,
  );
  console.log(`[공표 성장 주차] ${weeks.length}개`);

  // org 캐시.
  const orgCache = new Map<string, OrganizationSlug | null>();
  const resolveOrg = async (userId: string): Promise<OrganizationSlug | null> => {
    if (orgCache.has(userId)) return orgCache.get(userId)!;
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("organization_slug")
      .eq("user_id", userId)
      .maybeSingle();
    const slug = (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
    const org = slug && isOrganizationSlug(slug) ? slug : null;
    orgCache.set(userId, org);
    return org;
  };

  let scanned = 0;
  let diverged = 0;
  const examples: Array<{ userId: string; weekId: string; start: string; stored: string; predicted: string }> = [];

  for (const w of weeks) {
    // 이 주차의 uws 행 중 테스트 유저 & 성장 상태(success/fail)만.
    const { data: uwsRows } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,status")
      .eq("week_start_date", w.start_date as string)
      .in("status", ["success", "fail"]);
    const rows = ((uwsRows ?? []) as Array<{ user_id: string; status: string }>).filter((r) =>
      testUserIds.has(r.user_id),
    );

    for (const r of rows) {
      scanned++;
      const org = await resolveOrg(r.user_id);
      const pred = await predictWeekStatusForUser({ userId: r.user_id, weekId: w.id, organizationSlug: org });
      // skip(레거시/휴식/not_applicable/pending) = fix 도 손대지 않음 → 발산 아님.
      if (pred.skipped || !pred.targetStatus) continue;
      if (pred.targetStatus !== r.status) {
        diverged++;
        if (examples.length < 25) {
          examples.push({
            userId: r.user_id,
            weekId: w.id,
            start: w.start_date as string,
            stored: r.status,
            predicted: pred.targetStatus,
          });
        }
      }
    }
  }

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`스캔한 (테스트유저×공표주차) 성장 uws 행: ${scanned}`);
  console.log(`발산(저장 uws ≠ 라이브 판정): ${diverged}`);
  console.log("──────────────────────────────────────────────");
  if (examples.length > 0) {
    console.log("발산 예시 (fix 적용 시 uws 가 predicted 로 수렴):");
    console.log("  user_id                               | week_start | stored → predicted");
    for (const e of examples) {
      console.log(`  ${e.userId} | ${e.start} | ${e.stored} → ${e.predicted}`);
    }
  } else {
    console.log("발산 0건 — 현재 스캔 범위에서 저장 uws 와 라이브 판정이 일치.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
