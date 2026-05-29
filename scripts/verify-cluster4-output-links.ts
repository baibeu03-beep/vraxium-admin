// Read-only verification that legacy output_link_* and new output_links coexist.
//
// Verifies: (1) helper resolution logic (jsonb priority + legacy fallback + mirror),
//           (2) live cluster4_lines rows resolve consistently after backfill.
// DOES NOT write to the database.
//
// Run: npx tsx --env-file=.env.local scripts/verify-cluster4-output-links.ts

import { createClient } from "@supabase/supabase-js";
import {
  resolveOutputLinks,
  outputLinksFromLegacy,
  outputLinksToLegacySlots,
  parseOutputLinksInput,
} from "../lib/cluster4OutputLinks";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures += 1;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── 1. Pure helper logic ──────────────────────────────────────────────
console.log("── helper logic ──");

// jsonb 우선
check(
  "jsonb present → used over legacy",
  eq(
    resolveOutputLinks(
      [{ url: "https://new", label: "설명" }],
      ["https://legacy"],
    ),
    [{ url: "https://new", label: "설명" }],
  ),
);

// jsonb 비어있으면 legacy fallback
check(
  "jsonb empty → legacy fallback (label null)",
  eq(resolveOutputLinks([], ["https://legacy", null]), [
    { url: "https://legacy", label: null },
  ]),
);

// 레거시 → output_links 파생, 순서 보존, 빈 값 제외
check(
  "legacy → outputLinks order preserved, blanks dropped",
  eq(outputLinksFromLegacy(["a", "", null, "b"]), [
    { url: "a", label: null },
    { url: "b", label: null },
  ]),
);

// mirror round-trip: outputLinks → 레거시 슬롯
check(
  "mirror to 2 legacy slots",
  eq(
    outputLinksToLegacySlots(
      [
        { url: "u1", label: "l1" },
        { url: "u2", label: "l2" },
      ],
      2,
    ),
    ["u1", "u2"],
  ),
);
check(
  "mirror pads missing slots with null",
  eq(outputLinksToLegacySlots([{ url: "u1", label: null }], 4), [
    "u1",
    null,
    null,
    null,
  ]),
);

// 입력 파서: label 정규화 + url 없는 항목 제거
const parsed = parseOutputLinksInput([
  { url: "https://x", label: "  설명  " },
  { url: "  ", label: "drop-me" },
  { url: "https://y" },
]);
check(
  "parseOutputLinksInput trims label + drops urlless",
  parsed.ok &&
    eq(parsed.value, [
      { url: "https://x", label: "설명" },
      { url: "https://y", label: null },
    ]),
);

// ── 2. Live DB rows ───────────────────────────────────────────────────
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing Supabase env; skipping live checks.");
  process.exit(failures > 0 ? 1 : 0);
}
const supabase = createClient(url, serviceKey);

async function main() {
  console.log("\n── live cluster4_lines ──");
  const { data, error } = await supabase
    .from("cluster4_lines")
    .select("id,output_link_1,output_link_2,output_links")
    .limit(10);
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    output_link_1: string | null;
    output_link_2: string | null;
    output_links: unknown;
  }>;
  console.log(`rows: ${rows.length}`);

  let backfilledCount = 0;
  for (const row of rows) {
    const resolved = resolveOutputLinks(row.output_links, [
      row.output_link_1,
      row.output_link_2,
    ]);
    const jsonbLen = Array.isArray(row.output_links) ? row.output_links.length : 0;
    if (jsonbLen > 0) backfilledCount += 1;
    // 백필된 행: jsonb 의 첫 url 이 레거시 output_link_1 과 일치해야 함(정합성).
    if (jsonbLen > 0 && row.output_link_1) {
      check(
        `row ${row.id.slice(0, 8)}: jsonb[0].url === output_link_1`,
        resolved[0]?.url === row.output_link_1.trim(),
      );
    }
  }
  check("at least one row has backfilled output_links jsonb", backfilledCount > 0);
  console.log(`backfilled rows (jsonb non-empty): ${backfilledCount}/${rows.length}`);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
