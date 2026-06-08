/**
 * 284명 이관 대상 — 활동 최근성 실측 (read-only, write 0).
 *
 *   npx tsx scripts/diag-284-activity-recency.ts
 *
 * 대상 정의(현행 선정 기준 그대로): usersinfo.State IN ('일반','운영진'),
 *   ORANKE 916·873 제외. last activity = max(최근 pointlog 보정일, 최근 활동행 일자).
 */
import { readFileSync, writeFileSync } from "fs";
import mysql from "mysql2/promise";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const SOURCES = ["oranke", "hrdb", "olympus"] as const;
const TODAY = "2026-06-07";
const M6 = "2025-12-07";
const M12 = "2025-06-07";
const Y2025 = "2025-01-01";
const OUT = "claudedocs/diag-284-activity-recency-20260607.json";

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"),
    port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"),
    password: envGet("MYSQL_PASSWORD"),
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const CORR = (a: string) => `CASE WHEN YEAR(${a}.ActivityTime) BETWEEN 20 AND 99 THEN DATE(${a}.ActivityTime + INTERVAL 2000 YEAR)
    WHEN YEAR(${a}.ActivityTime) = 1 THEN DATE(${a}.createtime) ELSE DATE(${a}.ActivityTime) END`;

  const perSource: Record<string, any> = {};
  const detail: Array<Record<string, unknown>> = [];
  for (const src of SOURCES) {
    const excl = src === "oranke" ? " AND u.UserId NOT IN (916,873)" : "";
    const [targets] = (await conn.query(`
      SELECT u.UserId, u.Name, i.State FROM ${src}.users u JOIN ${src}.usersinfo i ON i.UserID=u.UserId
      WHERE i.State IN ('일반','운영진')${excl}`)) as [any[], unknown];
    const ids = new Set(targets.map((t: any) => Number(t.UserId)));

    // 최근 pointlog (보정일 기준 — 2020 이전/이후 노이즈는 보정식이 처리)
    const [logs] = (await conn.query(`
      SELECT p.UserID AS uid, MAX(CAST(${CORR("p")} AS CHAR)) AS lastLog
      FROM ${src}.pointlogs p GROUP BY p.UserID`)) as [any[], unknown];
    const lastLog = new Map(logs.map((r: any) => [Number(r.uid), String(r.lastLog).slice(0, 10)]));

    // 최근 활동행 (useractivities + manageractivities — StartDate/EndDate max)
    const lastAct = new Map<number, string>();
    for (const t of ["useractivities", "manageractivities"]) {
      const [acts] = (await conn.query(`
        SELECT UserId AS uid, MAX(CAST(COALESCE(EndDate, StartDate) AS CHAR)) AS lastAct
        FROM ${src}.${t} WHERE StartDate IS NOT NULL GROUP BY UserId`)) as [any[], unknown];
      for (const r of acts) {
        const uid = Number(r.uid);
        const d = String(r.lastAct).slice(0, 10);
        if (d > (lastAct.get(uid) ?? "")) lastAct.set(uid, d);
      }
    }

    let over6m = 0, over12m = 0, noneSince2025 = 0, within12m = 0, noActivityAtAll = 0;
    for (const t of targets) {
      const uid = Number(t.UserId);
      const l1 = lastLog.get(uid) ?? "";
      const l2 = lastAct.get(uid) ?? "";
      let last = l1 > l2 ? l1 : l2;
      if (last > TODAY) last = last; // 미래 노이즈는 그대로 표기 (보정식 통과분)
      if (!last) {
        noActivityAtAll++;
        over6m++;
        over12m++;
        noneSince2025++;
        detail.push({ src, uid, name: t.Name, state: t.State, last: null });
        continue;
      }
      if (last < M6) over6m++;
      if (last < M12) over12m++;
      if (last < Y2025) noneSince2025++;
      if (last >= M12) within12m++;
      if (last < M12) detail.push({ src, uid, name: t.Name, state: t.State, last });
    }
    perSource[src] = {
      targets: targets.length,
      over6m,
      over12m,
      noneSince2025,
      within12m,
      noActivityAtAll,
    };
    console.log(
      `[${src}] 대상 ${targets.length} | 6개월+ 무활동 ${over6m} | 12개월+ 무활동 ${over12m} | 2025-01-01 이후 무활동 ${noneSince2025} | 최근 12개월 내 활동 ${within12m} | 기록 전무 ${noActivityAtAll}`,
    );
    void ids;
  }
  await conn.end();

  const sum = (k: string) => SOURCES.reduce((s, x) => s + perSource[x][k], 0);
  const totals = {
    targets: sum("targets"),
    over6m: sum("over6m"),
    over12m: sum("over12m"),
    noneSince2025: sum("noneSince2025"),
    within12m: sum("within12m"),
    noActivityAtAll: sum("noActivityAtAll"),
  };
  writeFileSync(OUT, JSON.stringify({ generatedAt: TODAY, criteria: "State IN (일반,운영진) − oranke 916/873 (활동일 기준 미사용)", totals, perSource, staleDetail: detail }, null, 1));
  console.log("합계:", JSON.stringify(totals));
  console.log("→", OUT);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
