import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 1. weeks 테이블의 전체 컬럼 확인 (기존 1 row를 SELECT * 로)
  const { data: sample, error } = await sb.from("weeks").select("*").limit(1);
  if (error) { console.error("ERROR:", error.message); return; }
  console.log("=== weeks 테이블 전체 컬럼 ===");
  if (sample && sample.length > 0) {
    const cols = Object.keys(sample[0]);
    console.log("columns:", cols.join(", "));
    console.log("sample:", JSON.stringify(sample[0], null, 2));
  }

  // 2. seasons 테이블 (원본) 확인
  console.log("\n=== seasons 테이블 (원본) ===");
  const { data: seasons, error: sErr } = await sb.from("seasons").select("*").limit(3);
  if (sErr) {
    console.log("ERROR:", sErr.message);
  } else if (seasons && seasons.length > 0) {
    const cols = Object.keys(seasons[0]);
    console.log("columns:", cols.join(", "));
    for (const s of seasons) {
      console.log(JSON.stringify(s, null, 2));
    }
  } else {
    console.log("(빈 테이블 또는 미존재)");
  }

  // 3. seasons ↔ season_definitions 매핑 확인
  console.log("\n=== seasons 와 season_definitions 대응 ===");
  const { data: sdAll } = await sb
    .from("season_definitions")
    .select("season_key,season_label,start_date,end_date")
    .order("start_date", { ascending: false })
    .limit(5);
  if (sdAll) {
    for (const sd of sdAll as Array<Record<string, unknown>>) {
      console.log(`  ${sd.season_key}: ${sd.start_date} ~ ${sd.end_date} (${sd.season_label})`);
    }
  }
}

main().catch(console.error);
