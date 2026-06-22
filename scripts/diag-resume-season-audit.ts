/**
 * READ-ONLY: 이력서 시즌행(resume-activities) 전수 감사.
 *   npx tsx --env-file=.env.local scripts/diag-resume-season-audit.ts
 *
 *   1) encre 윤서영 상세(uws + computeSeasonRecords 결과)
 *   2) 전 사용자(테스트 제외) computeSeasonRecords 호출 → 이상치 탐지:
 *      0/0 · 0/n · n/0 · 음수 · approved>total
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { computeSeasonRecords } from "@/lib/cluster1ResumeData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function dumpUser(userId: string, name: string, org: string | null) {
  console.log(`\n──── 상세: ${name} (${org}) ${userId} ────`);
  const { data: ws } = await sb
    .from("user_week_statuses")
    .select("week_start_date,status,season_key,week_number,year")
    .eq("user_id", userId)
    .order("week_start_date", { ascending: true });
  console.log(`  uws 행수: ${(ws ?? []).length}`);
  const bySeason = new Map<string, number>();
  for (const w of (ws ?? []) as any[]) {
    const k = String(w.season_key ?? "(null)");
    bySeason.set(k, (bySeason.get(k) ?? 0) + 1);
  }
  console.log(`  season_key 분포: ${JSON.stringify([...bySeason.entries()])}`);
  for (const w of (ws ?? []) as any[]) {
    console.log(`   ${w.week_start_date} wk${w.week_number} ${String(w.status).padEnd(13)} season=${w.season_key}`);
  }
  const recs = await computeSeasonRecords(userId);
  console.log(`  computeSeasonRecords → ${recs.length} rows:`);
  for (const r of recs) {
    console.log(`   ${r.year} ${r.seasonName} | ${r.position} | ${r.progressStatus} | ${r.approvedWeeks}주/${r.totalWeeks}주 | ${r.reviewStatus}`);
  }
}

async function main() {
  // 1) 윤서영 (encre)
  const { data: ys } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .ilike("display_name", "%윤서영%");
  console.log("윤서영 후보:", JSON.stringify(ys));
  for (const p of (ys ?? []) as any[]) {
    await dumpUser(p.user_id, p.display_name, p.organization_slug);
  }

  // 2) 전수 감사
  console.log("\n\n════════ 전수 감사 (테스트 제외) ════════");
  const testSet = new Set(
    ((await sb.from("test_user_markers").select("user_id")).data ?? []).map((t: any) => t.user_id),
  );
  // 활동(uws) 보유 유저만 대상.
  const uwsUsers = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("user_week_statuses")
      .select("user_id")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    const rows = (data ?? []) as any[];
    for (const r of rows) uwsUsers.add(r.user_id);
    if (rows.length < 1000) break;
  }
  const profs = new Map<string, any>();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .range(from, from + 999);
    const rows = (data ?? []) as any[];
    for (const r of rows) profs.set(r.user_id, r);
    if (rows.length < 1000) break;
  }
  const targets = [...uwsUsers].filter((u) => !testSet.has(u));
  console.log(`대상 유저(uws보유·테스트제외): ${targets.length}`);

  const anomalies: any[] = [];
  let done = 0;
  for (const uid of targets) {
    let recs;
    try {
      recs = await computeSeasonRecords(uid);
    } catch (e) {
      anomalies.push({ uid, kind: "ERROR", msg: e instanceof Error ? e.message : String(e) });
      continue;
    }
    for (const r of recs) {
      const a = r.approvedWeeks;
      const t = r.totalWeeks;
      const kinds: string[] = [];
      if (a === 0 && t === 0) kinds.push("0/0");
      else if (a === 0 && t > 0) kinds.push("0/n");
      else if (a > 0 && t === 0) kinds.push("n/0");
      if (a < 0 || t < 0) kinds.push("음수");
      if (a > t) kinds.push("approved>total");
      if (kinds.length) {
        const p = profs.get(uid);
        anomalies.push({
          uid, name: p?.display_name, org: p?.organization_slug,
          kinds: kinds.join(","), row: `${r.year} ${r.seasonName} ${a}/${t} ${r.progressStatus}`,
        });
      }
    }
    if (++done % 100 === 0) console.log(`  ...${done}/${targets.length}`);
  }

  console.log(`\n──── 이상치 ${anomalies.length}건 ────`);
  // kind별 집계
  const byKind = new Map<string, number>();
  for (const a of anomalies) byKind.set(a.kinds, (byKind.get(a.kinds) ?? 0) + 1);
  console.log("kind 분포:", JSON.stringify([...byKind.entries()]));
  for (const a of anomalies) {
    console.log(`  [${a.kinds}] ${a.name ?? a.uid} (${a.org ?? "-"}) :: ${a.row ?? a.msg}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
