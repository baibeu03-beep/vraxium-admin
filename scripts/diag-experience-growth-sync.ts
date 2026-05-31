/**
 * 실무경험 성장 상태 sync 결과 조회 (읽기 전용 + 멱등 재실행 확인).
 *
 *   npx tsx --env-file=.env.local scripts/diag-experience-growth-sync.ts
 *
 * 이번 sync 가 success→fail 로 바꾼 주차 = status='fail' AND updated_at >= 오늘 00:00Z.
 * (sync writer 가 updated_at 을 실행 시각으로 갱신하므로 seed fail(과거 날짜)과 구분됨)
 * "변경 전 status" 는 sync 의 단방향 규칙(success→fail)상 항상 'success'.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { fetchExperienceRequiredSlotStatusByWeek } from "@/lib/lineAvailability";
import { syncAllExperienceGrowthWeekStatuses } from "@/lib/cluster4WeeklyGrowthData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type FailRow = {
  user_id: string;
  year: number;
  week_number: number;
  week_start_date: string;
  status: string;
  updated_at: string | null;
};

async function main() {
  const todayCutoff = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  console.log(`기준 cutoff (오늘 sync 식별): updated_at >= ${todayCutoff}\n`);

  // 1. 이번 sync 로 fail 된 주차 (오늘 갱신된 fail 행)
  const { data: failData, error: failErr } = await sb
    .from("user_week_statuses")
    .select("user_id,year,week_number,week_start_date,status,updated_at")
    .eq("status", "fail")
    .gte("updated_at", todayCutoff)
    .order("user_id", { ascending: true })
    .order("week_number", { ascending: true });

  if (failErr) {
    console.error("user_week_statuses 조회 실패:", failErr.message);
    process.exit(1);
  }
  const flipped = (failData ?? []) as FailRow[];
  console.log(`오늘 fail 로 갱신된 주차: ${flipped.length}건\n`);

  // 2. 사용자 프로필 (이름/조직)
  const userIds = [...new Set(flipped.map((r) => r.user_id))];
  const profileById = new Map<string, { name: string; org: string }>();
  if (userIds.length > 0) {
    const { data: profiles } = await sb
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .in("user_id", userIds);
    for (const p of (profiles ?? []) as {
      user_id: string;
      display_name: string | null;
      organization_slug: string | null;
    }[]) {
      profileById.set(p.user_id, {
        name: p.display_name ?? "(이름없음)",
        org: p.organization_slug ?? "-",
      });
    }
  }

  // 3. week_start_date → weeks.id (verdict 조회용)
  const startDates = [...new Set(flipped.map((r) => r.week_start_date))];
  const weekIdByStart = new Map<string, string>();
  if (startDates.length > 0) {
    const { data: weeksData } = await sb
      .from("weeks")
      .select("id,start_date")
      .in("start_date", startDates);
    for (const w of (weeksData ?? []) as { id: string; start_date: string | null }[]) {
      if (w.start_date) weekIdByStart.set(w.start_date, w.id);
    }
  }

  // 4. 사용자별 verdict 조회 (failedSlotOrders 포함)
  const verdictByUserWeek = new Map<string, { status: string; failed: number[] }>();
  for (const uid of userIds) {
    const userWeekIds = flipped
      .filter((r) => r.user_id === uid)
      .map((r) => weekIdByStart.get(r.week_start_date))
      .filter((v): v is string => Boolean(v));
    if (userWeekIds.length === 0) continue;
    const vmap = await fetchExperienceRequiredSlotStatusByWeek(uid, userWeekIds);
    for (const [weekId, v] of vmap) {
      verdictByUserWeek.set(`${uid}|${weekId}`, {
        status: v.status,
        failed: v.failedSlotOrders,
      });
    }
  }

  // 5. 표 출력
  console.log(
    "사용자명 | user_id(8) | 조직 | year/week | before | after | verdict | failed slots",
  );
  console.log("─".repeat(110));
  const orgCount: Record<string, number> = {};
  for (const r of flipped) {
    const prof = profileById.get(r.user_id) ?? { name: "?", org: "-" };
    const weekId = weekIdByStart.get(r.week_start_date);
    const v = weekId
      ? verdictByUserWeek.get(`${r.user_id}|${weekId}`)
      : undefined;
    orgCount[prof.org] = (orgCount[prof.org] ?? 0) + 1;
    console.log(
      `${prof.name} | ${r.user_id.slice(0, 8)} | ${prof.org} | ${r.year}/${r.week_number} | success | ${r.status} | ${v?.status ?? "?"} | ${JSON.stringify(v?.failed ?? [])}`,
    );
  }
  console.log("─".repeat(110));
  console.log(`총 ${flipped.length}주차, 사용자 ${userIds.length}명`);
  console.log("조직별:", JSON.stringify(orgCount));

  // 검증: 모든 flipped 주차의 verdict 가 fail 인가 (experience-driven 확인)
  const allFailVerdict = flipped.every((r) => {
    const weekId = weekIdByStart.get(r.week_start_date);
    const v = weekId ? verdictByUserWeek.get(`${r.user_id}|${weekId}`) : undefined;
    return v?.status === "fail";
  });
  console.log(`\n모든 flipped 주차 verdict=fail (experience-driven): ${allFailVerdict ? "✅ 예" : "❌ 아니오"}`);

  // 6. 동일 sync 재실행 → flippedToFail=0 확인 (멱등) + 반환값 전체
  console.log("\n════════ syncAllExperienceGrowthWeekStatuses() 재실행 (멱등 확인) ════════");
  const rerun = await syncAllExperienceGrowthWeekStatuses();
  console.log(
    JSON.stringify(
      {
        usersScanned: rerun.usersScanned,
        usersFlipped: rerun.usersFlipped,
        totalFlippedToFail: rerun.totalFlippedToFail,
        results: rerun.results,
      },
      null,
      2,
    ),
  );
  console.log(
    `\n멱등성: 재실행 flippedToFail = ${rerun.totalFlippedToFail} ${rerun.totalFlippedToFail === 0 ? "✅" : "❌"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
