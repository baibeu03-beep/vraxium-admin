/**
 * READ-ONLY: (1) team_leader 들의 per-week 직책 인코딩 확인,
 *   (2) useractivities 전체에서 운영진/파트장/에이전트 신호 빈도,
 *   (3) resume 영향 624명 중 PMS useractivities 보유(=과거 직책 복원 가능) 비율.
 */
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(G("NEXT_PUBLIC_SUPABASE_URL")!, G("SUPABASE_SERVICE_ROLE_KEY")!);
const SOURCE_DB: Record<string, string> = { oranke: "oranke", hrdb: "hrdb", olympus: "olympus" };

async function sbAll(table: string, sel: string): Promise<any[]> {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(sel).range(f, f + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  // (1) team_leader 3명 per-week
  const { data: tls } = await sb.from("user_profiles")
    .select("user_id,display_name,organization_slug").eq("role", "team_leader").limit(3);
  for (const p of (tls ?? []) as any[]) {
    const { data: u } = await sb.from("users").select("source_system,legacy_user_id").eq("id", p.user_id).maybeSingle();
    const src = (u as any)?.source_system; const lid = (u as any)?.legacy_user_id;
    console.log(`\n[team_leader] ${p.display_name}(${p.organization_slug}) src=${src} legacy=${lid}`);
    if (!src || lid == null || !SOURCE_DB[src]) { console.log("  PMS 매칭 불가"); continue; }
    const rows = await q(`SELECT Season,SeasonWeek,UserLevel,UserTeam,UserPart FROM \`${SOURCE_DB[src]}\`.useractivities WHERE UserId=${Number(lid)} ORDER BY StartDate`);
    const levels = new Set(rows.map((r: any) => `${r.UserLevel}|${r.UserTeam}|${r.UserPart}`));
    console.log(`  per-week distinct (lvl|team|part): ${JSON.stringify([...levels])}`);
  }

  // (2) 운영진/파트장/에이전트 per-week 신호 — 전체 useractivities
  console.log("\n[per-week 직책 신호 빈도 (전체 useractivities)]");
  for (const db of ["oranke", "hrdb", "olympus"]) {
    const opTeam = (await q(`SELECT COUNT(*) c FROM \`${db}\`.useractivities WHERE UserTeam LIKE '%운영진%'`))[0].c;
    const plPart = (await q(`SELECT COUNT(*) c FROM \`${db}\`.useractivities WHERE UserPart LIKE '%파트장%'`))[0].c;
    const ambPart = (await q(`SELECT COUNT(*) c FROM \`${db}\`.useractivities WHERE UserPart LIKE '%앰배서더%'`))[0].c;
    const total = (await q(`SELECT COUNT(*) c FROM \`${db}\`.useractivities`))[0].c;
    const sim = (await q(`SELECT COUNT(*) c FROM \`${db}\`.useractivities WHERE UserLevel LIKE '%심화%'`))[0].c;
    console.log(`  ${db}: total=${total} 심화=${sim} team운영진=${opTeam} part파트장=${plPart} part앰배서더=${ambPart}`);
  }

  // (3) 624 영향자 PMS 보유율
  console.log("\n[resume 영향자 PMS useractivities 보유율]");
  const vUsers = await sbAll("users", "id,source_system,legacy_user_id");
  const keyByVid = new Map<string, { src: string; lid: number }>();
  for (const u of vUsers) {
    if (u.source_system && u.legacy_user_id != null) keyByVid.set(u.id, { src: u.source_system, lid: Number(u.legacy_user_id) });
  }
  const testSet = new Set((await sbAll("test_user_markers", "user_id")).map((t) => t.user_id));
  // uws 보유 유저 (활동자)
  const uwsUsers = new Set((await sbAll("user_week_statuses", "user_id")).map((r) => r.user_id));
  const targets = [...uwsUsers].filter((u) => !testSet.has(u));

  // PMS useractivities 보유 UserId 집합 (db별)
  const haveByDb: Record<string, Set<number>> = {};
  for (const db of ["oranke", "hrdb", "olympus"]) {
    const ids = await q(`SELECT DISTINCT UserId FROM \`${db}\`.useractivities`);
    haveByDb[db] = new Set(ids.map((r: any) => Number(r.UserId)));
  }
  let matched = 0, noKey = 0, noPmsRows = 0, nonPmsOrg = 0;
  for (const uid of targets) {
    const k = keyByVid.get(uid);
    if (!k) { noKey++; continue; }
    const db = SOURCE_DB[k.src];
    if (!db) { nonPmsOrg++; continue; }
    if (haveByDb[db].has(k.lid)) matched++; else noPmsRows++;
  }
  console.log(`  대상(활동·테스트제외)=${targets.length}`);
  console.log(`  PMS useractivities 보유(과거직책 복원가능)=${matched}`);
  console.log(`  legacy키 없음(Vraxium-native)=${noKey}, 비PMS org=${nonPmsOrg}, PMS행없음=${noPmsRows}`);

  await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
