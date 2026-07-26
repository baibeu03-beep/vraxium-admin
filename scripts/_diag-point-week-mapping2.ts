// READ-ONLY 진단 2 — 주차 카드(화면 행) × 주차 포인트(A/B/C) 결합 검사.
//   [A] 2026-summer/spring 주차 목록 + is_official_rest
//   [B] 대상 사용자별: 카드 startDate 행에 붙는 포인트(HEAD 축=uwp.week_start_date,
//       회귀축=awards→weeks.iso) 비교. "휴식 주차에만 포인트" 현상 재현 여부.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

type Num = number | null;

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  const { data: wRaw } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date,is_official_rest,iso_year,iso_week,holiday_name")
    .in("season_key", ["2026-spring", "2026-summer"])
    .order("start_date", { ascending: true });
  const weeks = (wRaw ?? []) as Array<{
    id: string; season_key: string | null; week_number: Num; start_date: string | null;
    is_official_rest: boolean | null; iso_year: Num; iso_week: Num; holiday_name: string | null;
  }>;
  console.log("=== [A] 2026 spring/summer 주차 ===");
  for (const w of weeks) {
    console.log(
      `  ${w.start_date}  ${w.season_key} W${w.week_number}  iso=${w.iso_year}-${w.iso_week}` +
        `${w.is_official_rest ? "  [공식휴식]" : ""}${w.holiday_name ? `  (${w.holiday_name})` : ""}`,
    );
  }

  const allWeeks = await pageAll<{
    season_key: string | null; week_number: Num; start_date: string | null;
    is_official_rest: boolean | null; iso_year: Num; iso_week: Num;
  }>((f, t) =>
    supabaseAdmin
      .from("weeks")
      .select("season_key,week_number,start_date,is_official_rest,iso_year,iso_week")
      .order("start_date", { ascending: true })
      .range(f, t),
  );
  const weekByStart = new Map(allWeeks.filter((w) => w.start_date).map((w) => [w.start_date!, w]));
  const startByIso = new Map<string, string>();
  for (const w of allWeeks) {
    if (w.iso_year == null || w.iso_week == null || !w.start_date) continue;
    startByIso.set(`${w.iso_year}::${w.iso_week}`, w.start_date);
  }

  const targets: Array<{ id: string; name: string }> = [
    { id: "76a42307-f3b2-4c08-92ab-f339a20b7d38", name: "T윤서진" },
    { id: "05ff6b96-b3e7-4050-97f1-080633f183d3", name: "T권희윤" },
    { id: "00b75923-2109-4214-806a-37667d64ac5e", name: "T강민지" },
    { id: "8eeb75ba-47c9-49fd-971b-ba3188b90ce4", name: "윤채영" },
    { id: "9e2f8097-b1ce-4920-9c67-af9989074cfd", name: "T홍채원" },
  ];

  for (const t of targets) {
    const [{ data: uwpRaw }, { data: ppaRaw }, snap] = await Promise.all([
      supabaseAdmin
        .from("user_weekly_points")
        .select("year,week_number,week_start_date,points,advantages,penalty")
        .eq("user_id", t.id),
      supabaseAdmin
        .from("process_point_awards")
        .select("year,week_number,point_check,point_advantage,point_penalty,cancelled_at")
        .eq("user_id", t.id),
      readWeeklyCardsSnapshot(t.id),
    ]);
    const uwp = (uwpRaw ?? []) as Array<{
      year: Num; week_number: Num; week_start_date: string | null;
      points: Num; advantages: Num; penalty: Num;
    }>;
    const ppa = ((ppaRaw ?? []) as Array<{
      year: Num; week_number: Num; point_check: Num; point_advantage: Num; point_penalty: Num;
      cancelled_at: string | null;
    }>).filter((r) => !r.cancelled_at);

    const m1 = new Map<string, { a: number; b: number; c: number }>();
    for (const r of uwp) {
      if (!r.week_start_date) continue;
      const e = m1.get(r.week_start_date) ?? { a: 0, b: 0, c: 0 };
      e.a += r.points ?? 0;
      e.b += (r.advantages ?? 0) - Math.abs(r.penalty ?? 0);
      e.c += Math.abs(r.penalty ?? 0);
      m1.set(r.week_start_date, e);
    }
    const m2 = new Map<string, { a: number; b: number; c: number }>();
    for (const r of ppa) {
      const start = r.year != null && r.week_number != null ? startByIso.get(`${r.year}::${r.week_number}`) : undefined;
      if (!start) continue;
      const e = m2.get(start) ?? { a: 0, b: 0, c: 0 };
      e.a += r.point_check ?? 0;
      e.b += (r.point_advantage ?? 0) - Math.abs(r.point_penalty ?? 0);
      e.c += Math.abs(r.point_penalty ?? 0);
      m2.set(start, e);
    }

    console.log(`\n=== [B] ${t.name} (${t.id}) snapshot=${snap.status} ===`);
    const cards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    const sorted = [...cards].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    for (const c of sorted) {
      const sd = String(c.startDate ?? "");
      const w = weekByStart.get(sd);
      const v1 = m1.get(sd);
      const v2 = m2.get(sd);
      console.log(
        `  ${sd} ${c.seasonKey ?? ""} W${c.weekNumber ?? ""} ${String(c.userWeekStatus ?? "").padEnd(14)}` +
          `${w?.is_official_rest ? "[공식휴식] " : "           "}` +
          `HEAD(uwp)=${v1 ? `${v1.a}/${v1.b}/${v1.c}` : "0/0/0(행없음)"}  ` +
          `회귀(awards)=${v2 ? `${v2.a}/${v2.b}/${v2.c}` : "0/0/0(행없음)"}`,
      );
    }
    const extra = [...m1.keys()].filter((k) => !sorted.some((c) => String(c.startDate) === k)).sort();
    console.log(`  · 카드 없는 uwp 주차(표에 안 뜸): ${extra.length}건 ${extra.slice(0, 12).join(", ")}`);
    const extra2 = [...m2.keys()].filter((k) => !sorted.some((c) => String(c.startDate) === k)).sort();
    console.log(`  · 카드 없는 awards 주차: ${extra2.length}건 ${extra2.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
