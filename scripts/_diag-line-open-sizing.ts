// 진단(일회성): 라인 개설/취소 경로가 스캔하는 테이블의 실제 규모를 잰다.
//   npx tsx --env-file=.env.local scripts/_diag-line-open-sizing.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function count(table: string, apply?: (q: any) => any) {
  let q = supabaseAdmin.from(table).select("*", { count: "exact", head: true });
  if (apply) q = apply(q);
  const { count: c, error } = await q;
  return error ? `ERR ${error.message}` : String(c ?? 0);
}

async function main() {
  console.log("=== 규모 ===");
  console.log("cluster4_weekly_card_snapshots :", await count("cluster4_weekly_card_snapshots"));
  console.log("user_profiles                  :", await count("user_profiles"));
  console.log("cluster4_lines                 :", await count("cluster4_lines"));
  console.log("cluster4_line_targets          :", await count("cluster4_line_targets"));
  console.log("user_weekly_points             :", await count("user_weekly_points"));
  console.log("user_week_statuses             :", await count("user_week_statuses"));
  console.log("process_point_awards           :", await count("process_point_awards"));

  // loadLineOrgPopulation 이 실제로 받는 행 수(PostgREST 기본 cap 확인).
  const t0 = Date.now();
  const { data: snaps, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id");
  console.log("\n=== loadLineOrgPopulation 실측 ===");
  console.log("select user_id rows:", error ? `ERR ${error.message}` : (snaps ?? []).length,
    `(${Date.now() - t0}ms)`);
  const ids = ((snaps ?? []) as { user_id: string }[]).map((r) => r.user_id);
  console.log("unique user_id     :", new Set(ids).size);

  const t1 = Date.now();
  const { data: profs, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,organization_slug")
    .in("user_id", ids);
  console.log(
    "in(user_profiles)  :",
    pErr ? `ERR ${pErr.message}` : (profs ?? []).length,
    `(${Date.now() - t1}ms)  urlIdsBytes≈${ids.join(",").length}`,
  );

  // 주차 참여자(품계 재동기 스코프) 규모 — 최근 주차 기준.
  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,iso_year,iso_week,start_date")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const w = wk as { id: string; iso_year: number; iso_week: number; start_date: string } | null;
  if (w) {
    console.log("\n=== 최신 주차", w.start_date, w.iso_year, "W" + w.iso_week, "===");
    console.log(
      "user_weekly_points(week)      :",
      await count("user_weekly_points", (q: any) => q.eq("year", w.iso_year).eq("week_number", w.iso_week)),
    );
    console.log(
      "user_week_statuses(week)      :",
      await count("user_week_statuses", (q: any) => q.eq("week_start_date", w.start_date)),
    );
    console.log(
      "cluster4_line_targets(week)   :",
      await count("cluster4_line_targets", (q: any) => q.eq("week_id", w.id)),
    );
  }

  // 단일 유저 snapshot 재계산 실측(가장 비싼 단위 작업).
  const { data: anySnap } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id")
    .limit(1)
    .maybeSingle();
  const uid = (anySnap as { user_id: string } | null)?.user_id;
  if (uid) {
    const { recomputeAndStoreWeeklyCardsSnapshot } = await import("@/lib/cluster4WeeklyCardsSnapshot");
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await recomputeAndStoreWeeklyCardsSnapshot(uid);
      console.log(`snapshot recompute #${i + 1} (user ${uid.slice(0, 8)}):`, Date.now() - t, "ms");
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
