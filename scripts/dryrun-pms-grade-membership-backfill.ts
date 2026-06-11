// ===================================================================
// READ-ONLY DRY RUN — PMS usersinfo.TeamRole(파트장/에이전트) → Vraxium
//   user_memberships.membership_level('심화(파트장)'/'심화(에이전트)') 보정 계획.
//   write 없음 · snapshot 없음 · 재계산 없음. 순수 SELECT + 메모리 집계 + 보고.
//
// 매핑(심화 크루 내부 역할 구분 — State='운영진' 과 무관):
//   TeamRole='파트장'   → membership_level='심화(파트장)'
//   TeamRole='에이전트' → membership_level='심화(에이전트)'
//
// 대상 = PMS 최신 usersinfo 행(MAX InfoID)의 TeamRole 이 파트장/에이전트 인 사용자 중:
//   · (source_system, legacy_user_id=PMS UserID) 복합키로 Vraxium 매칭 성공
//   · 비테스트(test_user_markers 제외)
//   · 졸업/미이관 제외 (졸업 = PMS State='졸업' 또는 Vraxium growth_status='graduated')
//   · 운영 계정 = 현재 user_memberships(is_current 우선) 행 보유
//
// 안전 분류(승인 판단용):
//   refine      = 현재 level 이 '심화*'(생 '심화' 등)인데 목표 하위유형과 달라 안전 보정.  ← 주 대상
//   already     = 이미 목표값과 동일 → no-op.
//   tier-change = 현재 level 이 '일반'/기타 → 등급 승급(일반→심화) 위험 → 기본 제외·별도 보고.
//   conflict    = role=team_leader/ambassador/admin 등(운영진) → 심화 크루로 강등 위험 → 제외·보고.
//   no-membership = 현재 멤버십 행 없음 → INSERT 필요(위험) → 제외·보고.
//
// team_leader/ambassador role 백필과 별개. user_profiles.role 은 건드리지 않음(membership_level 중심).
// 실행: npx tsx --env-file=.env.local scripts/dryrun-pms-grade-membership-backfill.ts
// ===================================================================
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { type PmsSourceSystem } from "@/lib/pmsMigration";

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

const SOURCE_DB: Record<PmsSourceSystem, string> = { oranke: "oranke", hrdb: "hrdb", olympus: "olympus" };
const ORG_ORDER: Array<{ source: PmsSourceSystem; org: string }> = [
  { source: "oranke", org: "oranke" },
  { source: "hrdb", org: "encre" },
  { source: "olympus", org: "phalanx" },
];
const OPERATOR_ROLES = new Set(["team_leader", "ambassador", "admin", "super_admin"]);
const GRADUATED_GROWTH = new Set(["graduated"]);

type TargetLevel = "심화(파트장)" | "심화(에이전트)";
function targetLevel(teamRole: string | null): TargetLevel | null {
  const tr = (teamRole ?? "").trim();
  if (tr === "파트장") return "심화(파트장)";
  if (tr === "에이전트") return "심화(에이전트)";
  return null;
}

type Decision = "refine" | "already" | "tier-change" | "conflict" | "no-membership" | "graduated" | "test" | "unmatched";

type Cand = {
  org: string; source: PmsSourceSystem; pmsUserId: number; name: string;
  team: string; part: string; pmsState: string; teamRole: string | null;
  target: TargetLevel; vid: string | null; vName: string | null; vGrowth: string | null;
  curRole: string | null; curLevel: string | null; hasMembership: boolean; isTest: boolean;
  decision: Decision;
};

