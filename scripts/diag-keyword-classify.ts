/** READ-ONLY: profile_keyword 값 전수 추출 (백필 적절성 판단용 표본). 쓰기 없음. */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data, error } = await sb
    .from("user_profiles")
    .select("user_id,display_name,profile_keyword,profile_tagline")
    .not("profile_keyword", "is", null);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = (data ?? []).filter(
    (r: any) => r.profile_keyword != null && String(r.profile_keyword).trim() !== "",
  );
  console.log(`profile_keyword 값 보유: ${rows.length}건\n`);
  // 길이 분포 (한줄소개 vs 단어태그 구분 신호)
  const lens = rows.map((r: any) => String(r.profile_keyword).trim().length);
  const wordCounts = rows.map((r: any) => String(r.profile_keyword).trim().split(/\s+/).length);
  const avgLen = (lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1);
  const maxLen = Math.max(...lens);
  const minLen = Math.min(...lens);
  const multiWord = wordCounts.filter((w) => w >= 2).length;
  console.log(`길이: min=${minLen} avg=${avgLen} max=${maxLen} | 2단어이상(공백포함): ${multiWord}/${rows.length}\n`);
  console.log("── 전체 값 (display_name → keyword | tagline) ──");
  let i = 0;
  for (const r of rows as any[]) {
    i++;
    console.log(
      `${String(i).padStart(2)} ${String(r.display_name ?? "?").padEnd(6)} | "${r.profile_keyword}"  (len=${String(r.profile_keyword).trim().length}) tagline=${JSON.stringify(r.profile_tagline)}`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
