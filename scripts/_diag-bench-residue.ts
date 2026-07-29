// 진단(일회성): 벤치가 남긴 잔여 라인/타깃 확인 및 정리.
//   npx tsx --env-file=.env.local scripts/_diag-bench-residue.ts          # 조회만
//   npx tsx --env-file=.env.local scripts/_diag-bench-residue.ts --clean  # [bench] 라인 삭제
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,main_title,is_active,week_id,activity_type_id,part_type,created_at")
    .like("main_title", "[bench]%");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  console.log("bench 잔여 라인:", rows.length);
  for (const r of rows) console.log(" ", r.id, r.main_title, "active=" + r.is_active, r.activity_type_id, r.created_at);

  if (process.argv.includes("--clean") && rows.length > 0) {
    const ids = rows.map((r) => String(r.id));
    const { error: delErr } = await supabaseAdmin.from("cluster4_lines").delete().in("id", ids);
    console.log("삭제:", delErr?.message ?? `${ids.length}건 OK`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
