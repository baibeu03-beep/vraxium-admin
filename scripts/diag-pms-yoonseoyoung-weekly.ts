/**
 * READ-ONLY: 윤서영(encre/hrdb) + 운영진 샘플의 PMS 주차단위 직책 인코딩 실증.
 *   Vraxium user → (source_system, legacy_user_id) → PMS useractivities per-week dump.
 */
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(G("NEXT_PUBLIC_SUPABASE_URL")!, G("SUPABASE_SERVICE_ROLE_KEY")!);

const SOURCE_DB: Record<string, string> = { oranke: "oranke", hrdb: "hrdb", olympus: "olympus" };

async function main() {
  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  // Vraxium 대상자: 윤서영 + 현재 운영진(team_leader/ambassador) 2명.
  const { data: ys } = await sb.from("user_profiles")
    .select("user_id,display_name,role,organization_slug").ilike("display_name", "%윤서영%");
  const { data: ops } = await sb.from("user_profiles")
    .select("user_id,display_name,role,organization_slug")
    .in("role", ["team_leader", "ambassador"]).limit(4);
  const targets = [...(ys ?? []), ...(ops ?? [])];

  for (const p of targets as any[]) {
    const { data: u } = await sb.from("users")
      .select("source_system,legacy_user_id").eq("id", p.user_id).maybeSingle();
    const src = (u as any)?.source_system;
    const lid = (u as any)?.legacy_user_id;
    console.log(`\n══ ${p.display_name} (${p.organization_slug}, 현재role=${p.role}) → source=${src} legacy=${lid} ══`);
    if (!src || lid == null || !SOURCE_DB[src]) { console.log("  PMS 매칭 불가"); continue; }
    const db = SOURCE_DB[src];

    // 현재 usersinfo
    const ui = await q(`SELECT Team,Part,Level,State,UserRole,TeamRole,Week,StartDate FROM \`${db}\`.usersinfo WHERE UserID=${Number(lid)}`);
    console.log(`  usersinfo(현재): ${JSON.stringify(ui)}`);

    // 주차단위 useractivities
    const ua = await q(
      `SELECT Season,SeasonWeek,UserWeek,StartDate,EndDate,UserLevel,UserTeam,UserPart,IsActive
       FROM \`${db}\`.useractivities WHERE UserId=${Number(lid)} ORDER BY StartDate`,
    );
    console.log(`  useractivities ${ua.length}행:`);
    for (const r of ua) {
      console.log(`    ${r.StartDate?.slice(0,10)}~${r.EndDate?.slice(0,10)} ${String(r.Season).trim()}/${r.SeasonWeek}주(uw${r.UserWeek}) | lvl=${JSON.stringify(r.UserLevel)} team=${JSON.stringify(r.UserTeam)} part=${JSON.stringify(r.UserPart)} active=${r.IsActive}`);
    }
  }

  await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
