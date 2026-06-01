/**
 * [READ-ONLY] user_profiles.status vs growth_status 값 분포·불일치 조사.
 *   npx tsx --env-file=.env.local scripts/inspect-status-vs-growth.ts
 * DB 는 읽기만 한다(수정 없음).
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const ACCOUNT_VALUES = new Set(["active", "inactive"]);

function tally(rows: { status: string | null; growth_status: string | null }[]) {
  const statusDist = new Map<string, number>();
  const growthDist = new Map<string, number>();
  const pairDist = new Map<string, number>();
  let mismatch = 0;
  let statusPolluted = 0; // status 가 계정값(active/inactive) 이외
  for (const r of rows) {
    const s = r.status ?? "(null)";
    const g = r.growth_status ?? "(null)";
    statusDist.set(s, (statusDist.get(s) ?? 0) + 1);
    growthDist.set(g, (growthDist.get(g) ?? 0) + 1);
    pairDist.set(`${s} | ${g}`, (pairDist.get(`${s} | ${g}`) ?? 0) + 1);
    if (r.status && !ACCOUNT_VALUES.has(r.status)) statusPolluted++;
    if (r.status !== r.growth_status) mismatch++;
  }
  return { statusDist, growthDist, pairDist, mismatch, statusPolluted };
}

function printMap(title: string, m: Map<string, number>) {
  console.log(`\n--- ${title} ---`);
  for (const [k, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} : ${n}`);
  }
}

async function run() {
  const rows: { status: string | null; growth_status: string | null }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("user_profiles")
      .select("status,growth_status")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  console.log(`총 user_profiles 행 = ${rows.length}`);
  const t = tally(rows);
  printMap("status 분포", t.statusDist);
  printMap("growth_status 분포", t.growthDist);
  printMap("(status | growth_status) 조합 분포", t.pairDist);
  console.log(`\nstatus != growth_status (불일치) 행 수 : ${t.mismatch}`);
  console.log(`status 가 active/inactive 이외(성장값 오염) 행 수 : ${t.statusPolluted}`);
}

run().catch((e) => { console.error("fatal", e); process.exit(1); });
