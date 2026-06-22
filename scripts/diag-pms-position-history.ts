/**
 * READ-ONLY: PMS(MySQL) 에서 시즌/주차 단위 직책 이력 매핑이 가능한지 전수 조사.
 *   npx tsx --env-file=.env.local scripts/diag-pms-position-history.ts
 *
 *   1) usersinfo 전체 컬럼(DESCRIBE) — 날짜/시즌/주차 컬럼 유무
 *   2) 전체 테이블 목록(SHOW TABLES) — 시계열 직책/역할 테이블 후보
 *   3) UserID 별 usersinfo 행 수 분포 (이력성 데이터인지)
 *   4) 샘플 유저의 InfoID 시계열 (TeamRole/UserRole 변화 + 날짜로 보이는 컬럼)
 */
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const DBS = ["oranke", "hrdb", "olympus"];

async function main() {
  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  for (const db of DBS) {
    console.log(`\n========================= DB: ${db} =========================`);

    // (2) 테이블 목록
    let tables: any[] = [];
    try {
      tables = await q(`SHOW TABLES FROM \`${db}\``);
    } catch (e) {
      console.log(`  SHOW TABLES 실패: ${(e as Error).message}`);
      continue;
    }
    const tnames = tables.map((r) => Object.values(r)[0] as string);
    console.log(`  테이블(${tnames.length}): ${tnames.join(", ")}`);

    // 직책/역할/시즌/주차 관련 테이블 후보
    const cand = tnames.filter((t) =>
      /role|season|week|history|info|member|grade|period|term|batch|cohort/i.test(t),
    );
    console.log(`  관심 테이블 후보: ${cand.join(", ")}`);

    // (1) usersinfo DESCRIBE
    try {
      const cols = await q(`DESCRIBE \`${db}\`.usersinfo`);
      console.log(`\n  [usersinfo 컬럼]`);
      for (const c of cols) console.log(`    ${c.Field} (${c.Type})`);
    } catch (e) {
      console.log(`  usersinfo DESCRIBE 실패: ${(e as Error).message}`);
    }

    // (3) UserID 별 usersinfo 행수 분포
    try {
      const rows = await q(
        `SELECT UserID, COUNT(*) c FROM \`${db}\`.usersinfo GROUP BY UserID`,
      );
      const dist = new Map<number, number>();
      for (const r of rows) dist.set(Number(r.c), (dist.get(Number(r.c)) ?? 0) + 1);
      console.log(`\n  usersinfo UserID당 행수 분포: ${JSON.stringify([...dist.entries()].sort((a, b) => a[0] - b[0]))}`);
      console.log(`  총 UserID: ${rows.length}`);
    } catch (e) {
      console.log(`  분포 조회 실패: ${(e as Error).message}`);
    }

    // (4) 다중행 보유 UserID 샘플 — 전체 컬럼 dump (날짜/시즌 단서 탐색)
    try {
      const multi = await q(
        `SELECT UserID FROM \`${db}\`.usersinfo GROUP BY UserID HAVING COUNT(*) >= 2 LIMIT 3`,
      );
      for (const m of multi) {
        const uid = m.UserID;
        const rows = await q(
          `SELECT * FROM \`${db}\`.usersinfo WHERE UserID = ${Number(uid)} ORDER BY InfoID`,
        );
        console.log(`\n  [usersinfo UserID=${uid} 전체행 ${rows.length}개]`);
        for (const r of rows) console.log(`    ${JSON.stringify(r)}`);
      }
    } catch (e) {
      console.log(`  샘플 조회 실패: ${(e as Error).message}`);
    }
  }

  await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
