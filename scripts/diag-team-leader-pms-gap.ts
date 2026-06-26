/** READ-ONLY 조사: 팀장.xlsx 의 팀장(운영진)이 PMS(운영진 DB)에는 있으나 현재 프로젝트(Supabase)에
 *  없는 케이스를 전수 교차검증. 절대 INSERT/UPDATE 없음 — SELECT + 메모리 집계만.
 *
 *  매핑: hrdb→encre · oranke→oranke · olympus→phalanx (lib/pmsMigration).
 *  브리지: users(source_system, legacy_user_id=PMS UserId). 보조 3중키(이름+생년+연락처).
 *  run: tsx --env-file=.env.local scripts/diag-team-leader-pms-gap.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";

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
const ORG_TO_SRC: Record<string, string> = { encre: "hrdb", oranke: "oranke", phalanx: "olympus" };
const norm = (s: any) => String(s ?? "").replace(/\s+/g, "").trim();
const digits = (s: any) => String(s ?? "").replace(/\D/g, "");

async function main() {
  const parsed: any[] = JSON.parse(readFileSync(
    "C:/Users/vanua/AppData/Local/Temp/claude/C--Users-vanua-OneDrive-Desktop-vraxium-admin/a74700c3-49f4-44f3-ae4b-13ccbe8321b8/scratchpad/parsed.json",
    "utf8",
  ));

  // Excel 고유 (org, team, leaderName) — half/team 으로 PMS 팀 매칭 보조.
  const uniqLeaders = new Map<string, { org: string; name: string; teams: Set<string> }>();
  for (const r of parsed) {
    if (!r.leader) continue;
    const k = `${r.org}::${norm(r.leader)}`;
    const e = uniqLeaders.get(k) ?? { org: r.org, name: String(r.leader).trim(), teams: new Set<string>() };
    if (r.team) e.teams.add(String(r.team).trim());
    uniqLeaders.set(k, e);
  }

  // ── PMS 로드 (3 소스) ──
  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  type PmsPerson = {
    src: string; userId: number; name: string; school: string | null; major: string | null;
    birth: string | null; gender: string | null; contact: string | null; mail: string | null;
    state: string | null; team: string | null; teamRole: string | null; userRole: string | null; level: string | null;
  };
  // src → (normName → PmsPerson[])
  const pmsByName: Record<string, Map<string, PmsPerson[]>> = {};
  for (const src of ["hrdb", "oranke", "olympus"]) {
    pmsByName[src] = new Map();
    const users = await q(`SELECT UserId,Name,School,Major,BirthDay,Gender,Contact,mail FROM ${src}.users`);
    const info = await q(`SELECT UserID,State,Team,TeamRole,UserRole,Level,Week FROM ${src}.usersinfo`);
    const latestInfo = new Map<number, any>();
    for (const r of info) { const c = latestInfo.get(r.UserID); if (!c || Number(r.Week || 0) >= Number(c.Week || 0)) latestInfo.set(r.UserID, r); }
    for (const u of users) {
      const inf = latestInfo.get(u.UserId) ?? {};
      const p: PmsPerson = {
        src, userId: u.UserId, name: String(u.Name ?? "").trim(), school: u.School, major: u.Major,
        birth: u.BirthDay, gender: u.Gender, contact: u.Contact, mail: u.mail,
        state: inf.State ?? null, team: inf.Team ?? null, teamRole: inf.TeamRole ?? null,
        userRole: inf.UserRole ?? null, level: inf.Level ?? null,
      };
      const k = norm(u.Name);
      const arr = pmsByName[src].get(k) ?? [];
      arr.push(p);
      pmsByName[src].set(k, arr);
    }
  }
  await conn.end();

  // ── Supabase 로드 ──
  const sbUsers = await sbAll("users?select=id,source_system,legacy_user_id");
  const bridge = new Map<string, string>(); // `${src}:${legacy}` → user_id
  for (const u of sbUsers) if (u.source_system && u.legacy_user_id != null) bridge.set(`${u.source_system}:${u.legacy_user_id}`, u.id);
  const profs = await sbAll("user_profiles?select=user_id,display_name,organization_slug,birth_date,contact_phone,contact_email,school_name,department_name");
  const profByUid = new Map(profs.map((p) => [p.user_id, p]));
  const profByOrgName = new Map<string, any[]>();
  for (const p of profs) { const k = `${p.organization_slug ?? ""}::${norm(p.display_name)}`; const a = profByOrgName.get(k) ?? []; a.push(p); profByOrgName.set(k, a); }
  const test = new Set((await sbAll("test_user_markers?select=user_id")).map((t) => t.user_id));
  const memUserIds = new Set((await sbAll("user_memberships?select=user_id")).map((m) => m.user_id));

  // ── 교차검증 ──
  type Rec = {
    org: string; src: string; name: string; teams: string[];
    pmsLeader: PmsPerson | null; pmsAllSameName: number;
    status: string; // MIGRATED | MISSING | NAMESAKE_WRONG | NO_PMS | NOT_OPERATOR_IN_PMS
    sbUserId: string | null; sbVia: string | null;
    tablesPresent?: { users: boolean; profile: boolean; membership: boolean };
  };
  const recs: Rec[] = [];

  for (const [, e] of uniqLeaders) {
    const src = ORG_TO_SRC[e.org];
    const cands = (pmsByName[src]?.get(norm(e.name)) ?? []);
    // 팀장/운영진 우선 + Excel 팀명과 Team 일치 우선.
    const isOp = (p: PmsPerson) => p.teamRole === "팀장" || p.userRole === "운영진" || p.state === "운영진";
    const teamMatch = (p: PmsPerson) => p.team && [...e.teams].some((t) => norm(t) === norm(p.team));
    const sorted = cands.slice().sort((a, b) => {
      const s = (Number(teamMatch(b)) - Number(teamMatch(a))) || (Number(isOp(b)) - Number(isOp(a)));
      return s;
    });
    const leader = sorted.find(isOp) ?? sorted[0] ?? null;

    let status = "NO_PMS";
    let sbUserId: string | null = null;
    let sbVia: string | null = null;
    let tablesPresent: Rec["tablesPresent"];

    if (leader) {
      if (!isOp(leader)) status = "NOT_OPERATOR_IN_PMS";
      // 1) 브리지 매칭
      const bridged = bridge.get(`${src}:${leader.userId}`);
      if (bridged) { sbUserId = bridged; sbVia = "bridge"; }
      // 2) 3중키(이름+생년6+연락처 끝4) 보조
      if (!sbUserId) {
        const b6 = digits(leader.birth).slice(-6);
        const c4 = digits(leader.contact).slice(-4);
        for (const p of profByOrgName.get(`${e.org}::${norm(leader.name)}`) ?? []) {
          const pb6 = digits(p.birth_date).slice(-6);
          const pc4 = digits(p.contact_phone).slice(-4);
          if (b6 && pb6 === b6 && (!c4 || pc4 === c4)) { sbUserId = p.user_id; sbVia = "tripleKey"; break; }
        }
      }
      if (sbUserId) {
        status = isOp(leader) ? "MIGRATED" : "NOT_OPERATOR_IN_PMS";
      } else {
        // Supabase 에 동일 org+이름 operating 크루가 있나? (있으면 namesake 오연결 위험)
        const sameName = (profByOrgName.get(`${e.org}::${norm(leader.name)}`) ?? []).filter((p) => !test.has(p.user_id));
        status = isOp(leader) ? (sameName.length > 0 ? "NAMESAKE_WRONG" : "MISSING") : "NOT_OPERATOR_IN_PMS";
      }
      // 테이블 존재 여부 (브리지 기준)
      if (bridged) tablesPresent = { users: true, profile: profByUid.has(bridged), membership: memUserIds.has(bridged) };
      else tablesPresent = { users: false, profile: false, membership: false };
    }

    recs.push({
      org: e.org, src, name: e.name, teams: [...e.teams],
      pmsLeader: leader, pmsAllSameName: cands.length, status, sbUserId, sbVia, tablesPresent,
    });
  }

  // ── 요약 ──
  const by: Record<string, number> = {};
  for (const r of recs) by[r.status] = (by[r.status] ?? 0) + 1;
  console.log("=== 팀장.xlsx 고유 (org,팀장) 교차검증 요약 ===");
  console.log(`총 ${recs.length}건`);
  console.log(JSON.stringify(by, null, 2));

  const missing = recs.filter((r) => r.status === "MISSING" || r.status === "NAMESAKE_WRONG");
  console.log(`\n=== [요구#1·2·6] PMS 운영진이나 현재 프로젝트에 없음(이관 후보): ${missing.length}명 ===`);
  for (const r of missing) {
    const p = r.pmsLeader!;
    console.log(`  [${r.org}/${r.src}] ${r.name}  PMS UserId=${p.userId} School=${p.school} Major=${p.major} State=${p.state} Team=${p.team} TeamRole=${p.teamRole}  status=${r.status} (Excel팀:${r.teams.join("·")})`);
  }

  console.log(`\n=== [요구#3] 누락자 테이블 상태(전부 미존재 예상) ===`);
  for (const r of missing) console.log(`  ${r.org} ${r.name}: users=${r.tablesPresent?.users} profile=${r.tablesPresent?.profile} membership=${r.tablesPresent?.membership}`);

  const namesake = recs.filter((r) => r.status === "NAMESAKE_WRONG");
  if (namesake.length) {
    console.log(`\n=== [중요] 동명이인 오연결 위험(현재 잘못 연결된 케이스 포함): ${namesake.length}명 ===`);
    for (const r of namesake) {
      const p = r.pmsLeader!;
      const sn = (profByOrgName.get(`${r.org}::${norm(r.name)}`) ?? []).filter((x) => !test.has(x.user_id));
      console.log(`  ${r.org} ${r.name}: PMS운영진=UserId ${p.userId}(${p.school}) ↔ 현재DB 동명 operating=${sn.map((x) => `${x.user_id.slice(0,8)}(${x.school_name})`).join(",")}`);
    }
  }

  // NO_PMS / NOT_OPERATOR 도 표시(이관 불가/대상아님 구분).
  const noPms = recs.filter((r) => r.status === "NO_PMS");
  console.log(`\n=== PMS 에도 동일 이름 없음(이관 불가): ${noPms.length}명 ===`);
  console.log("  " + noPms.map((r) => `${r.org}/${r.name}`).join(", "));

  writeFileSync("claudedocs/team-leader-pms-gap.json", JSON.stringify(recs, null, 2));
  console.log("\n(상세 JSON: claudedocs/team-leader-pms-gap.json) — READ-ONLY, 쓰기 없음");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
