// T서다은(0주 표시 케이스) uws 행 전체 덤프 — 전환 판정 포함.
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { isTransitionWeekStart } = await import("../lib/seasonCalendar");

  const { data: prof } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .eq("display_name", "T서다은")
    .maybeSingle();
  console.log(`user: ${prof?.display_name} | user_id=${prof?.user_id}`);

  // 컬럼 존재 확인을 위해 * 로 1행 조회
  const { data: probe } = await sb
    .from("user_week_statuses")
    .select("*")
    .eq("user_id", prof!.user_id)
    .limit(1);
  console.log("uws 컬럼:", Object.keys((probe ?? [{}])[0] ?? {}).join(", "));

  const { data: rows } = await sb
    .from("user_week_statuses")
    .select("*")
    .eq("user_id", prof!.user_id)
    .order("week_start_date", { ascending: true });

  const { data: defs } = await sb
    .from("season_definitions")
    .select("season_key,season_type");
  const typeOf = new Map(((defs ?? []) as any[]).map((d) => [d.season_key, d.season_type]));

  const dump = (title: string, rs: any[]) => {
    console.log(`\n=== ${title} (${rs.length}행) ===`);
    for (const r of rs) {
      console.log(
        [
          `user_id=${r.user_id}`,
          `season_id=${r.season_id ?? "(컬럼 없음→season_key=" + r.season_key + ")"}`,
          `season_type=${typeOf.get(r.season_key) ?? "?"}`,
          `week_start_date=${r.week_start_date}`,
          `week_number=${r.week_number}`,
          `status=${r.status}`,
          `isTransitionWeekStart=${r.week_start_date ? isTransitionWeekStart(r.week_start_date) : "(date null)"}`,
        ].join(" | "),
      );
    }
  };

  const all = (rows ?? []) as any[];
  dump("26겨울 (2026-winter)", all.filter((r) => r.season_key === "2026-winter"));
  dump("26봄 (2026-spring) 전체", all.filter((r) => r.season_key === "2026-spring"));
  const other = all.filter((r) => r.season_key !== "2026-winter" && r.season_key !== "2026-spring");
  if (other.length) dump("기타 시즌", other);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
