/**
 * READ-ONLY: PMS 주차단위 직책 복원 가능성 — useractivities / manageractivities 의
 *   UserLevel/UserPart/UserRole/TeamRole 분포로 6단계 직책 복원 가능 여부 판정.
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
    console.log(`\n========== ${db} ==========`);

    // useractivities 스키마 + 샘플
    try {
      const cols = await q(`DESCRIBE \`${db}\`.useractivities`);
      console.log(`useractivities 컬럼: ${cols.map((c: any) => `${c.Field}(${c.Type})`).join(", ")}`);
      const cnt = (await q(`SELECT COUNT(*) c FROM \`${db}\`.useractivities`))[0].c;
      console.log(`  행수: ${cnt}`);
      const s = await q(`SELECT * FROM \`${db}\`.useractivities ORDER BY 1 LIMIT 2`);
      for (const r of s) console.log(`  ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`useractivities ✗ ${(e as Error).message}`);
    }

    // manageractivities UserLevel/UserPart distinct
    try {
      const lv = await q(`SELECT UserLevel, COUNT(*) c FROM \`${db}\`.manageractivities GROUP BY UserLevel ORDER BY c DESC`);
      console.log(`manageractivities.UserLevel: ${JSON.stringify(lv.map((r: any) => [r.UserLevel, r.c]))}`);
      const seasons = await q(`SELECT DISTINCT Season FROM \`${db}\`.manageractivities ORDER BY Season`);
      console.log(`manageractivities.Season distinct: ${JSON.stringify(seasons.map((r: any) => r.Season))}`);
    } catch (e) {
      console.log(`manageractivities distinct ✗ ${(e as Error).message}`);
    }

    // usersinfo 의 UserRole/TeamRole/Level distinct (현재 직책 단서)
    try {
      const tr = await q(`SELECT TeamRole, COUNT(*) c FROM \`${db}\`.usersinfo GROUP BY TeamRole ORDER BY c DESC`);
      console.log(`usersinfo.TeamRole: ${JSON.stringify(tr.map((r: any) => [r.TeamRole, r.c]))}`);
      const ur = await q(`SELECT UserRole, COUNT(*) c FROM \`${db}\`.usersinfo GROUP BY UserRole ORDER BY c DESC`);
      console.log(`usersinfo.UserRole: ${JSON.stringify(ur.map((r: any) => [r.UserRole, r.c]))}`);
      const lv = await q(`SELECT Level, COUNT(*) c FROM \`${db}\`.usersinfo GROUP BY Level ORDER BY c DESC`);
      console.log(`usersinfo.Level: ${JSON.stringify(lv.map((r: any) => [r.Level, r.c]))}`);
    } catch (e) {
      console.log(`usersinfo distinct ✗ ${(e as Error).message}`);
    }
  }

  // useractivities 의 직책 관련 컬럼 분포 (oranke)
  console.log(`\n========== oranke useractivities 직책컬럼 분포 ==========`);
  try {
    const cols = await q(`DESCRIBE \`oranke\`.useractivities`);
    const fields = cols.map((c: any) => c.Field as string);
    for (const f of fields.filter((f) => /level|role|part|team|season|week/i.test(f))) {
      const d = await q(`SELECT \`${f}\`, COUNT(*) c FROM \`oranke\`.useractivities GROUP BY \`${f}\` ORDER BY c DESC LIMIT 15`);
      console.log(`  ${f}: ${JSON.stringify(d.map((r: any) => [r[f], r.c]))}`);
    }
  } catch (e) {
    console.log(`✗ ${(e as Error).message}`);
  }

  await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
