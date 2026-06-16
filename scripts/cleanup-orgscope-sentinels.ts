// 검증 sentinel 라인 잔재 정리(테스트 데이터 전용). 운영 라인 무접촉(__ 접두 sentinel 만).
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from("cluster4_lines").select("id,main_title")
    .or("main_title.like.__ORGSCOPE%,main_title.like.__HTTP%,main_title.like.__DTOSHAPE%,main_title.like.__ORG-MODE%");
  for (const r of (data ?? []) as Array<{ id: string; main_title: string }>) {
    await sb.from("cluster4_line_targets").delete().eq("line_id", r.id);
    await sb.from("cluster4_lines").delete().eq("id", r.id);
    console.log("deleted", r.main_title);
  }
  console.log("cleanup done:", (data ?? []).length);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
