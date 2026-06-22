/**
 * READ-ONLY: PMS 운영진/파트장/앰배서더 주차 신호를 가진 UserId 가 Vraxium 으로 이관됐는지 확인.
 *   (이관 결과에 operating_* 가 0인 게 join 버그인지, 실제 미이관인지 판정)
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
    const { data } = await sb.from(table).select(sel).range(f, f + 999);
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const users = await sbAll("users", "id,source_system,legacy_user_id");
  const profiles = new Map((await sbAll("user_profiles", "user_id,display_name")).map((p) => [p.user_id, p.display_name]));
  const vidByKey = new Map<string, string>();
  for (const u of users) if (u.source_system && u.legacy_user_id != null) vidByKey.set(`${u.source_system}::${Number(u.legacy_user_id)}`, u.id);

  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  for (const [source, db] of Object.entries(SOURCE_DB)) {
    const rows = await q(
      `SELECT DISTINCT UserId FROM \`${db}\`.useractivities
       WHERE UserPart LIKE '%앰배서더%' OR UserPart LIKE '%팀장%' OR UserPart LIKE '%파트장%'
          OR UserTeam LIKE '%운영진%' OR UserLevel LIKE '%파트장%' OR UserLevel LIKE '%에이전트%'`,
    );
    let migrated = 0; const migratedNames: string[] = [];
    for (const r of rows as any[]) {
      const vid = vidByKey.get(`${source}::${Number(r.UserId)}`);
      if (vid) { migrated++; migratedNames.push(profiles.get(vid) ?? `(${r.UserId})`); }
    }
    console.log(`${source}: 운영진/파트장 주차 보유 PMS UserId=${rows.length} · 그중 Vraxium 이관=${migrated}`);
    if (migratedNames.length) console.log(`   이관된 운영진주차 보유자: ${migratedNames.join(", ")}`);
  }
  await conn.end();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
