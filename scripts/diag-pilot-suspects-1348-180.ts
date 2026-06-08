/**
 * pilot 보류 재검증 — hrdb 1348 이유나 · olympus 180 선우은교 (read-only, write 0).
 *
 *   npx tsx scripts/diag-pilot-suspects-1348-180.ts
 *
 * 확인: State/UserRole/Team/Part · 최근 pointlogs(보정일 vs 원본 ActivityTime vs createtime)
 *   · 최근 useractivities/manageractivities · last activity 원본 행 · 본인 활동 여부
 *   · createtime 폴백 오염 여부 · 동명이인/연락처 매칭 오류 가능성.
 */
import { readFileSync, writeFileSync } from "fs";
import mysql from "mysql2/promise";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const OUT = "claudedocs/diag-pilot-suspects-20260607.json";
const TARGETS = [
  { src: "hrdb", uid: 1348, name: "이유나" },
  { src: "olympus", uid: 180, name: "선우은교" },
];

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"),
    port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"),
    password: envGet("MYSQL_PASSWORD"),
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const report: Record<string, unknown>[] = [];
  for (const t of TARGETS) {
    const { src, uid } = t;
    const [[info]] = (await conn.query(
      `SELECT i.State, i.UserRole, i.TeamRole, i.Team, i.Part, i.Week, i.Level,
              CAST(i.StartDate AS CHAR) AS StartDate
       FROM ${src}.usersinfo i WHERE i.UserID = ?`,
      [uid],
    )) as [any[], unknown];

    // 최근 pointlogs 5행 — 보정일·원본 ActivityTime·createtime·로그 내용 전부
    const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                       WHEN YEAR(ActivityTime) = 1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
    const [logs] = (await conn.query(
      `SELECT LogNum, code, log, Info, Star, Shield, IsDeleted,
              CAST(ActivityTime AS CHAR) AS ActivityTime, CAST(createtime AS CHAR) AS createtime,
              CAST(${CORR} AS CHAR) AS corrected
       FROM ${src}.pointlogs WHERE UserID = ? ORDER BY ${CORR} DESC, LogNum DESC LIMIT 8`,
      [uid],
    )) as [any[], unknown];

    // 전체 pointlogs 요약 + createtime 폴백 행 수
    const [[logStat]] = (await conn.query(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN YEAR(ActivityTime) = 1 THEN 1 ELSE 0 END) AS createtimeFallback,
              MAX(CAST(${CORR} AS CHAR)) AS lastCorrected,
              MAX(CAST(createtime AS CHAR)) AS lastCreate
       FROM ${src}.pointlogs WHERE UserID = ?`,
      [uid],
    )) as [any[], unknown];

    // 활동행
    const acts: Record<string, unknown> = {};
    for (const table of ["useractivities", "manageractivities"]) {
      const [[a]] = (await conn.query(
        `SELECT COUNT(*) AS n, MAX(CAST(COALESCE(EndDate, StartDate) AS CHAR)) AS last
         FROM ${src}.${table} WHERE UserId = ?`,
        [uid],
      )) as [any[], unknown];
      acts[table] = { rows: Number(a.n), last: a.last ? String(a.last).slice(0, 10) : null };
    }

    report.push({
      target: `${src} ${uid} ${t.name}`,
      usersinfo: info,
      pointlogSummary: {
        totalRows: Number(logStat.n),
        createtimeFallbackRows: Number(logStat.createtimeFallback),
        lastCorrected: String(logStat.lastCorrected ?? "").slice(0, 10),
        lastCreatetime: String(logStat.lastCreate ?? "").slice(0, 10),
      },
      recentPointlogs: logs.map((r: any) => ({
        LogNum: r.LogNum,
        corrected: String(r.corrected).slice(0, 10),
        ActivityTime: String(r.ActivityTime).slice(0, 19),
        createtime: String(r.createtime).slice(0, 19),
        usedCreatetimeFallback: String(r.ActivityTime).startsWith("0001"),
        code: r.code,
        log: String(r.log ?? "").slice(0, 60),
        Info: String(r.Info ?? "").slice(0, 60),
        Star: r.Star,
        Shield: r.Shield,
      })),
      activities: acts,
    });
  }
  await conn.end();
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  for (const r of report) {
    console.log(`\n══ ${r.target} ══`);
    const i = r.usersinfo as any;
    console.log(`State=${i.State} UserRole=${i.UserRole} TeamRole=${i.TeamRole} Team=${i.Team}/${i.Part} Week=${i.Week} Level=${i.Level} Start=${String(i.StartDate).slice(0, 10)}`);
    const s = r.pointlogSummary as any;
    console.log(`pointlogs ${s.totalRows}행 (createtime 폴백 ${s.createtimeFallbackRows}) | lastCorrected=${s.lastCorrected} lastCreatetime=${s.lastCreatetime}`);
    const a = r.activities as any;
    console.log(`useractivities ${a.useractivities.rows}행 last=${a.useractivities.last} | manageractivities ${a.manageractivities.rows}행 last=${a.manageractivities.last}`);
    console.log("최근 로그:");
    for (const l of (r.recentPointlogs as any[]).slice(0, 5)) {
      console.log(`  #${l.LogNum} corr=${l.corrected} AT=${l.ActivityTime} CT=${l.createtime} 폴백=${l.usedCreatetimeFallback} code=${l.code} Star=${l.Star} Shield=${l.Shield} log='${l.log}'`);
    }
  }
  console.log("\n→", OUT);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
