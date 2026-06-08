// 감사 이상치 3건 원인 실측 (read-only):
//   A) 2023-spring FLIP 1095 — threshold vs 당시 points 수준
//   B) 2024-spring 귀속실패 541 — pms SeasonWeek vs 라이브 week_number 커버리지
//   C) adjustment 음수 대형치 — 졸업자 잔액 패턴
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

const env = readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sbUrl = get("NEXT_PUBLIC_SUPABASE_URL");
const sbKey = get("SUPABASE_SERVICE_ROLE_KEY");
const SH = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
const sbq = async (p) => {
  const r = await fetch(`${sbUrl}/rest/v1/${p}`, { headers: SH });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const conn = await mysql.createConnection({
  host: get("MYSQL_HOST"), port: Number(get("MYSQL_PORT") ?? 3306),
  user: get("MYSQL_USER"), password: get("MYSQL_PASSWORD"), database: get("MYSQL_DATABASE"),
  dateStrings: true, ssl: { rejectUnauthorized: false },
});

// ── A) 2023-spring: 라이브 threshold + 당시 주차 net Star 분포 ──
console.log("══ A) 2023-spring threshold vs 당시 points ══");
const w23 = await sbq("weeks?select=week_number,start_date,end_date,check_threshold&season_key=eq.2023-spring&order=week_number");
console.log("  라이브 weeks:", w23.map((w) => `W${w.week_number}(${w.start_date},thr${w.check_threshold ?? "NULL→30"})`).join(" "));
// pms weekssettings 의 2023 봄 원본 (confirmStar)
const [ws] = await conn.query(
  `SELECT Season, week, CAST(StartDate AS CHAR) AS s, confirmStar, IsPublic FROM weekssettings
   WHERE StartDate >= '2023-01-01' AND StartDate < '2023-07-01' ORDER BY StartDate`);
console.log("  pms weekssettings 2023 상반기:", ws.map((r) => `${r.Season}W${r.week}(${String(r.s).slice(0,10)},cs${r.confirmStar})`).join(" "));
// 당시 사용자×주차 net Star 분포 (2023-spring 기간 pointlogs)
const lo = w23[0]?.start_date, hi = w23.at(-1)?.end_date;
const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                   WHEN YEAR(ActivityTime) = 1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
const [dist] = await conn.query(
  `SELECT pts, COUNT(*) AS n FROM (
     SELECT UserID, YEARWEEK(${CORR}, 3) AS yw, SUM(Star) AS pts
     FROM pointlogs WHERE ${CORR} BETWEEN ? AND ? GROUP BY UserID, yw
   ) t GROUP BY pts ORDER BY pts`, [lo, hi]);
const buckets = new Map();
for (const r of dist) {
  const p = Number(r.pts);
  const b = p < 5 ? "<5" : p < 10 ? "5~9" : p < 20 ? "10~19" : p < 30 ? "20~29" : p < 37 ? "30~36" : "37+";
  buckets.set(b, (buckets.get(b) ?? 0) + Number(r.n));
}
console.log("  당시 사용자×주차 net Star 분포:", JSON.stringify(Object.fromEntries(buckets)));

// ── B) 2024-spring 귀속실패: SeasonWeek 커버리지 ──
console.log("\n══ B) 2024-spring SeasonWeek 커버리지 ══");
const w24 = await sbq("weeks?select=week_number,start_date&season_key=eq.2024-spring&order=week_number");
console.log("  라이브 week_numbers:", JSON.stringify(w24.map((w) => w.week_number)));
for (const t of ["useractivities", "manageractivities"]) {
  const [rows] = await conn.query(
    `SELECT SeasonWeek, COUNT(*) AS n, SUM(IsActive=1) AS act FROM ${t}
     WHERE REPLACE(Season,' ','') IN ('봄','봄시즌') AND YEAR(StartDate)=2024
     GROUP BY SeasonWeek ORDER BY SeasonWeek`);
  console.log(`  ${t} 2024 봄 SeasonWeek 분포:`, rows.map((r) => `W${r.SeasonWeek}:${r.n}(인정${r.act})`).join(" "));
}

// ── C) adjustment 음수 대형치 — 졸업자 잔액 ──
console.log("\n══ C) 음수 대형치 사용자 잔액 패턴 ══");
const [grad] = await conn.query(
  `SELECT i.State, COUNT(*) AS n, AVG(p.Star) AS avgStar, MIN(p.Star) AS minStar, MAX(p.Star) AS maxStar
   FROM usersinfo i JOIN userspoint p ON p.UserID = i.UserID GROUP BY i.State`);
console.log("  State별 잔액 Star:", grad.map((r) => `${r.State}: n=${r.n} avg=${Number(r.avgStar).toFixed(1)} min=${r.minStar} max=${r.maxStar}`).join(" | "));
const [sample] = await conn.query(
  `SELECT u.UserId, i.State, p.Star, p.Shield FROM users u
   JOIN usersinfo i ON i.UserID=u.UserId JOIN userspoint p ON p.UserID=u.UserId
   WHERE u.UserId IN (472, 442, 557, 608, 417)`);
console.log("  top 음수 5명 잔액:", JSON.stringify(sample));

await conn.end();
