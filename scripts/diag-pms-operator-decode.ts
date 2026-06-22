/**
 * READ-ONLY: 운영진/파트장/앰배서더 per-week 인코딩 정밀 — 디코드 규칙 확정용.
 *   운영진 신호가 있는 행의 (UserLevel, UserTeam, UserPart) 조합 distinct + 빈도.
 */
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

async function main() {
  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  for (const db of ["oranke", "hrdb", "olympus"]) {
    console.log(`\n========== ${db} — 운영진/파트장/앰배서더 신호행 조합 ==========`);
    const rows = await q(
      `SELECT UserLevel, UserTeam, UserPart, COUNT(*) c
       FROM \`${db}\`.useractivities
       WHERE UserTeam LIKE '%운영진%' OR UserPart LIKE '%파트장%' OR UserPart LIKE '%앰배서더%'
          OR UserLevel LIKE '%파트장%' OR UserLevel LIKE '%에이전트%' OR UserLevel LIKE '%운영%'
       GROUP BY UserLevel, UserTeam, UserPart ORDER BY c DESC LIMIT 40`,
    );
    for (const r of rows) {
      console.log(`  ${String(r.c).padStart(4)} | lvl=${JSON.stringify(r.UserLevel)} team=${JSON.stringify(r.UserTeam)} part=${JSON.stringify(r.UserPart)}`);
    }
    // 팀장 신호 — 어디에?
    const tl = await q(
      `SELECT UserLevel, UserTeam, UserPart, COUNT(*) c FROM \`${db}\`.useractivities
       WHERE UserTeam LIKE '%팀장%' OR UserPart LIKE '%팀장%' OR UserLevel LIKE '%팀장%'
          OR UserTeam LIKE '%클럽%' OR UserPart LIKE '%클럽%'
       GROUP BY UserLevel,UserTeam,UserPart ORDER BY c DESC LIMIT 15`,
    );
    console.log(`  -- 팀장/클럽 신호: ${tl.length ? "" : "(없음)"}`);
    for (const r of tl) console.log(`     ${r.c} | lvl=${JSON.stringify(r.UserLevel)} team=${JSON.stringify(r.UserTeam)} part=${JSON.stringify(r.UserPart)}`);
  }

  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
