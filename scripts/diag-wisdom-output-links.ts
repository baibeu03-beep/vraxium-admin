// Read-only diagnostic: locate 26봄 위즈덤 info lines + current output_link for
// 2026-spring W1~W5, W9~W13. DOES NOT write.
//
// Run: npx tsx --env-file=.env.local scripts/diag-wisdom-output-links.ts

import { createClient } from "@supabase/supabase-js";
import { resolveOutputLinks } from "../lib/cluster4OutputLinks";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, serviceKey);

const TARGET_WEEKS = [1, 2, 3, 4, 5, 9, 10, 11, 12, 13];

async function main() {
  // 1) 2026-spring 주차 week_id 맵
  const { data: weeks, error: wErr } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,is_official_rest")
    .eq("season_key", "2026-spring")
    .in("week_number", TARGET_WEEKS)
    .order("week_number");
  if (wErr) throw wErr;
  const weekById = new Map<string, { week_number: number; start_date: string }>();
  const wkRows = (weeks ?? []) as Array<{
    id: string; season_key: string; week_number: number; start_date: string; is_official_rest: boolean;
  }>;
  console.log("── 2026-spring weeks ──");
  for (const w of wkRows) {
    weekById.set(w.id, { week_number: w.week_number, start_date: w.start_date });
    console.log(`  W${w.week_number}  id=${w.id}  start=${w.start_date}  rest=${w.is_official_rest}`);
  }
  const weekIds = wkRows.map((w) => w.id);

  // 2) 그 주차들의 info 라인 중 title 에 "위즈덤" 포함 (active 무관)
  const { data: lines, error: lErr } = await sb
    .from("cluster4_lines")
    .select(
      "id,line_code,main_title,is_active,part_type,week_id,output_link_1,output_link_2,output_links,updated_at",
    )
    .eq("part_type", "info")
    .in("week_id", weekIds);
  if (lErr) throw lErr;
  const allInfo = (lines ?? []) as Array<{
    id: string; line_code: string | null; main_title: string | null; is_active: boolean;
    week_id: string; output_link_1: string | null; output_link_2: string | null;
    output_links: unknown; updated_at: string;
  }>;

  const wisdom = allInfo
    .filter((l) => (l.line_code ?? "").includes("PX-wisdom"))
    .sort((a, b) => (weekById.get(a.week_id)?.week_number ?? 0) - (weekById.get(b.week_id)?.week_number ?? 0));

  console.log(`\n── 위즈덤 info lines (matched ${wisdom.length}) ──`);
  for (const l of wisdom) {
    const wk = weekById.get(l.week_id);
    const resolved = resolveOutputLinks(l.output_links, [l.output_link_1, l.output_link_2]);
    console.log(
      `\nW${wk?.week_number}  line_id=${l.id}\n` +
        `   line_code=${l.line_code}  active=${l.is_active}  title="${l.main_title}"\n` +
        `   output_link_1=${JSON.stringify(l.output_link_1)}\n` +
        `   output_link_2=${JSON.stringify(l.output_link_2)}\n` +
        `   output_links(jsonb)=${JSON.stringify(l.output_links)}\n` +
        `   resolved=${JSON.stringify(resolved)}`,
    );
  }

  // 3) 누락 주차 점검 (위즈덤이 없는 target week)
  const matchedWeeks = new Set(wisdom.map((l) => weekById.get(l.week_id)?.week_number));
  const missing = TARGET_WEEKS.filter((n) => !matchedWeeks.has(n));
  console.log(`\n── 매칭 결과: ${wisdom.length} lines, 누락 주차=${missing.length ? missing.join(",") : "없음"} ──`);

  // 4) 같은 주차에 위즈덤 외 다른 info 라인이 있는지 컨텍스트(중복 title 위험 점검)
  console.log("\n── (참고) 대상 주차의 모든 info 라인 title 분포 ──");
  for (const n of TARGET_WEEKS) {
    const wid = wkRows.find((w) => w.week_number === n)?.id;
    const titles = allInfo
      .filter((l) => l.week_id === wid)
      .map((l) => `${l.is_active ? "" : "[inactive]"}${l.line_code}:${l.main_title}`);
    console.log(`  W${n}: ${titles.length ? titles.join(" | ") : "(없음)"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
