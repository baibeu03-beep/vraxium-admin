// weeks 테이블 numbering 전수 확인 (29/30주차 의미 파악)
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: one, error: e1 } = await sb.from("weeks").select("*").limit(1);
  if (e1) console.error("schema err:", e1.message);
  console.log("weeks columns:", Object.keys(one?.[0] ?? {}).join(", "));

  const { data: all, error } = await sb
    .from("weeks")
    .select("season_key, week_number, start_date, end_date")
    .order("start_date");
  if (error) console.error("rows err:", error.message);
  console.log("total weeks rows:", all?.length);
  for (const w of all ?? []) {
    console.log(`  ${w.start_date}~${w.end_date} ${w.season_key} w${w.week_number}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
