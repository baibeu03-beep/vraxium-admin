// ===================================================================
// PMS usersinfo 역할(팀장/앰배서더) → Vraxium user_profiles.role 백필.
//   기본 = DRY-RUN(읽기 전용, write 없음). 실제 반영은 `--apply` 플래그.
//
// 대상(승인 범위): 최신 usersinfo 행이 State='운영진' 이고 역할이 팀장/앰배서더 인 사용자 중
//   (source_system, legacy_user_id=PMS UserID) 복합키로 Vraxium 매칭 + 비테스트 + 현재 role IS NULL.
//   매핑: TeamRole='팀장' → 'team_leader' · (TeamRole='앰배서더' OR UserRole='앰배서더') → 'ambassador'.
//
// 안전장치:
//   - role 이 이미 non-null 이면 UPDATE 하지 않고 skip(보고). UPDATE 는 `.is('role', null)` 가드.
//   - 반영 후 대상자 weekly-card snapshot 을 stale 표시만(markWeeklyCardsSnapshotStaleMany).
//     강제 재계산 없음 — 기존 lazy recompute 경로 위임.
//   - 졸업 동문(미이관)은 매칭 실패로 자동 제외.
//
// 실행:
//   DRY-RUN : npx tsx --env-file=.env.local scripts/apply-pms-role-backfill.ts
//   APPLY   : npx tsx --env-file=.env.local scripts/apply-pms-role-backfill.ts --apply
// ===================================================================
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { type PmsSourceSystem } from "@/lib/pmsMigration";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { markWeeklyCardsSnapshotStaleMany } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");

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
const OPERATOR_STATE = "운영진"; // 승인된 백필 범위: 현재 운영진만.

type RoleTarget = "team_leader" | "ambassador";
function classify(teamRole: string | null, userRole: string | null): RoleTarget | null {
  const tr = (teamRole ?? "").trim();
  const ur = (userRole ?? "").trim();
  if (tr === "팀장") return "team_leader";
  if (tr === "앰배서더" || ur === "앰배서더") return "ambassador";
  return null;
}

type Cand = {
  org: string; source: PmsSourceSystem; pmsUserId: number; name: string;
  team: string; part: string; state: string; teamRole: string | null; userRole: string | null;
  target: RoleTarget; vid: string; vName: string | null; curRole: string | null; isTest: boolean;
};

