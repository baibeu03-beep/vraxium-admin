// ===================================================================
// READ-ONLY DRY RUN — PMS usersinfo 역할(팀장/앰배서더) → Vraxium user_profiles.role 백필 계획.
//   write 없음 · snapshot 없음 · 재계산 없음. 순수 SELECT + 메모리 집계 + 보고.
//
// 역할 출처: PMS <db>.usersinfo.TeamRole / UserRole (adminusers 테이블은 부재 — 역할은 usersinfo 보유).
//   매핑: TeamRole='팀장' → team_leader · (TeamRole='앰배서더' OR UserRole='앰배서더') → ambassador.
//   "현재 역할" = UserID 별 최신 usersinfo 행(MAX InfoID). + 참고로 "과거 포함(ever)" 도 별도 집계.
//   동일인 식별 = Vraxium users(source_system, legacy_user_id=PMS UserID) 복합키(B안, offset 없음).
// ===================================================================
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { PMS_SOURCE_SYSTEMS, type PmsSourceSystem } from "@/lib/pmsMigration";

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sbUrl = G("NEXT_PUBLIC_SUPABASE_URL")!;
const sbKey = G("SUPABASE_SERVICE_ROLE_KEY")!;
const SH = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
async function sbAll(p: string): Promise<any[]> {
  const A: any[] = [];
  for (let f = 0; ; f += 1000) {
    const s = p.includes("?") ? "&" : "?";
    const r = await fetch(`${sbUrl}/rest/v1/${p}${s}limit=1000&offset=${f}`, { headers: SH });
    if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
    const j = await r.json();
    A.push(...j);
    if (j.length < 1000) break;
  }
  return A;
}

// source_system → PMS MySQL db. (oranke→oranke, hrdb→hrdb, olympus→olympus)
const SOURCE_DB: Record<PmsSourceSystem, string> = { oranke: "oranke", hrdb: "hrdb", olympus: "olympus" };
// 조직 표시 순서.
const ORG_ORDER: Array<{ source: PmsSourceSystem; org: string }> = [
  { source: "oranke", org: "oranke" },
  { source: "hrdb", org: "encre" },
  { source: "olympus", org: "phalanx" },
];

type RoleTarget = "team_leader" | "ambassador";
function classify(teamRole: string | null, userRole: string | null): RoleTarget | null {
  const tr = (teamRole ?? "").trim();
  const ur = (userRole ?? "").trim();
  if (tr === "팀장") return "team_leader";
  if (tr === "앰배서더" || ur === "앰배서더") return "ambassador";
  return null;
}