async function main() {
  console.log("\n*** PMS 등급(파트장/에이전트) → membership_level 보정 — DRY-RUN(읽기 전용) ***\n");

  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  // Vraxium 1회 로드.
  const vUsers = await sbAll("users?select=id,legacy_user_id,source_system");
  const vProfiles = await sbAll("user_profiles?select=user_id,display_name,role,organization_slug,growth_status");
  const testSet = new Set((await sbAll("test_user_markers?select=user_id")).map((t) => t.user_id));
  const profByUid = new Map(vProfiles.map((p) => [p.user_id, p]));
  const vidByKey = new Map<string, string>();
  for (const u of vUsers) {
    if (u.source_system == null || u.legacy_user_id == null) continue;
    vidByKey.set(`${u.source_system}::${Number(u.legacy_user_id)}`, u.id);
  }
  // user_memberships(is_current 우선) 1행/사용자.
  const allMems = await sbAll("user_memberships?select=user_id,team_name,part_name,membership_level,membership_state,is_current");
  const memByUid = new Map<string, any>();
  for (const m of allMems) { const ex = memByUid.get(m.user_id); if (!ex || (m.is_current && !ex.is_current)) memByUid.set(m.user_id, m); }

  const cands: Cand[] = [];
  for (const { source, org } of ORG_ORDER) {
    const db = SOURCE_DB[source];
    const ui = await q(`SELECT InfoID,UserID,Team,Part,State,UserRole,TeamRole FROM \`${db}\`.usersinfo`);
    const names = new Map<number, string>(
      (await q(`SELECT UserId,Name FROM \`${db}\`.users`)).map((r: any) => [r.UserId, (r.Name || "").trim()]),
    );
    const latest = new Map<number, any>();
    for (const r of ui) { const c = latest.get(r.UserID); if (!c || Number(r.InfoID) > Number(c.InfoID)) latest.set(r.UserID, r); }

    for (const [uid, r] of latest) {
      const target = targetLevel(r.TeamRole);
      if (!target) continue; // 파트장/에이전트 외 무시.
      const vid = vidByKey.get(`${source}::${uid}`) ?? null;
      const prof = vid ? profByUid.get(vid) : null;
      const mem = vid ? memByUid.get(vid) : null;
      const curRole = prof?.role ?? null;
      const curLevel = mem?.membership_level ?? null;
      const pmsState = String(r.State ?? "").trim();
      const vGrowth = prof?.growth_status ?? null;
      const isTest = vid ? testSet.has(vid) : false;

      let decision: Decision;
      if (!vid) decision = "unmatched";
      else if (isTest) decision = "test";
      else if (pmsState === "졸업" || GRADUATED_GROWTH.has(String(vGrowth))) decision = "graduated";
      else if (curRole && OPERATOR_ROLES.has(curRole)) decision = "conflict";
      else if (!mem) decision = "no-membership";
      else if (curLevel === target) decision = "already";
      else if (String(curLevel ?? "").trim().startsWith("심화")) decision = "refine";
      else decision = "tier-change";

      cands.push({
        org, source, pmsUserId: uid, name: names.get(uid) ?? "(?)",
        team: r.Team, part: r.Part, pmsState, teamRole: r.TeamRole, target,
        vid, vName: prof?.display_name ?? null, vGrowth, curRole, curLevel,
        hasMembership: !!mem, isTest, decision,
      });
    }
  }
  await conn.end();

  const pad = (v: any, n: number) => String(v).padEnd(n);
  const padS = (v: any, n: number) => String(v).padStart(n);
  const DECISIONS: Decision[] = ["refine", "already", "tier-change", "conflict", "no-membership", "graduated", "test", "unmatched"];

  // ── (2) org별 대상자 수 ──
  console.log("=================== [2] org별 분류 카운트 ===================");
  console.log(pad("org", 9), "|", DECISIONS.map((d) => padS(d, 13)).join(" "));
  console.log("-".repeat(120));
  for (const { org } of ORG_ORDER) {
    const row = DECISIONS.map((d) => padS(cands.filter((c) => c.org === org && c.decision === d).length, 13));
    console.log(pad(org, 9), "|", row.join(" "));
  }
  console.log("-".repeat(120));
  console.log(pad("합계", 9), "|", DECISIONS.map((d) => padS(cands.filter((c) => c.decision === d).length, 13)).join(" "));
  const applyTargets = cands.filter((c) => c.decision === "refine");
  console.log(`\n  ▶ 실제 보정(apply) 대상 = 'refine' ${applyTargets.length}명 (already=no-op, tier-change/conflict/no-membership=승인 필요·기본 제외)`);

  // ── (3) membership_level 분포 — 전(before) / 후(after, refine 적용 가정) ──
  console.log("\n=================== [3] org별 membership_level 분포(현행 전체 비테스트) → refine 적용 후 ===================");
  for (const { org } of ORG_ORDER) {
    const orgProfs = vProfiles.filter((p) => p.organization_slug === org && !testSet.has(p.user_id));
    const before = new Map<string, number>();
    for (const p of orgProfs) {
      const lv = String(memByUid.get(p.user_id)?.membership_level ?? "(membership 없음)");
      before.set(lv, (before.get(lv) ?? 0) + 1);
    }
    const after = new Map(before);
    for (const c of applyTargets.filter((c) => c.org === org)) {
      const from = String(c.curLevel ?? "(membership 없음)");
      after.set(from, (after.get(from) ?? 0) - 1);
      after.set(c.target, (after.get(c.target) ?? 0) + 1);
    }
    const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
    console.log(`\n  [${org}]`);
    console.log("    " + pad("level", 18), padS("before", 8), padS("after", 8));
    for (const k of keys) console.log("    " + pad(k, 18), padS(before.get(k) ?? 0, 8), padS(after.get(k) ?? 0, 8));
  }

  // ── (4) 파트장/에이전트별 보정 대상자 명단(refine) ──
  console.log("\n=================== [4] 보정 대상자 명단 (refine) ===================");
  for (const tl of ["심화(파트장)", "심화(에이전트)"] as TargetLevel[]) {
    const list = applyTargets.filter((c) => c.target === tl);
    console.log(`\n  ── ${tl} : ${list.length}명 ──`);
    for (const c of list)
      console.log(`    [${c.org}] PMS#${c.pmsUserId} ${c.name} (${c.team}/${c.part}, State=${c.pmsState}) TeamRole=${c.teamRole} | Vraxium=${c.vName} curLevel='${c.curLevel}' role=${c.curRole ?? "null"} → '${tl}'`);
    if (list.length === 0) console.log("    (없음)");
  }

  // ── (5) 충돌/스킵 보고 ──
  console.log("\n=================== [5] 충돌/스킵 대상 (승인 판단 필요) ===================");
  for (const d of ["already", "tier-change", "conflict", "no-membership", "graduated", "test", "unmatched"] as Decision[]) {
    const list = cands.filter((c) => c.decision === d);
    console.log(`\n  ── ${d} : ${list.length}명 ──`);
    const show = d === "graduated" || d === "unmatched" ? list.slice(0, 20) : list;
    for (const c of show)
      console.log(`    [${c.org}] PMS#${c.pmsUserId} ${c.name} (${c.team}/${c.part}, State=${c.pmsState}) TeamRole=${c.teamRole} target='${c.target}' | Vraxium=${c.vName ?? "(미매칭)"} curLevel='${c.curLevel}' role=${c.curRole ?? "null"} growth=${c.vGrowth ?? "null"}`);
    if (list.length > show.length) console.log(`    … 외 ${list.length - show.length}명 생략`);
    if (list.length === 0) console.log("    (없음)");
  }

  console.log("\n*** DRY-RUN 종료 — write 없음. 승인 시 apply 스크립트(refine 대상 UPDATE + snapshot stale 표시)를 작성합니다. ***");
}

main().catch((e) => { console.error(e); process.exit(1); });
