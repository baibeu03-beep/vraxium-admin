/** READ-ONLY: career grade 평가 보유 사용자 분포 (4번 skill-num 검증 표본 탐색). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data, error } = await sb
    .from("cluster4_career_line_evaluations")
    .select("user_id,grade");
  if (error) throw new Error(error.message);
  const by = new Map<string, { n: number; d: number }>();
  for (const r of (data ?? []) as any[]) {
    const a = by.get(r.user_id) ?? { n: 0, d: 0 };
    a.n++;
    if (r.grade === "D") a.d++;
    by.set(r.user_id, a);
  }
  console.log("career 평가 보유 사용자:", by.size, "| 총 평가 행:", (data ?? []).length);
  let i = 0;
  for (const [u, a] of by) {
    if (i++ >= 8) break;
    console.log(" ", u, "evals=", a.n, "D=", a.d);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
