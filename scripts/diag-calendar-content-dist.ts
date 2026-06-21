/**
 * diag-calendar-content-dist.ts (READ-ONLY)
 * 활성 캘린더 라인 전체의 output_links / main_title 분포 — 표준(canonical) 콘텐츠 확정.
 * 실행: npx tsx --env-file=.env.local scripts/diag-calendar-content-dist.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data } = await sb
    .from("cluster4_lines")
    .select("id,line_code,main_title,output_links,output_link_1,output_link_2,output_images,week_id")
    .eq("part_type", "info")
    .eq("activity_type_id", "calendar")
    .eq("is_active", true)
    .like("line_code", "info-OK-calendar-%");
  const lines = (data ?? []) as Array<Record<string, unknown>>;

  const titleDist = new Map<string, number>();
  const linksDist = new Map<string, number>();
  for (const l of lines) {
    titleDist.set(String(l.main_title), (titleDist.get(String(l.main_title)) ?? 0) + 1);
    const key = JSON.stringify(l.output_links);
    linksDist.set(key, (linksDist.get(key) ?? 0) + 1);
  }
  console.log(`\n=== main_title 분포 (${lines.length} active oranke calendar lines) ===`);
  for (const [t, n] of titleDist) console.log(`  [${n}] "${t}"`);

  console.log(`\n=== output_links 분포 ===`);
  for (const [k, n] of [...linksDist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  [${n}] ${k}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