async function main() {
  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  // Vraxium 전 사용자/프로필/테스트마커 1회 로드.
  const vUsers = await sbAll("users?select=id,legacy_user_id,source_system");
  const vProfiles = await sbAll("user_profiles?select=user_id,display_name,role,organization_slug");
  const testSet = new Set((await sbAll("test_user_markers?select=user_id")).map((t) => t.user_id));
  const profByUid = new Map(vProfiles.map((p) => [p.user_id, p]));
  // (source_system, legacy_user_id) → vraxium user_id
  const vidByKey = new Map<string, string>();
  for (const u of vUsers) {
    if (u.source_system == null || u.legacy_user_id == null) continue;
    vidByKey.set(`${u.source_system}::${Number(u.legacy_user_id)}`, u.id);
  }

  const summaryRows: any[] = [];
  const allCandidates: any[] = [];
  const allUnmatched: any[] = [];

  for (const { source, org } of ORG_ORDER) {
    const db = SOURCE_DB[source];
    const ui = await q(`SELECT InfoID,UserID,Team,Part,State,UserRole,TeamRole FROM \`${db}\`.usersinfo`);
    const names = new Map<number, string>(
      (await q(`SELECT UserId,Name FROM \`${db}\`.users`)).map((r: any) => [r.UserId, (r.Name || "").trim()]),
    );

    // UserID 별 최신 행(MAX InfoID) = "현재".
    const latest = new Map<number, any>();
    for (const r of ui) { const c = latest.get(r.UserID); if (!c || Number(r.InfoID) > Number(c.InfoID)) latest.set(r.UserID, r); }
    // 과거 포함(ever) 역할.
    const everTeamLeader = new Set<number>(), everAmbassador = new Set<number>();
    for (const r of ui) {
      const t = classify(r.TeamRole, r.UserRole);
      if (t === "team_leader") everTeamLeader.add(r.UserID);
      if (t === "ambassador") everAmbassador.add(r.UserID);
    }

    let pmsLeader = 0, pmsAmbassador = 0;
    let alreadyLeader = 0, alreadyAmb = 0, newLeader = 0, newAmb = 0;
    let matchedTest = 0, unmatched = 0;

    for (const [uid, r] of latest) {
      const target = classify(r.TeamRole, r.UserRole);
      if (!target) continue;
      if (target === "team_leader") pmsLeader++; else pmsAmbassador++;

      const vid = vidByKey.get(`${source}::${uid}`);
      const prof = vid ? profByUid.get(vid) : null;
      const isTest = vid ? testSet.has(vid) : false;
      const curRole = prof?.role ?? null;
      const matched = !!vid;
      const wouldChange = matched && !isTest && curRole !== target;
      const already = matched && !isTest && curRole === target;

      if (!matched) unmatched++;
      else if (isTest) matchedTest++;
      else if (already) { if (target === "team_leader") alreadyLeader++; else alreadyAmb++; }
      else if (wouldChange) { if (target === "team_leader") newLeader++; else newAmb++; }

      const row = {
        org, source, pmsUserId: uid, name: names.get(uid) ?? "(?)",
        team: r.Team, part: r.Part, state: r.State, teamRole: r.TeamRole, userRole: r.UserRole,
        target, matched, vid: vid ?? null, vName: prof?.display_name ?? null,
        vOrg: prof?.organization_slug ?? null, curRole, isTest,
        decision: !matched ? "매칭실패" : isTest ? "테스트(제외권장)" : already ? "이미반영" : "신규반영",
      };
      allCandidates.push(row);
      if (!matched) allUnmatched.push(row);
    }

    summaryRows.push({
      org, pmsLeader, pmsAmbassador,
      alreadyReflected: alreadyLeader + alreadyAmb,
      newPlanned: newLeader + newAmb,
      newLeader, newAmb, alreadyLeader, alreadyAmb, matchedTest, unmatched,
      everLeader: everTeamLeader.size, everAmbassador: everAmbassador.size,
    });
  }
  await conn.end();

  // ── 보고 ──
  const pad = (v: any, n: number) => String(v).padEnd(n);
  const padS = (v: any, n: number) => String(v).padStart(n);

  console.log("\n=================== [Dry Run 요약] org별 (현재=최신 usersinfo 행 기준) ===================");
  console.log(pad("org", 10), "| " + padS("PMS팀장", 7), "| " + padS("PMS앰배", 7), "| " + padS("현재반영", 8), "| " + padS("신규예정", 8), "| " + padS("테스트", 6), "| " + padS("매칭실패", 8));
  console.log("-".repeat(78));
  for (const s of summaryRows) {
    console.log(pad(s.org, 10), "| " + padS(s.pmsLeader, 7), "| " + padS(s.pmsAmbassador, 7), "| " + padS(s.alreadyReflected, 8), "| " + padS(s.newPlanned, 8), "| " + padS(s.matchedTest, 6), "| " + padS(s.unmatched, 8));
  }
  console.log("-".repeat(78));
  const tot = summaryRows.reduce((a, s) => ({
    pmsLeader: a.pmsLeader + s.pmsLeader, pmsAmbassador: a.pmsAmbassador + s.pmsAmbassador,
    alreadyReflected: a.alreadyReflected + s.alreadyReflected, newPlanned: a.newPlanned + s.newPlanned,
    matchedTest: a.matchedTest + s.matchedTest, unmatched: a.unmatched + s.unmatched,
  }), { pmsLeader: 0, pmsAmbassador: 0, alreadyReflected: 0, newPlanned: 0, matchedTest: 0, unmatched: 0 });
  console.log(pad("합계", 10), "| " + padS(tot.pmsLeader, 7), "| " + padS(tot.pmsAmbassador, 7), "| " + padS(tot.alreadyReflected, 8), "| " + padS(tot.newPlanned, 8), "| " + padS(tot.matchedTest, 6), "| " + padS(tot.unmatched, 8));

  console.log("\n  세부(신규예정 = 팀장+앰배서더):");
  for (const s of summaryRows)
    console.log(`   - ${s.org}: 신규 팀장 ${s.newLeader} / 신규 앰배서더 ${s.newAmb} · 이미반영(팀장 ${s.alreadyLeader}/앰배 ${s.alreadyAmb}) · (참고)과거포함 팀장 ${s.everLeader}/앰배 ${s.everAmbassador}`);

  console.log("\n=================== [신규 반영 예정 대상자] ===================");
  const planned = allCandidates.filter((c) => c.decision === "신규반영");
  for (const c of planned)
    console.log(`  [${c.org}] PMS#${c.pmsUserId} ${c.name} (${c.team}/${c.part}, State=${c.state}) ${c.teamRole ?? ""}${c.userRole ? "/" + c.userRole : ""} → ${c.target} | Vraxium=${c.vName}(${c.curRole ?? "null"})`);
  if (planned.length === 0) console.log("  (없음)");

  console.log("\n=================== [이미 반영됨] ===================");
  const already = allCandidates.filter((c) => c.decision === "이미반영");
  for (const c of already) console.log(`  [${c.org}] ${c.name} → ${c.target} (현재 role=${c.curRole})`);
  if (already.length === 0) console.log("  (없음)");

  console.log("\n=================== [테스트 계정 매칭(백필 제외 권장)] ===================");
  const tests = allCandidates.filter((c) => c.decision === "테스트(제외권장)");
  for (const c of tests) console.log(`  [${c.org}] PMS#${c.pmsUserId} ${c.name} → ${c.target} | Vraxium(test)=${c.vName}(${c.curRole ?? "null"})`);
  if (tests.length === 0) console.log("  (없음)");

  console.log("\n=================== [매칭 실패(PMS 역할 있으나 Vraxium 미존재)] ===================");
  for (const c of allUnmatched)
    console.log(`  [${c.org}] PMS#${c.pmsUserId} ${c.name} (${c.team}/${c.part}, State=${c.state}) ${c.teamRole ?? ""}${c.userRole ? "/" + c.userRole : ""} → ${c.target} | (source=${c.source}, legacy_user_id=${c.pmsUserId} 매칭 없음)`);
  if (allUnmatched.length === 0) console.log("  (없음)");

  console.log("\n=================== [기타 역할(매핑 대상 아님 — 참고)] ===================");
  // 매핑 대상 외 역할(매니저/운영진/관리자/채널관리자 등) 최신행 기준 분포.
  console.log("  (TeamRole/UserRole 중 팀장·앰배서더 외 값은 백필 대상 아님 — 위 발견 단계 distinct 참고)");
}

main().catch((e) => { console.error(e); process.exit(1); });
