/**
 * 이관·로직 검증: user_position_histories 적용 후.
 *   npx tsx --env-file=.env.local scripts/verify-position-histories.ts
 *   (서버 기동 시 HTTP 비교 포함: BASE_URL + INTERNAL_API_KEY)
 *
 *   1) 테이블 존재 + 행수 + position_code 분포
 *   2) 윤서영 + 운영진 샘플 computeSeasonRecords(direct) — 시즌별 직책
 *   3) direct == HTTP(/api/cluster1/resume) seasonRecords 비교
 *   4) 0/N 잔존(전수) — 백필 회귀 없는지
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { computeSeasonRecords } from "@/lib/cluster1ResumeData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.BASE_URL || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY;

async function httpResume(userId: string): Promise<any | null> {
  if (!KEY) return null;
  try {
    const r = await fetch(`${BASE}/api/cluster1/resume?userId=${userId}`, { headers: { "x-internal-api-key": KEY } });
    const j = await r.json();
    return j?.success ? j.data : null;
  } catch { return null; }
}

async function main() {
  // 1) 테이블
  const { count, error } = await sb.from("user_position_histories").select("id", { count: "exact", head: true });
  if (error) { console.log("✗ 테이블 조회 실패(미생성?):", error.message); return; }
  console.log(`user_position_histories 행수=${count}`);
  const dist = new Map<string, number>();
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("user_position_histories").select("position_code").range(f, f + 999);
    const rows = (data ?? []) as any[];
    for (const r of rows) dist.set(r.position_code, (dist.get(r.position_code) ?? 0) + 1);
    if (rows.length < 1000) break;
  }
  console.log("position_code 분포:", JSON.stringify([...dist.entries()]));

  // 2)+3) 샘플 direct + HTTP
  const names = ["윤서영", "김소연", "정민서"];
  for (const name of names) {
    const { data: p } = await sb.from("user_profiles").select("user_id").ilike("display_name", name).limit(1);
    const uid = (p as any)?.[0]?.user_id; if (!uid) { console.log(`${name} 없음`); continue; }
    const direct = await computeSeasonRecords(uid);
    console.log(`\n[${name}] direct seasonRecords:`);
    for (const r of direct) console.log(`  ${r.year} ${r.seasonName} | ${r.position} | ${r.approvedWeeks}/${r.totalWeeks} | ${r.progressStatus}`);
    const http = await httpResume(uid);
    if (http) {
      const eq = JSON.stringify(http.seasonRecords) === JSON.stringify(direct);
      console.log(`  direct == HTTP : ${eq ? "✅" : "❌ 불일치"}`);
      if (!eq) console.log("  HTTP:", JSON.stringify(http.seasonRecords));
    } else {
      console.log("  HTTP: 서버 미기동/키없음 — 스킵");
    }
  }

  // 4) 0/N 잔존
  const testSet = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((t: any) => t.user_id));
  const uwsUsers = new Set<string>();
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("user_week_statuses").select("user_id").order("user_id").range(f, f + 999);
    const rows = (data ?? []) as any[]; for (const r of rows) uwsUsers.add(r.user_id);
    if (rows.length < 1000) break;
  }
  const targets = [...uwsUsers].filter((u) => !testSet.has(u));
  let zeroN = 0;
  for (const uid of targets) {
    const recs = await computeSeasonRecords(uid);
    for (const r of recs) if (r.approvedWeeks === 0 && r.totalWeeks > 0) zeroN++;
  }
  console.log(`\n0/N 잔존(전수, 전부 활동중단 정상): ${zeroN}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
