/**
 * diag-calendar-template.ts (READ-ONLY)
 * W10/W11 캘린더 라인 + 직전 sibling(2025w52) + 한 직전 정상주(2026w07) 의 전체 컬럼 비교.
 * + W10/W11 타깃 상세(누가 타깃인지).
 * 실행: npx tsx --env-file=.env.local scripts/diag-calendar-template.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SAMPLE_LINE_IDS = {
  "W10 (2026w19)": "5a6e9d6a-cbc2-4c08-9ffd-6d1dbd378845",
  "W11 (2026w20)": "862c2d40-4ed0-4776-8cfc-b6db98d1c4d4",
  "sibling 2026w07": "10c6bbf1-e22b-4cf1-a03f-de4d7d46981c", // wait this is week_id, fix below
};

async function main() {
  // 전체 컬럼을 보기 위해 select *.
  const ids = [
    "5a6e9d6a-cbc2-4c08-9ffd-6d1dbd378845", // W10
    "862c2d40-4ed0-4776-8cfc-b6db98d1c4d4", // W11
    "a6e60160-db0e-494d-8d63-547fe3a0a142", // 2026w07 sibling (직전 정상)
    "9c64592e-db9c-4d97-9522-1490227915ba", // 2025w52 sibling
  ];
  const { data } = await sb.from("cluster4_lines").select("*").in("id", ids);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    console.log(`\n──────── line ${row.id} (code=${row.line_code}) ────────`);
    console.log(JSON.stringify(row, null, 2));
  }

  // W10/W11 타깃 상세.
  const testIds = await fetchTestUserMarkerIds();
  for (const [label, lineId] of [
    ["W10", "5a6e9d6a-cbc2-4c08-9ffd-6d1dbd378845"],
    ["W11", "862c2d40-4ed0-4776-8cfc-b6db98d1c4d4"],
  ] as const) {
    const { data: tg } = await sb
      .from("cluster4_line_targets")
      .select("target_user_id,target_mode,week_id")
      .eq("line_id", lineId);
    const rows = (tg ?? []) as Array<{ target_user_id: string | null; target_mode: string; week_id: string }>;
    const uids = rows.map((r) => r.target_user_id).filter((x): x is string => Boolean(x));
    const { data: profs } = await sb
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .in("user_id", uids.length ? uids : ["x"]);
    const byId = new Map(
      ((profs ?? []) as Array<{ user_id: string; display_name: string | null; organization_slug: string | null }>).map(
        (p) => [p.user_id, p],
      ),
    );
    const test = uids.filter((u) => testIds.has(u)).length;
    console.log(`\n=== ${label} 타깃 ${rows.length}건 (test ${test}/real ${uids.length - test}) ===`);
    for (const r of rows) {
      const p = r.target_user_id ? byId.get(r.target_user_id) : null;
      console.log(
        `  mode=${r.target_mode} ${r.target_user_id ? (testIds.has(r.target_user_id) ? "🧪" : "👤") : "—"} ${p?.display_name ?? r.target_user_id ?? "(sentinel)"} org=${p?.organization_slug ?? "—"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
