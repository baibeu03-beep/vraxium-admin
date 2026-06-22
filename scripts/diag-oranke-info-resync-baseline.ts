/**
 * diag-oranke-info-resync-baseline.ts (READ-ONLY)
 * oranke info 라인 재동기화(메인타이틀/아웃풋링크) 전 baseline 캡처.
 *   - active part_type=info 라인 중 line_code 토큰=OK(오랑캐) 행의 output_links 현황
 *   - cluster4_line_targets 총 카운트 + info 라인에 매달린 target 카운트(전/후 동일성 증명용)
 * 실행: npx tsx --env-file=.env.local scripts/diag-oranke-info-resync-baseline.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function countAll(table: string): Promise<number> {
  const { count, error } = await sb.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`${table} count failed: ${error.message}`);
  return count ?? 0;
}

async function main() {
  // 모든 active info 라인.
  const lines: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("cluster4_lines")
      .select("id,line_code,activity_type_id,main_title,is_active,output_links,output_link_1,output_link_2,week_id")
      .eq("part_type", "info")
      .eq("is_active", true)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`lines query failed: ${error.message}`);
    lines.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const okLines = lines.filter((l) => typeof l.line_code === "string" && /OK/.test(l.line_code));
  const withLink = okLines.filter(
    (l) => (Array.isArray(l.output_links) && l.output_links.length > 0) || l.output_link_1,
  );

  // info 라인에 매달린 target 카운트.
  const infoLineIds = lines.map((l) => l.id);
  let infoTargetCount = 0;
  for (let i = 0; i < infoLineIds.length; i += 100) {
    const slice = infoLineIds.slice(i, i + 100);
    const { count, error } = await sb
      .from("cluster4_line_targets")
      .select("*", { count: "exact", head: true })
      .in("line_id", slice);
    if (error) throw new Error(`targets count failed: ${error.message}`);
    infoTargetCount += count ?? 0;
  }

  const totalTargets = await countAll("cluster4_line_targets");

  console.log(
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        activeInfoLines: lines.length,
        orankeOkLines: okLines.length,
        orankeOkLinesWithOutputLink: withLink.length,
        cluster4_line_targets_total: totalTargets,
        cluster4_line_targets_on_active_info_lines: infoTargetCount,
        sampleOkLineOutputLinks: okLines.slice(0, 8).map((l) => ({
          id: l.id,
          line_code: l.line_code,
          activity_type_id: l.activity_type_id,
          main_title: String(l.main_title ?? "").slice(0, 40),
          output_link_1: l.output_link_1,
          output_links: l.output_links,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
