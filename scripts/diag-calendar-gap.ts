/**
 * diag-calendar-gap.ts (READ-ONLY)
 * 2025-winter W1 ~ 2026-spring W11 연속 범위의 모든 weeks 행에 대해
 * 활성 캘린더 라인(part=info, activity=calendar, is_active) 존재 여부 + line_code + 타깃수.
 * 실행: npx tsx --env-file=.env.local scripts/diag-calendar-gap.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const RANGE_START = "2024-12-30"; // 2025-winter W1 시작
const RANGE_END = "2026-05-17"; // 2026-spring W11 종료

async function main() {
  const { data: wRows } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date,iso_year,iso_week,is_official_rest")
    .gte("start_date", RANGE_START)
    .lte("start_date", RANGE_END)
    .order("start_date", { ascending: true });
  const weeks = (wRows ?? []) as Array<{
    id: string;
    season_key: string;
    week_number: number;
    start_date: string;
    end_date: string;
    iso_year: number;
    iso_week: number;
    is_official_rest: boolean | null;
  }>;

  // 활성 캘린더 라인 (week_id 기준).
  const { data: lRows } = await sb
    .from("cluster4_lines")
    .select("id,week_id,line_code,main_title,is_active,source_type,output_links")
    .eq("part_type", "info")
    .eq("activity_type_id", "calendar")
    .eq("is_active", true);
  const activeLines = (lRows ?? []) as Array<{
    id: string;
    week_id: string | null;
    line_code: string | null;
    main_title: string | null;
    source_type: string | null;
    output_links: unknown;
  }>;
  const lineByWeek = new Map<string, typeof activeLines>();
  for (const l of activeLines) {
    if (!l.week_id) continue;
    const arr = lineByWeek.get(l.week_id) ?? [];
    arr.push(l);
    lineByWeek.set(l.week_id, arr);
  }

  // 타깃수 (week_id 기준, 활성 라인만).
  const activeLineIds = activeLines.map((l) => l.id);
  const { data: tRows } = await sb
    .from("cluster4_line_targets")
    .select("week_id,line_id,target_mode")
    .in("line_id", activeLineIds.length ? activeLineIds : ["x"]);
  const targetCountByWeek = new Map<string, number>();
  for (const t of (tRows ?? []) as Array<{ week_id: string; target_mode: string }>) {
    if (t.target_mode !== "user") continue;
    targetCountByWeek.set(t.week_id, (targetCountByWeek.get(t.week_id) ?? 0) + 1);
  }

  console.log(`\n=== 캘린더 라인 커버리지: ${RANGE_START} ~ ${RANGE_END} (${weeks.length} weeks) ===`);
  const missing: typeof weeks = [];
  for (const w of weeks) {
    const lines = lineByWeek.get(w.id) ?? [];
    const tc = targetCountByWeek.get(w.id) ?? 0;
    const mark = lines.length ? "✅" : "❌MISSING";
    const codes = lines.map((l) => l.line_code).join(",");
    console.log(
      `  ${mark}  ${w.season_key} W${String(w.week_number).padStart(2)} [${w.start_date}] iso=${w.iso_year}w${String(w.iso_week).padStart(2, "0")} rest=${w.is_official_rest ?? false}  lines=${lines.length} code=[${codes}] targets=${tc} id=${w.id}`,
    );
    if (!lines.length) missing.push(w);
  }
  console.log(`\n=== MISSING (캘린더 라인 없음): ${missing.length} weeks ===`);
  for (const w of missing) {
    console.log(`  ${w.season_key} W${w.week_number} iso=${w.iso_year}w${w.iso_week} [${w.start_date}~${w.end_date}] id=${w.id}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
