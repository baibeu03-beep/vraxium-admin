// READ-ONLY probe: olympus usersinfo 스키마 + 권원중(253)/권희윤(259) 샘플로 "UserWeek" 실체 확인.
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
  const q = async (s: string, p: any[] = []) => (await conn.query(s, p))[0] as any[];
  const cols = await q(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='olympus' AND TABLE_NAME='usersinfo' ORDER BY ORDINAL_POSITION`);
  console.log("usersinfo 컬럼:", cols.map((c) => c.COLUMN_NAME).join(", "));
  for (const lg of [253, 259]) {
    const rows = await q(`SELECT * FROM olympus.usersinfo WHERE UserID=? ORDER BY Week`, [lg]);
    console.log(`\n■ usersinfo UserID=${lg} (${rows.length}행)`);
    for (const r of rows) console.log("  ", JSON.stringify(r));
    const ua = await q(`SELECT COUNT(*) n, COUNT(DISTINCT CONCAT(Season,'|',SeasonWeek)) dw, SUM(IsActive=1) act FROM olympus.useractivities WHERE UserId=?`, [lg]);
    const ma = await q(`SELECT COUNT(*) n, COUNT(DISTINCT CONCAT(Season,'|',SeasonWeek)) dw, SUM(IsActive=1) act FROM olympus.manageractivities WHERE UserId=?`, [lg]);
    console.log(`  useractivities: ${JSON.stringify(ua[0])} · manageractivities: ${JSON.stringify(ma[0])}`);
    const seasons = await q(`SELECT Season, COUNT(*) n, SUM(IsActive=1) act FROM olympus.useractivities WHERE UserId=? GROUP BY Season ORDER BY Season`, [lg]);
    console.log(`  ua Season 분포:`, seasons.map((s) => `${s.Season}=${s.n}(act${s.act})`).join(" "));
  }
  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
