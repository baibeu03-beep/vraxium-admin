/**
 * diag-calendar-line-backfill.ts  (READ-ONLY — DB 무변경)
 *
 * 실무정보 '캘린더' 라인 백필을 위한 현재 상태 진단.
 *   1) '캘린더' 와 매칭되는 info 라인(전 주차, is_active 무관) 나열.
 *   2) 그 라인이 속한 활동유형(activity_type) 확정.
 *   3) 2025 겨울 W1 ~ 2026 봄 W11 주차 행(weeks) 나열(season_key/week_number/start/end).
 *   4) 각 주차에 캘린더 라인이 이미 개설돼 있는지 매트릭스.
 *
 * 실행: npx tsx --env-file=.env.local scripts/diag-calendar-line-backfill.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // ── 1) practical_info 활동유형 전체 나열(이름 확인용) ──
  const { data: actTypes, error: actErr } = await sb
    .from("activity_types")
    .select("id,name,cluster_id,is_active")
    .eq("cluster_id", "practical_info");
  if (actErr) throw new Error(actErr.message);
  console.log("\n=== practical_info 활동유형 ===");
  for (const a of (actTypes ?? []) as Array<{ id: string; name: string; is_active: boolean }>) {
    console.log(`  ${a.is_active ? "●" : "○"} ${a.name}  (${a.id})`);
  }

  // ── 2) '캘린더' 포함 info 라인(전체) ──
  const { data: allInfoLines, error: lineErr } = await sb
    .from("cluster4_lines")
    .select(
      "id,part_type,activity_type_id,line_code,week_id,main_title,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,is_active,created_at",
    )
    .eq("part_type", "info");
  if (lineErr) throw new Error(lineErr.message);
  const infoLines = (allInfoLines ?? []) as Array<Record<string, unknown>>;
  const calendarLines = infoLines.filter((l) =>
    String(l.main_title ?? "").includes("캘린더"),
  );
  console.log(`\n=== '캘린더' 포함 info 라인: ${calendarLines.length}건 (전체 info ${infoLines.length}건) ===`);
  for (const l of calendarLines) {
    console.log(JSON.stringify(l, null, 2));
  }

  // 캘린더 라인이 쓰는 activity_type_id 들.
  const calActIds = Array.from(new Set(calendarLines.map((l) => String(l.activity_type_id))));
  console.log(`\n캘린더 라인 activity_type_id: ${JSON.stringify(calActIds)}`);

  // ── 3) 캘린더 라인의 타깃(week 매핑) ──
  const calLineIds = calendarLines.map((l) => String(l.id));
  const { data: calTargets } = await sb
    .from("cluster4_line_targets")
    .select("id,line_id,week_id,target_mode,target_user_id,target_rule")
    .in("line_id", calLineIds.length ? calLineIds : ["00000000-0000-0000-0000-000000000000"]);
  const targets = (calTargets ?? []) as Array<{
    id: string;
    line_id: string;
    week_id: string;
    target_mode: string;
    target_user_id: string | null;
    target_rule: Record<string, unknown> | null;
  }>;
  console.log(`\n=== 캘린더 라인 타깃: ${targets.length}건 ===`);
  for (const t of targets) {
    console.log(
      `  line=${t.line_id.slice(0, 8)} week=${t.week_id.slice(0, 8)} mode=${t.target_mode} user=${t.target_user_id?.slice(0, 8) ?? "—"} rule=${JSON.stringify(t.target_rule)}`,
    );
  }

  // ── 4) weeks: season_key 분포 확인 ──
  const { data: seasonKeys } = await sb
    .from("weeks")
    .select("season_key")
    .order("season_key");
  const skSet = Array.from(
    new Set(((seasonKeys ?? []) as Array<{ season_key: string }>).map((w) => w.season_key)),
  );
  console.log(`\n=== weeks season_key 종류 ===\n  ${JSON.stringify(skSet)}`);

  // 2025 겨울, 2026 봄 후보 season_key 추출.
  const winterKeys = skSet.filter((k) => /winter/i.test(k) && /2025|25/.test(k));
  const springKeys = skSet.filter((k) => /spring/i.test(k) && /2026|26/.test(k));
  console.log(`  2025겨울 후보: ${JSON.stringify(winterKeys)}`);
  console.log(`  2026봄  후보: ${JSON.stringify(springKeys)}`);

  // ── 5) 관심 시즌의 weeks 전체 나열 ──
  const targetSeasons = Array.from(new Set([...winterKeys, ...springKeys]));
  if (targetSeasons.length) {
    const { data: wRows } = await sb
      .from("weeks")
      .select("id,season_key,week_number,start_date,end_date,iso_year,iso_week,is_official_rest")
      .in("season_key", targetSeasons)
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
    console.log(`\n=== 관심 시즌 weeks (${weeks.length}건) ===`);
    const targetWeekIds = new Set(targets.map((t) => t.week_id));
    for (const w of weeks) {
      const hasCal = targetWeekIds.has(w.id);
      console.log(
        `  ${hasCal ? "✅캘린더" : "  ·    "} ${w.season_key} W${w.week_number} [${w.start_date}~${w.end_date}] iso=${w.iso_year}/${w.iso_week} rest=${w.is_official_rest ?? false} id=${w.id}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
