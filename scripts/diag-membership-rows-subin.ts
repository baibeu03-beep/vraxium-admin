/** READ-ONLY: T최수빈 user_memberships 전체 row + 테이블 컬럼 파악. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("user_memberships")
    .select("*")
    .eq("user_id", "36138fb1-6fea-4b22-b6d2-9c46cba47314");
  console.log(JSON.stringify({ error: error?.message ?? null, rows: data }, null, 2));

  // 멤버십 row 수 분포(다중 row 사용자 존재 여부)
  const { data: all, error: e2 } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,is_current,membership_level");
  if (e2) throw e2;
  const byUser = new Map<string, number>();
  for (const r of all ?? []) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + 1);
  const multi = [...byUser.values()].filter((n) => n > 1).length;
  console.log(`총 ${all?.length}행 / 사용자 ${byUser.size}명 / 다중행 사용자 ${multi}명`);
  const levels = new Map<string, number>();
  for (const r of all ?? []) {
    const k = `${r.membership_level ?? "<null>"}|is_current=${r.is_current}`;
    levels.set(k, (levels.get(k) ?? 0) + 1);
  }
  console.log("level|is_current 분포:", JSON.stringify([...levels.entries()]));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