async function main() {
  console.log(`\n*** PMS 역할 백필 — 모드: ${APPLY ? "APPLY(실제 반영)" : "DRY-RUN(읽기 전용)"} ***\n`);

  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  const vUsers = await sbAll("users?select=id,legacy_user_id,source_system");
  const vProfiles = await sbAll("user_profiles?select=user_id,display_name,role,organization_slug");
  const testSet = new Set((await sbAll("test_user_markers?select=user_id")).map((t) => t.user_id));
  const profByUid = new Map(vProfiles.map((p) => [p.user_id, p]));
  const vidByKey = new Map<string, string>();
  for (const u of vUsers) {
    if (u.source_system == null || u.legacy_user_id == null) continue;
    vidByKey.set(`${u.source_system}::${Number(u.legacy_user_id)}`, u.id);
  }

  const candidates: Cand[] = [];
  const skippedNonNull: Cand[] = [];
  const perOrg = new Map<string, { team_leader: number; ambassador: number }>();

  for (const { source, org } of ORG_ORDER) {
    const db = SOURCE_DB[source];
    const ui = await q(`SELECT InfoID,UserID,Team,Part,State,UserRole,TeamRole FROM \`${db}\`.usersinfo`);
    const names = new Map<number, string>(
      (await q(`SELECT UserId,Name FROM \`${db}\`.users`)).map((r: any) => [r.UserId, (r.Name || "").trim()]),
    );
    const latest = new Map<number, any>();
    for (const r of ui) { const c = latest.get(r.UserID); if (!c || Number(r.InfoID) > Number(c.InfoID)) latest.set(r.UserID, r); }

    perOrg.set(org, { team_leader: 0, ambassador: 0 });
    for (const [uid, r] of latest) {
      // 승인 범위: 현재 운영진(State='운영진') 만.
      if (String(r.State ?? "").trim() !== OPERATOR_STATE) continue;
      const target = classify(r.TeamRole, r.UserRole);
      if (!target) continue;
      const vid = vidByKey.get(`${source}::${uid}`);
      if (!vid) continue; // 매칭 실패(미이관 동문 등) — 제외.
      if (testSet.has(vid)) continue; // 테스트 제외.
      const prof = profByUid.get(vid);
      const curRole = prof?.role ?? null;
      const cand: Cand = {
        org, source, pmsUserId: uid, name: names.get(uid) ?? "(?)",
        team: r.Team, part: r.Part, state: r.State, teamRole: r.TeamRole, userRole: r.UserRole,
        target, vid, vName: prof?.display_name ?? null, curRole, isTest: false,
      };
      if (curRole !== null) { skippedNonNull.push(cand); continue; } // 이미 role 있음 → skip.
      candidates.push(cand);
      perOrg.get(org)![target]++;
    }
  }
  await conn.end();

  // ── 반영 전 dry-run 표 ──
  console.log("=================== [반영 계획] org별 ===================");
  const pad = (v: any, n: number) => String(v).padEnd(n);
  const padS = (v: any, n: number) => String(v).padStart(n);
  console.log(pad("org", 10), "| " + padS("team_leader", 12), "| " + padS("ambassador", 11), "| " + padS("합계", 6));
  console.log("-".repeat(48));
  let totL = 0, totA = 0;
  for (const { org } of ORG_ORDER) {
    const c = perOrg.get(org)!;
    totL += c.team_leader; totA += c.ambassador;
    console.log(pad(org, 10), "| " + padS(c.team_leader, 12), "| " + padS(c.ambassador, 11), "| " + padS(c.team_leader + c.ambassador, 6));
  }
  console.log("-".repeat(48));
  console.log(pad("합계", 10), "| " + padS(totL, 12), "| " + padS(totA, 11), "| " + padS(totL + totA, 6));
  console.log(`\n  반영 예정 = ${candidates.length}명 · 충돌 skip(role 이미 있음) = ${skippedNonNull.length}명`);

  console.log("\n=================== [반영 대상자 목록] ===================");
  for (const c of candidates)
    console.log(`  [${c.org}] PMS#${c.pmsUserId} ${c.name} (${c.team}/${c.part}) ${c.teamRole ?? ""}${c.userRole ? "/" + c.userRole : ""} → role='${c.target}' | Vraxium=${c.vName}(role:null) uid=${c.vid}`);

  if (skippedNonNull.length > 0) {
    console.log("\n=================== [충돌 skip — role 이미 non-null(덮어쓰지 않음)] ===================");
    for (const c of skippedNonNull)
      console.log(`  [${c.org}] ${c.name} 현재 role='${c.curRole}' (PMS=${c.target}) → skip`);
  }

  if (!APPLY) {
    console.log("\n*** DRY-RUN 종료 — write 없음. 실제 반영하려면 `--apply` 플래그로 재실행하세요. ***");
    return;
  }

  // ── APPLY: role 이 여전히 null 인 경우에만 UPDATE ──
  console.log("\n=================== [APPLY 실행] ===================");
  const appliedIds: string[] = [];
  const raceSkipped: Cand[] = [];
  for (const c of candidates) {
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .update({ role: c.target })
      .eq("user_id", c.vid)
      .is("role", null) // null 인 경우에만 — 동시성/덮어쓰기 방지.
      .select("user_id,role");
    if (error) { console.log(`  ✗ ${c.name} UPDATE 실패: ${error.message}`); continue; }
    if ((data ?? []).length === 1) { appliedIds.push(c.vid); }
    else { raceSkipped.push(c); } // 그사이 role 이 채워짐 → skip.
  }
  console.log(`  UPDATE affected = ${appliedIds.length}건 · race-skip = ${raceSkipped.length}건`);

  // org별 affected 재집계(검증).
  const { data: after } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,role,organization_slug")
    .in("user_id", appliedIds.length ? appliedIds : ["00000000-0000-0000-0000-000000000000"]);
  const byOrg = new Map<string, { team_leader: number; ambassador: number }>();
  for (const r of (after ?? []) as any[]) {
    const o = byOrg.get(r.organization_slug) ?? { team_leader: 0, ambassador: 0 };
    if (r.role === "team_leader" || r.role === "ambassador") o[r.role as RoleTarget]++;
    byOrg.set(r.organization_slug, o);
  }
  console.log("  org별 실제 반영:");
  for (const { org } of ORG_ORDER) {
    const o = byOrg.get(org) ?? { team_leader: 0, ambassador: 0 };
    console.log(`   - ${org}: team_leader ${o.team_leader} / ambassador ${o.ambassador}`);
  }

  // ── snapshot stale 표시(강제 재계산 없음) ──
  const { count: snapRows } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true })
    .in("user_id", appliedIds.length ? appliedIds : ["00000000-0000-0000-0000-000000000000"]);
  console.log(`\n  snapshot 보유 대상자 행 = ${snapRows ?? 0}건 → stale 표시(lazy recompute 위임)`);
  await markWeeklyCardsSnapshotStaleMany(appliedIds);
  console.log("  ✓ markWeeklyCardsSnapshotStaleMany 완료 (강제 재계산 없음)");

  console.log(`\n*** APPLY 완료 — 반영 ${appliedIds.length}명, 충돌/race skip ${skippedNonNull.length + raceSkipped.length}명 ***`);
}

main().catch((e) => { console.error(e); process.exit(1); });
