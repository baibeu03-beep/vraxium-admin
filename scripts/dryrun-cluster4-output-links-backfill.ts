// Read-only dry-run for 2026-05-29_cluster4_output_links_jsonb.sql backfill.
//
// DOES NOT modify the database. It reads the current output_link_* columns from
// the three target tables and computes the output_links jsonb the migration's
// UPDATE statements would produce, then prints counts + samples.
//
// Run: npx tsx --env-file=.env.local scripts/dryrun-cluster4-output-links-backfill.ts

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey);

type OutputLink = { url: string; label: string | null };

// Mirrors the SQL: ordered, NULL/blank-trimmed-out, label = null.
function buildOutputLinks(orderedUrls: (string | null | undefined)[]): OutputLink[] {
  const out: OutputLink[] = [];
  for (const raw of orderedUrls) {
    if (raw == null) continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    out.push({ url: trimmed, label: null });
  }
  return out;
}

async function dryRunTable(
  table: string,
  linkColumns: string[],
): Promise<void> {
  const { data, error } = await supabase
    .from(table)
    .select(["id", ...linkColumns].join(","));

  if (error) {
    console.error(`\n[${table}] query failed: ${error.message}`);
    return;
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  let wouldFill = 0;
  const samples: { id: unknown; legacy: Record<string, unknown>; output_links: OutputLink[] }[] = [];

  for (const row of rows) {
    const orderedUrls = linkColumns.map((c) => row[c] as string | null);
    const links = buildOutputLinks(orderedUrls);
    if (links.length > 0) {
      wouldFill += 1;
      if (samples.length < 5) {
        const legacy: Record<string, unknown> = {};
        for (const c of linkColumns) legacy[c] = row[c];
        samples.push({ id: row.id, legacy, output_links: links });
      }
    }
  }

  console.log(`\n=== ${table} ===`);
  console.log(`총 행: ${rows.length} | backfill 대상(링크 1개 이상): ${wouldFill}`);
  if (samples.length) {
    console.log(`샘플(최대 5건):`);
    for (const s of samples) {
      console.log(`  id=${s.id}`);
      console.log(`    legacy : ${JSON.stringify(s.legacy)}`);
      console.log(`    → jsonb: ${JSON.stringify(s.output_links)}`);
    }
  } else {
    console.log("  (백필될 행 없음 — 모든 행이 빈 링크)");
  }
}

async function main() {
  console.log("Cluster4 output_links backfill DRY-RUN (read-only, no writes)");
  await dryRunTable("cluster4_lines", ["output_link_1", "output_link_2"]);
  await dryRunTable("cluster4_line_submissions", [
    "output_link_2",
    "output_link_3",
    "output_link_4",
    "output_link_5",
  ]);
  await dryRunTable("cluster4_experience_line_drafts", ["output_link_1", "output_link_2"]);
  console.log("\nDONE. (DB 변경 없음)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
