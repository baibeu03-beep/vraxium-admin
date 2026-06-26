// 검증 — 고객 /api/profile gradeStats 가 user_grade_stats 캐시값과 일치(캐시-우선 전환).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const rq = createRequire(resolve("package.json"));
const { createClient } = rq("@supabase/supabase-js");
const env = readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));
const CUST = "http://localhost:3001";
let fail = 0; const ck = (l, ok, d="") => { console.log(`  ${ok?"✓":"✗"} ${l}${d?` — ${d}`:""}`); if(!ok) fail++; };

// 캐시에서 graded 사용자 3명(grade·avg_percentile 보유) 추출.
const { data: graded } = await sb.from("user_grade_stats")
  .select("user_id, grade, grade_label, avg_percentile")
  .not("grade", "is", null).not("avg_percentile", "is", null).limit(3);
console.log(`graded 표본 ${graded?.length ?? 0}명`);
for (const g of graded ?? []) {
  const res = await fetch(`${CUST}/api/profile?userId=${g.user_id}`);
  const j = await res.json().catch(() => null);
  const gs = j?.data?.gradeStats ?? j?.gradeStats ?? null;
  const tag = g.user_id.slice(0, 8);
  if (!gs) { ck(`${tag} gradeStats 응답`, false, `status=${res.status}`); continue; }
  const pctMatch = Math.abs(Number(gs.avgPercentile) - Number(g.avg_percentile)) < 0.01;
  ck(`${tag} grade 캐시일치`, gs.grade === g.grade, `api=${gs.grade} cache=${g.grade}`);
  ck(`${tag} gradeLabel 캐시일치`, gs.gradeLabel === g.grade_label, `api=${gs.gradeLabel} cache=${g.grade_label}`);
  ck(`${tag} avgPercentile 캐시일치`, pctMatch, `api=${gs.avgPercentile} cache=${g.avg_percentile}`);
}
console.log(fail === 0 ? "✅ 고객 club-rank 캐시 기준 정상" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
