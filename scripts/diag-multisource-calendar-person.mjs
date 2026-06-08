// 시스템 간 ① 동일 주차 confirmStar/공표 차이 ② 동일인 교집합 (read-only)
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

const env = readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const conn = await mysql.createConnection({
  host: get("MYSQL_HOST"), port: Number(get("MYSQL_PORT") ?? 3306),
  user: get("MYSQL_USER"), password: get("MYSQL_PASSWORD"),
  dateStrings: true, ssl: { rejectUnauthorized: false },
});

const [thr] = await conn.query(`
  SELECT CAST(o.StartDate AS CHAR) AS s, o.confirmStar AS o_thr, h.confirmStar AS h_thr, l.confirmStar AS l_thr,
         o.IsPublic AS oPub, h.IsPublic AS hPub, l.IsPublic AS lPub
  FROM oranke.weekssettings o
  JOIN hrdb.weekssettings h ON DATE(h.StartDate)=DATE(o.StartDate)
  LEFT JOIN olympus.weekssettings l ON DATE(l.StartDate)=DATE(o.StartDate)
  ORDER BY o.StartDate DESC LIMIT 15`);
console.log("동일 시작일 주차 confirmStar (최근 15):");
for (const r of thr)
  console.log(`  ${String(r.s).slice(0, 10)}: oranke=${r.o_thr} hrdb=${r.h_thr} olympus=${r.l_thr} | pub o/h/l=${r.oPub}/${r.hPub}/${r.lPub}`);

const [[diff]] = await conn.query(`
  SELECT COUNT(*) AS total, SUM(o.confirmStar <> h.confirmStar) AS oh_diff,
         SUM(o.IsPublic <> h.IsPublic) AS oh_pub_diff
  FROM oranke.weekssettings o JOIN hrdb.weekssettings h ON DATE(h.StartDate)=DATE(o.StartDate)`);
console.log(`겹치는 주차 ${diff.total}개 중 oranke≠hrdb: threshold ${diff.oh_diff}개 · 공표 ${diff.oh_pub_diff}개`);

const [[grid]] = await conn.query(`
  SELECT (SELECT COUNT(DISTINCT DATE(StartDate)) FROM oranke.weekssettings) AS o,
         (SELECT COUNT(DISTINCT DATE(StartDate)) FROM hrdb.weekssettings) AS h,
         (SELECT COUNT(DISTINCT DATE(StartDate)) FROM olympus.weekssettings) AS l,
         (SELECT COUNT(*) FROM (SELECT DISTINCT DATE(StartDate) d FROM oranke.weekssettings) a
            JOIN (SELECT DISTINCT DATE(StartDate) d FROM hrdb.weekssettings) b ON a.d=b.d) AS oh`);
console.log(`주차 시작일 그리드: oranke ${grid.o} / hrdb ${grid.h} / olympus ${grid.l} / oranke∩hrdb ${grid.oh}`);

for (const [a, b] of [["oranke", "hrdb"], ["oranke", "olympus"], ["hrdb", "olympus"]]) {
  const [[x]] = await conn.query(`
    SELECT COUNT(*) AS n FROM ${a}.users ua JOIN ${b}.users ub
    ON ua.Name=ub.Name AND ua.BirthDay=ub.BirthDay AND ua.BirthDay IS NOT NULL AND ua.BirthDay<>''`);
  console.log(`동일인(이름+생일) ${a} ∩ ${b}: ${x.n}명`);
}
const [[ax]] = await conn.query(`
  SELECT COUNT(*) AS n FROM oranke.users ua JOIN oranke.usersinfo ia ON ia.UserID=ua.UserId
  JOIN hrdb.users ub ON ua.Name=ub.Name AND ua.BirthDay=ub.BirthDay AND ua.BirthDay<>''
  JOIN hrdb.usersinfo ib ON ib.UserID=ub.UserId
  WHERE ia.State NOT IN ('졸업','활동정지') AND ib.State NOT IN ('졸업','활동정지')`);
console.log(`활동자 간 동일인 oranke ∩ hrdb: ${ax.n}명`);

await conn.end();
