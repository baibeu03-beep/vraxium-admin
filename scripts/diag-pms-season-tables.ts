/**
 * READ-ONLY: PMS 시즌 단위 직책/팀 이력 테이블 후보 정밀 조사.
 *   npx tsx --env-file=.env.local scripts/diag-pms-season-tables.ts
 */
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const TABLES = [
  "seasonusers",
  "seasonteamdatas",
  "seasonchangeusers",
  "seasondates",
  "seasonrestlogs",
  "managerdatas",
  "manageractivities",
  "members",
  "graduateusers",
  "teampartlist",
];

async function main() {
  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  // oranke 중심으로 (가장 SoT 역할). 나머지는 컬럼만 빠르게.
  const db = "oranke";
  console.log(`========= DB: ${db} =========`);
  for (const t of TABLES) {
    console.log(`\n──── ${t} ────`);
    try {
      const cols = await q(`DESCRIBE \`${db}\`.${t}`);
      console.log(`  컬럼: ${cols.map((c: any) => `${c.Field}(${c.Type})`).join(", ")}`);
      const cnt = (await q(`SELECT COUNT(*) c FROM \`${db}\`.${t}`))[0].c;
      console.log(`  행수: ${cnt}`);
      const sample = await q(`SELECT * FROM \`${db}\`.${t} LIMIT 4`);
      for (const r of sample) console.log(`    ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`  ✗ ${(e as Error).message}`);
    }
  }

  // seasondates 전체 (시즌 정의 — season_key 매핑 기준)
  console.log(`\n──── ${db}.seasondates 전체 ────`);
  try {
    const all = await q(`SELECT * FROM \`${db}\`.seasondates ORDER BY 1`);
    for (const r of all) console.log(`    ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message}`);
  }

  await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
