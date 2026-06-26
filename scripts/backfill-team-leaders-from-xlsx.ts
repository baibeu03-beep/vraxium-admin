/** 팀장.xlsx → cluster4_team_halves 팀장 백필.
 *  정책(요구사항):
 *   #1 Excel 팀장 이름 = SoT(leader_name 에 그대로 저장).
 *   #2 DB에 동일 이름 크루(operating, 테스트 제외)가 정확히 1명 → 자동연결(leader_user_id+crew_code).
 *   #3 무매칭 → leader_name 만(이름), leader_user_id=null → 나머지 "-".
 *   #4 phalanx: Excel 이름 없는 팀 → leader_name=null → 이름 "-", 나머지 "-".
 *   #5 동명이인(≥2) → 임의선택 금지: 연결하지 않고 이름만(보고). (실측 0건)
 *  반기 매핑: 각 반기 = 마지막 시즌(H1=봄, H2=가을). 그 시즌의 팀→팀장을 해당 반기 행에 귀속.
 *
 *  DRY-RUN 기본. 실제 쓰기는  --apply  플래그.
 *  run(dry): tsx --env-file=.env.local scripts/backfill-team-leaders-from-xlsx.ts
 *  run(apply): tsx --env-file=.env.local scripts/backfill-team-leaders-from-xlsx.ts --apply
 */
import fs from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCrewCode } from "@/lib/adminCrewCodeData";
import { matchOperatingLeaderByOrgName, type LeaderMatch } from "@/lib/teamLeaderMatch";
import type { OrganizationSlug } from "@/lib/organizations";

const APPLY = process.argv.includes("--apply");
const PARSED_PATH =
  "C:/Users/vanua/AppData/Local/Temp/claude/C--Users-vanua-OneDrive-Desktop-vraxium-admin/a74700c3-49f4-44f3-ae4b-13ccbe8321b8/scratchpad/parsed.json";

type Parsed = {
  org: string;
  half: string | null;
  season: string | null;
  seasonType: string | null;
  periodLabel: string | null;
  team: string | null;
  leader: string | null;
};

function norm(s: string | null): string {
  return (s ?? "").replace(/\s+/g, "").trim();
}

