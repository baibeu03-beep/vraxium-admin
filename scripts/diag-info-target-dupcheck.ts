// 백필 후 cluster4_line_targets 무결성 검증 — 페이지네이션으로 전수 읽어 중복(line_id,user_id) 확인.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const json = JSON.parse(readFileSync("claudedocs/encre-info-autoreview-dryrun-full.json", "utf8")) as { lines: { lineId: string }[] };
  const lineIds = json.lines.map((l) => l.lineId);

  // 전수 읽기 — order(id)+range 페이지네이션(1000 cap 회피).
  const all: Array<{ line_id: string; target_user_id: string | null }> = [];
  for (let i = 0; i < lineIds.length; i += 100) {
    const slice = lineIds.slice(i, i + 100);
    let from = 0;
    for (;;) {
      const { data, error } = await sb
        .from("cluster4_line_targets")
        .select("line_id,target_user_id")
        .in("line_id", slice)
        .eq("target_mode", "user")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ line_id: string; target_user_id: string | null }>;
      all.push(...rows);
      if (rows.length < 1000) break;
      from += 1000;
    }
  }
  const total = all.length;
  const pairs = new Set(all.map((r) => `${r.line_id}|${r.target_user_id}`));
  console.log(`전수 user-target(309라인) = ${total}`);
  console.log(`고유 (line_id,user_id) 쌍   = ${pairs.size}`);
  console.log(`중복 = ${total - pairs.size} ${total === pairs.size ? "✅ 중복 없음" : "❌ 중복 존재"}`);
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });
