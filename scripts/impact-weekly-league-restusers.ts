/**
 * impact-weekly-league-restusers — RestUsers 승격이 weekly-league 인원/휴식 카운트에 주는 영향 검증(read-only).
 *
 *   npx tsx --env-file=.env.local scripts/impact-weekly-league-restusers.ts            # baseline 출력
 *   npx tsx --env-file=.env.local scripts/impact-weekly-league-restusers.ts --diff <baseline.json>  # 적용 후 diff
 *
 * 가설: 승격자는 current_team_name='시즌전체휴식'·status='active'·2026-spring season rest 로 들어오되
 *   봄 주차 활동행(uws/uwp/pms)이 없다(봄 활동 보유 4명은 promote-restusers 가 제외). weekly-league
 *   per-week cohort 는 봄 신호 기반이므로 totalCrew/growthChallenge/success/fail/personalRest 가
 *   변하지 않아야 한다. memberRosterMode org 는 '시즌전체휴식' 을 로스터에서도 제외(이중 안전).
 *
 * 본 스크립트는 admin 이식 집계(computeWeeklyLeagueAggregation, front 1:1 미러)를 직접 호출해
 *   org 별 per-week 수치를 baseline 으로 적재한다. 적용 후 --diff 로 동일 여부를 단언한다.
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { computeWeeklyLeagueAggregation, WEEKLY_LEAGUE_SEASON_KEY } from "@/lib/weeklyLeaguePmsAggregation";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

const ORGS = ["encre", "oranke", "phalanx"];
const diffIdx = process.argv.indexOf("--diff");
const DIFF_FILE = diffIdx >= 0 ? process.argv[diffIdx + 1] : null;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/impact-weekly-league-restusers-${STAMP}.json`;

type WeekLine = { weekNumber: number; totalCrew: number; growthChallenge: number; growthSuccess: number; growthFail: number; personalRest: number; cohort: number };
type OrgResult = { org: string; memberRosterMode: boolean; rosterSize: number; archiveTargets: number; archiveWithSpringUws: number; weeks: WeekLine[] };

async function fetchAllSb<T>(table: string, select: string, orderCol: string, filt?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function snapshotOrg(org: string): Promise<OrgResult> {
  const { data: gate } = await sb.from("weekly_league_roster_orgs").select("organization_slug").eq("organization_slug", org).eq("enabled", true);
  const memberRosterMode = !!(gate && gate.length > 0);
  const { count: rosterSize } = await sb.from("user_profiles").select("user_id", { count: "exact", head: true })
    .eq("organization_slug", org).eq("status", "active");

  // archive 대상자(promoted/ archived 무관) 중 이 org + 그들 중 2026-spring uws 보유 수.
  const archive = await fetchAllSb<{ legacy_user_id: number; promoted_user_id: string | null }>(
    "legacy_pms_restuser_archive", "legacy_user_id,promoted_user_id", "legacy_user_id",
    (q) => q.eq("organization_slug", org).eq("promotion_status", "archived"));
  // 이미 promoted 된 사람의 봄 uws 도 같이 본다(적용 후 diff 용).
  const promotedIds = (await fetchAllSb<{ promoted_user_id: string | null }>(
    "legacy_pms_restuser_archive", "promoted_user_id", "legacy_user_id",
    (q) => q.eq("organization_slug", org).eq("promotion_status", "promoted")))
    .map((r) => r.promoted_user_id).filter(Boolean) as string[];
  let archiveWithSpringUws = 0;
  for (const uid of promotedIds) {
    const { count } = await sb.from("user_week_statuses").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("season_key", WEEKLY_LEAGUE_SEASON_KEY);
    if ((count ?? 0) > 0) archiveWithSpringUws++;
  }

  const agg = await computeWeeklyLeagueAggregation(org);
  const weeks: WeekLine[] = [...agg.byWeekId.values()]
    .sort((a, b) => a.weekNumber - b.weekNumber)
    .map((w) => ({
      weekNumber: w.weekNumber, totalCrew: w.totalCrew, growthChallenge: w.growthChallenge,
      growthSuccess: w.growthSuccess, growthFail: w.growthFail, personalRest: w.personalRest,
      cohort: w.cohortUserIds.length,
    }));
  return { org, memberRosterMode, rosterSize: rosterSize ?? 0, archiveTargets: archive.length, archiveWithSpringUws, weeks };
}

async function main() {
  const results: OrgResult[] = [];
  for (const org of ORGS) results.push(await snapshotOrg(org));

  for (const r of results) {
    console.log(`\n[${r.org}] rosterMode=${r.memberRosterMode} rosterSize(active)=${r.rosterSize} archive대기=${r.archiveTargets} promoted중봄uws=${r.archiveWithSpringUws}`);
    for (const w of r.weeks)
      console.log(`  W${String(w.weekNumber).padStart(2)} total=${w.totalCrew} 도전=${w.growthChallenge} 성공=${w.growthSuccess} 실패=${w.growthFail} 휴식=${w.personalRest} (cohort=${w.cohort})`);
  }

  if (DIFF_FILE) {
    const base = JSON.parse(readFileSync(DIFF_FILE, "utf8")) as { results: OrgResult[] };
    let diffs = 0;
    for (const r of results) {
      const b = base.results.find((x) => x.org === r.org);
      if (!b) { console.log(`\n⚠ ${r.org}: baseline 부재`); diffs++; continue; }
      for (const w of r.weeks) {
        const bw = b.weeks.find((x) => x.weekNumber === w.weekNumber);
        if (!bw) { console.log(`⚠ ${r.org} W${w.weekNumber}: baseline 주차 부재`); diffs++; continue; }
        const keys: (keyof WeekLine)[] = ["totalCrew", "growthChallenge", "growthSuccess", "growthFail", "personalRest", "cohort"];
        for (const k of keys) if (w[k] !== bw[k]) { console.log(`✗ ${r.org} W${w.weekNumber} ${k}: ${bw[k]} → ${w[k]}`); diffs++; }
      }
    }
    console.log(diffs === 0 ? "\n✅ weekly-league 영향 0 (모든 org·주차 수치 불변)" : `\n✗ ${diffs}건 변동 — 원인 조사 필요`);
    process.exit(diffs === 0 ? 0 : 1);
  }

  writeFileSync(OUT, JSON.stringify({ stamp: STAMP, season: WEEKLY_LEAGUE_SEASON_KEY, results }, null, 1));
  console.log("\n→ baseline 저장:", OUT);
  console.log("적용 후: npx tsx --env-file=.env.local scripts/impact-weekly-league-restusers.ts --diff " + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