async function main() {
  const parsed: Parsed[] = JSON.parse(fs.readFileSync(PARSED_PATH, "utf8"));

  // (org, half) → canonical season(H1=spring, H2=autumn; 없으면 winter/summer 폴백).
  const seasonsByHalf = new Map<string, Set<string>>();
  for (const r of parsed) {
    if (!r.half || !r.seasonType) continue;
    const k = `${r.org}::${r.half}`;
    const s = seasonsByHalf.get(k) ?? new Set<string>();
    s.add(r.seasonType);
    seasonsByHalf.set(k, s);
  }
  function canonicalSeasonType(org: string, half: string): string | null {
    const s = seasonsByHalf.get(`${org}::${half}`);
    if (!s) return null;
    const isH1 = half.endsWith("H1");
    const prefer = isH1 ? ["spring", "winter"] : ["autumn", "summer"];
    return prefer.find((t) => s.has(t)) ?? null;
  }

  // (org, half, normTeam) → leader name(Excel SoT). canonical 시즌 우선, 없으면 같은 반기 다른 시즌.
  const leaderByRow = new Map<string, string | null>();
  for (const r of parsed) {
    if (!r.half || !r.team) continue;
    const canon = canonicalSeasonType(r.org, r.half);
    const key = `${r.org}::${r.half}::${norm(r.team)}`;
    const isCanon = r.seasonType === canon;
    if (isCanon || !leaderByRow.has(key)) {
      // canonical 우선: canonical 행이면 항상 덮어쓰기, 아니면 비어있을 때만.
      if (isCanon) leaderByRow.set(key, r.leader);
      else if (!leaderByRow.has(key)) leaderByRow.set(key, r.leader);
    }
  }

  // 기존 팀 행.
  const { data: thData, error: thErr } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id,organization_slug,half_key,team_name,is_active,leader_user_id")
    .order("organization_slug")
    .order("half_key");
  if (thErr) throw new Error(thErr.message);
  const rows = (thData ?? []) as Array<{
    id: string;
    organization_slug: string;
    half_key: string;
    team_name: string;
    is_active: boolean;
    leader_user_id: string | null;
  }>;

  // 매칭은 lib/teamLeaderMatch(단일 SoT) — (이름 AND organization_slug) 둘 다 일치 + operating.
  //   (org, normName) → LeaderMatch 캐시(중복 조회 방지).
  const matchCache = new Map<string, LeaderMatch>();
  async function matchFor(org: string, name: string): Promise<LeaderMatch> {
    const key = `${org}::${norm(name)}`;
    const hit = matchCache.get(key);
    if (hit) return hit;
    const m = await matchOperatingLeaderByOrgName(org as OrganizationSlug, name);
    matchCache.set(key, m);
    return m;
  }

  type Plan = {
    id: string;
    org: string;
    half: string;
    team: string;
    leaderName: string | null;
    userId: string | null;
    crewCode: string | null;
    status: "link" | "name-only" | "dash" | "dup" | "no-excel";
  };
  const plans: Plan[] = [];
  const crewCodeCache = new Map<string, string | null>();

  for (const row of rows) {
    const rowKey = `${row.organization_slug}::${row.half_key}::${norm(row.team_name)}`;
    const hasExcel = leaderByRow.has(rowKey);
    const leaderName = hasExcel ? leaderByRow.get(rowKey) ?? null : null;

    let status: Plan["status"];
    let userId: string | null = null;
    let crewCode: string | null = null;

    if (!hasExcel) {
      status = "no-excel";
    } else if (!leaderName) {
      status = "dash"; // phalanx 등 이름 없음
    } else {
      const m = await matchFor(row.organization_slug, leaderName);
      if (m.status === "link") {
        status = "link";
        userId = m.userId;
        if (!crewCodeCache.has(userId)) crewCodeCache.set(userId, await getCrewCode(userId));
        crewCode = crewCodeCache.get(userId) ?? null;
      } else if (m.status === "ambiguous") {
        status = "dup"; // 동명이인 ≥2 → 임의선택 금지 → 이름만
      } else {
        status = "name-only"; // 조직 내 무매칭 → 이름만
      }
    }
    plans.push({
      id: row.id,
      org: row.organization_slug,
      half: row.half_key,
      team: row.team_name,
      leaderName,
      userId,
      crewCode,
      status,
    });
  }

  const c = { link: 0, "name-only": 0, dash: 0, dup: 0, "no-excel": 0 } as Record<Plan["status"], number>;
  for (const p of plans) c[p.status]++;
  console.log(`총 팀 행: ${rows.length}`);
  console.log(`  link(자동연결)     : ${c.link}`);
  console.log(`  name-only(이름만)  : ${c["name-only"]}`);
  console.log(`  dash(이름없음 "-") : ${c.dash}`);
  console.log(`  dup(동명이인→이름만): ${c.dup}`);
  console.log(`  no-excel(매칭없음) : ${c["no-excel"]}`);

  if (c["no-excel"] > 0) {
    console.log("\n[경고] Excel 에 대응 팀이 없는 기존 행(미변경):");
    for (const p of plans.filter((x) => x.status === "no-excel")) {
      console.log(`   ${p.org} ${p.half} ${p.team}`);
    }
  }
  console.log(`\n[dash] 이름 없음(팔랑크스 등) → 이름 "-" :`);
  for (const p of plans.filter((x) => x.status === "dash")) {
    console.log(`   ${p.org} ${p.half} ${p.team}`);
  }

  console.log("\n--- 반기별 plan 샘플(최신 2026-H1) ---");
  for (const p of plans.filter((x) => x.half === "2026-H1")) {
    console.log(`   ${p.org} ${p.team}  ← ${p.leaderName ?? '"-"'}  [${p.status}${p.crewCode ? ` ${p.crewCode}` : ""}]`);
  }

  if (!APPLY) {
    console.log("\n(DRY-RUN) 쓰기 없음. 적용하려면 --apply");
    return;
  }

  console.log("\n=== APPLY: 쓰기 시작 ===");
  let written = 0;
  for (const p of plans) {
    if (p.status === "no-excel") continue; // 미변경
    const { error } = await supabaseAdmin
      .from("cluster4_team_halves")
      .update({
        leader_name: p.leaderName, // SoT 이름(이름 없으면 null → "-")
        leader_user_id: p.userId, // 1:1 매칭만, 아니면 null
        leader_crew_code: p.crewCode,
      })
      .eq("id", p.id);
    if (error) throw new Error(`${p.org} ${p.half} ${p.team}: ${error.message}`);
    written++;
  }
  console.log(`갱신 행: ${written}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
