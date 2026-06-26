/** READ-ONLY: 팀장.xlsx 의 팀장 이름을 DB 크루(user_profiles.display_name)와 이름 매칭.
 *  목적(요구사항 #5): 동명이인/무매칭 조사 결과를 먼저 보고하기 위한 진단.
 *  - operating 스코프(test_user_markers 제외)만 후보로 본다.
 *  run: tsx --env-file=.env.local scripts/diag-team-leader-name-match.ts
 */
import fs from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveUserScope } from "@/lib/userScope";
import type { OrganizationSlug } from "@/lib/organizations";

type Parsed = {
  org: string;
  half: string | null;
  season: string | null;
  periodLabel: string | null;
  team: string | null;
  leader: string | null;
};

const PARSED_PATH =
  "C:/Users/vanua/AppData/Local/Temp/claude/C--Users-vanua-OneDrive-Desktop-vraxium-admin/a74700c3-49f4-44f3-ae4b-13ccbe8321b8/scratchpad/parsed.json";

async function main() {
  const rows: Parsed[] = JSON.parse(fs.readFileSync(PARSED_PATH, "utf8"));

  // 조직별 고유 팀장 이름.
  const orgs = [...new Set(rows.map((r) => r.org))];
  console.log("조직:", orgs.join(", "));

  // 전 조직 프로필 1회 로드(display_name 트림 기준).
  const { data: profs, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, organization_slug, role, current_team_name, current_part_name");
  if (error) throw new Error(error.message);

  // operating 스코프(테스트 제외) 판정자 — org 무관 전역 testUserIds.
  const scope = await resolveUserScope("operating", null);

  type Prof = {
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
    role: string | null;
    current_team_name: string | null;
    current_part_name: string | null;
  };
  const allProfs = (profs ?? []) as Prof[];

  // (org, normalizedName) → 후보 프로필[]
  function norm(s: string | null): string {
    return (s ?? "").replace(/\s+/g, "").trim();
  }
  const byOrgName = new Map<string, Prof[]>();
  for (const p of allProfs) {
    const key = `${p.organization_slug ?? ""}::${norm(p.display_name)}`;
    const arr = byOrgName.get(key) ?? [];
    arr.push(p);
    byOrgName.set(key, arr);
  }

  // 고유 (org, leaderName) 수집.
  const uniq = new Map<string, { org: string; name: string; teams: Set<string> }>();
  for (const r of rows) {
    if (!r.leader) continue;
    const key = `${r.org}::${norm(r.leader)}`;
    const e = uniq.get(key) ?? { org: r.org, name: r.leader.trim(), teams: new Set<string>() };
    if (r.team) e.teams.add(`${r.periodLabel}/${r.team}`);
    uniq.set(key, e);
  }

  const zero: any[] = [];
  const one: any[] = [];
  const dup: any[] = [];

  for (const [, e] of uniq) {
    const key = `${e.org}::${norm(e.name)}`;
    const allCands = byOrgName.get(key) ?? [];
    // 테스트 계정 제외(operating).
    const cands = allCands.filter((p) => scope.includes(p.user_id));
    const testHit = allCands.length - cands.length;
    const rec = {
      org: e.org,
      name: e.name,
      teams: [...e.teams],
      matchCount: cands.length,
      testExcluded: testHit,
      candidates: cands.map((c) => ({
        user_id: c.user_id,
        role: c.role,
        team: c.current_team_name,
        part: c.current_part_name,
      })),
    };
    if (cands.length === 0) zero.push(rec);
    else if (cands.length === 1) one.push(rec);
    else dup.push(rec);
  }

  console.log(`\n고유 (org,팀장) 수: ${uniq.size}`);
  console.log(`  1:1 매칭          : ${one.length}`);
  console.log(`  무매칭(이름만/"-"): ${zero.length}`);
  console.log(`  동명이인(≥2)      : ${dup.length}`);

  console.log("\n========== 동명이인(≥2 후보) — 임의선택 금지, 보고 대상 ==========");
  for (const d of dup) {
    console.log(`\n[${d.org}] "${d.name}"  (후보 ${d.matchCount}명, 테스트제외 ${d.testExcluded})`);
    console.log(`  Excel 팀: ${d.teams.join(", ")}`);
    for (const c of d.candidates) {
      console.log(`   - user_id=${c.user_id} role=${c.role} team=${c.team} part=${c.part}`);
    }
  }

  console.log(`\n========== 무매칭(DB에 동일 이름 크루 없음 → 이름만/"-") ==========`);
  for (const z of zero) {
    console.log(`[${z.org}] "${z.name}"  ${z.testExcluded ? `(테스트계정 ${z.testExcluded}명만 존재 → operating 제외)` : ""}  팀: ${z.teams.join(", ")}`);
  }

  console.log("\n========== 1:1 자동연결 후보(13) ==========");
  for (const o of one) {
    const c = o.candidates[0];
    console.log(`[${o.org}] "${o.name}" → user_id=${c.user_id} role=${c.role} team=${c.team} part=${c.part}  | Excel팀: ${o.teams.join(", ")}`);
  }

  // 각 org "마지막 반기(2026-H1)"의 canonical season = 봄(spring). 현재 표시 핵심 집합.
  console.log("\n========== 최신 반기 2026-H1 canonical(봄/spring) 팀장 매칭상태 ==========");
  const matchSet = new Map<string, number>();
  for (const o of [...one, ...zero, ...dup]) matchSet.set(`${o.org}::${norm(o.name)}`, o.matchCount);
  for (const org of orgs) {
    const halves = [...new Set(rows.filter((r) => r.org === org).map((r) => r.half))].sort().reverse();
    const latest = halves[0];
    // canonical season within latest half: spring for H1, autumn for H2
    const seasonRank = (s: string | null) => {
      const t = s?.split("-")[1] ?? "";
      return { winter: 0, spring: 1, summer: 0, autumn: 1 }[t] ?? 0; // last-of-half = 1
    };
    const inHalf = rows.filter((r) => r.org === org && r.half === latest);
    const canonSeason = [...new Set(inHalf.map((r) => r.season))].sort(
      (a, b) => seasonRank(b) - seasonRank(a),
    )[0];
    console.log(`\n[${org}] ${latest} canonical season=${canonSeason}`);
    for (const r of inHalf.filter((r) => r.season === canonSeason)) {
      if (!r.leader) {
        console.log(`   ${r.team}  ← (Excel 이름 없음) → 이름 "-", 나머지 "-"`);
        continue;
      }
      const mc = matchSet.get(`${org}::${norm(r.leader)}`) ?? 0;
      const tag = mc === 1 ? "자동연결" : mc === 0 ? `무매칭 → 이름만 "${r.leader}", 나머지 "-"` : `동명이인(${mc})`;
      console.log(`   ${r.team}  ← ${r.leader}  [${tag}]`);
    }
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
