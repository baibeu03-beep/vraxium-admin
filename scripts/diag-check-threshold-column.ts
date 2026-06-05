// diag: weeks.check_threshold 컬럼 적용 여부 확인 (수동 마이그레이션 점검)
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { supabaseAdmin } = await import("../lib/supabaseAdmin");
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id,check_threshold")
    .limit(1);
  console.log("error:", error ? error.message : "none");
  console.log("sample:", JSON.stringify(data));
}
main().catch((e) => { console.error(e); process.exit(1); });
