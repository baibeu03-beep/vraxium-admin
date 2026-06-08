/** rename 후 연결 유지 검증 (read-only). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { fetchLegacyUnifiedMasterId } from "@/lib/lineAvailability";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
async function main() {
  const mid = await fetchLegacyUnifiedMasterId();
  console.log("fetchLegacyUnifiedMasterId:", mid ? mid.slice(0, 8) + "… (정상)" : "NULL (실패!)");
  const { data: lines } = await sb.from("cluster4_lines").select("id").like("line_code", "EXBS-EN%").range(0, 99);
  let targets = 0;
  const ids = (lines ?? []).map((l: any) => l.id);
  for (let i = 0; i < ids.length; i += 50) {
    const { count } = await sb.from("cluster4_line_targets").select("id", { count: "exact", head: true }).in("line_id", ids.slice(i, i + 50));
    targets += count ?? 0;
  }
  console.log(`EN 라인 ${ids.length}개의 타깃 연결: ${targets}건 (id 불변 — FK 유지)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
