// "활동자 99명" 선정 기준 검증 (read-only): State 단일 필터의 실제 의미 + 교차 분포
//   node scripts/diag-active-selection-basis.mjs
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
const q = async (sql, params = []) => (await conn.query(sql, params))[0];

console.log("══ 1) 모수 정합: users ↔ usersinfo ↔ userspoint ══");
const [[counts]] = [await q(`
  SELECT (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM usersinfo) AS usersinfo,
         (SELECT COUNT(*) FROM users u LEFT JOIN usersinfo i ON i.UserID=u.UserId WHERE i.UserID IS NULL) AS users_without_info,
         (SELECT COUNT(*) FROM usersinfo i LEFT JOIN users u ON u.UserId=i.UserID WHERE u.UserId IS NULL) AS info_orphan,
         (SELECT COUNT(*) FROM users u LEFT JOIN userspoint p ON p.UserID=u.UserId WHERE p.UserID IS NULL) AS users_without_point`)];
console.log(JSON.stringify(counts));

console.log("\n══ 2) State 전수 분포 (usersinfo.State — 필터 기준 컬럼) ══");
const st = await q(`SELECT State, COUNT(*) AS n FROM usersinfo GROUP BY State ORDER BY n DESC`);
for (const r of st) console.log(`  State='${r.State}': ${r.n}명`);

console.log("\n══ 3) State × Team 오염값 교차 (휴식/중단 표기는 Team 컬럼에 있음) ══");
const cross = await q(`
  SELECT i.State, i.Team, COUNT(*) AS n FROM usersinfo i
  WHERE REPLACE(i.Team,' ','') IN ('시즌전체휴식','22여름시즌전체휴식','장기휴식','활동중단','테스트','안녕','')
     OR i.Team IS NULL
  GROUP BY i.State, i.Team ORDER BY i.State, n DESC`);
for (const r of cross) console.log(`  State='${r.State}' × Team='${r.Team}': ${r.n}명`);

console.log("\n══ 4) State × UserRole 교차 ══");
const ur = await q(`SELECT State, UserRole, COUNT(*) AS n FROM usersinfo GROUP BY State, UserRole ORDER BY State, n DESC`);
for (const r of ur) console.log(`  State='${r.State}' × UserRole='${r.UserRole}': ${r.n}명`);

console.log("\n══ 5) 활동자 99명(State NOT IN 졸업·활동정지)의 Team 분포 ══");
const t99 = await q(`
  SELECT i.Team, COUNT(*) AS n FROM usersinfo i
  WHERE i.State NOT IN ('졸업','활동정지') GROUP BY i.Team ORDER BY n DESC`);
for (const r of t99) console.log(`  Team='${r.Team}': ${r.n}명`);

console.log("\n══ 6) 활동자 99명의 최근 활동 실재성 (마지막 pointlog·활동 주차) ══");
const recency = await q(`
  SELECT b.bucket, COUNT(*) AS n FROM (
    SELECT i.UserID,
      CASE WHEN MAX(pl.t) >= '2026-05-01' THEN '2026-05 이후'
           WHEN MAX(pl.t) >= '2026-03-01' THEN '2026-03~04'
           WHEN MAX(pl.t) >= '2026-01-01' THEN '2026-01~02'
           WHEN MAX(pl.t) IS NULL THEN '로그 없음'
           ELSE '2025 이전' END AS bucket
    FROM usersinfo i
    LEFT JOIN (SELECT UserID, MAX(CASE WHEN YEAR(ActivityTime)=1 THEN DATE(createtime) ELSE DATE(ActivityTime) END) AS t
               FROM pointlogs GROUP BY UserID) pl ON pl.UserID = i.UserID
    WHERE i.State NOT IN ('졸업','활동정지') GROUP BY i.UserID
  ) b GROUP BY b.bucket ORDER BY n DESC`);
for (const r of recency) console.log(`  ${r.bucket}: ${r.n}명`);

console.log("\n══ 7) 활동자 99명 ∩ Vraxium 매칭 상태 (이름 충돌 재검토 대상) ══");
const [actives] = [await q(`SELECT u.UserId, u.Name FROM users u JOIN usersinfo i ON i.UserID=u.UserId WHERE i.State NOT IN ('졸업','활동정지')`)];
const profiles = await sbq("user_profiles?select=display_name&limit=2000");
const profNames = new Map();
for (const p of profiles) profNames.set(p.display_name, (profNames.get(p.display_name) ?? 0) + 1);
const nameHits = actives.filter((a) => profNames.has(a.Name));
console.log(`  99명 중 Vraxium 동명 프로필 존재: ${nameHits.length}명 ${nameHits.length ? "— " + nameHits.map((a) => `${a.UserId}:${a.Name}`).join(", ") : ""}`);
// pms 내부 동명 (99명 안에서)
const dupNames = await q(`
  SELECT u.Name, COUNT(*) AS n FROM users u JOIN usersinfo i ON i.UserID=u.UserId
  WHERE i.State NOT IN ('졸업','활동정지') GROUP BY u.Name HAVING n > 1`);
console.log(`  99명 내부 동명: ${dupNames.length}건 ${dupNames.length ? JSON.stringify(dupNames) : ""}`);

await conn.end();
