// PMS 조직 후속 진단 (read-only): 클럽/조직 차원 개념 존재 여부 + 브리지 96명 미매칭 원인
//   node scripts/diag-pms-org-followup.mjs
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

const env = readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sbUrl = get("NEXT_PUBLIC_SUPABASE_URL");
const sbKey = get("SUPABASE_SERVICE_ROLE_KEY");
const SH = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
const sbq = async (p) => {
  const res = await fetch(`${sbUrl}/rest/v1/${p}`, { headers: SH });
  if (!res.ok) throw new Error(`${p} → ${res.status} ${await res.text()}`);
  return res.json();
};

const conn = await mysql.createConnection({
  host: get("MYSQL_HOST"), port: Number(get("MYSQL_PORT") ?? 3306),
  user: get("MYSQL_USER"), password: get("MYSQL_PASSWORD"), database: get("MYSQL_DATABASE"),
  dateStrings: true, ssl: { rejectUnauthorized: false },
});

// ── 팀/파트 사전 테이블 전수 (클럽 상위 개념 유무) ──
console.log("══ teamnames 전수 ══");
const [tn] = await conn.query("SELECT * FROM teamnames");
console.log(JSON.stringify(tn, null, 1));
console.log("\n══ partnames 전수 ══");
const [pn] = await conn.query("SELECT * FROM partnames LIMIT 100");
console.log(JSON.stringify(pn.slice(0, 100)));
console.log("\n══ teampartlist 전수 ══");
const [tpl] = await conn.query("SELECT * FROM teampartlist LIMIT 100");
console.log(JSON.stringify(tpl));

// ── club_weekly_report 구조 + 표본 (클럽 식별자?) ──
console.log("\n══ club_weekly_report 컬럼 ══");
const [cw] = await conn.query("SHOW COLUMNS FROM club_weekly_report");
console.log(cw.map((c) => `${c.Field}(${c.Type})`).join(" "));
const [cwr] = await conn.query("SELECT * FROM club_weekly_report ORDER BY 1 DESC LIMIT 3");
console.log(JSON.stringify(cwr));

// ── 전 테이블명 목록 (club/org 차원 테이블 유무 한눈에) ──
console.log("\n══ 전 테이블 목록 ══");
const [tabs] = await conn.query("SHOW TABLES");
console.log(tabs.map((t) => Object.values(t)[0]).join(" "));

// ── 브리지 124명 분해: 테스터 vs 실사용자, 미매칭 96명의 정체 ──
console.log("\n══ 브리지 124명 분해 ══");
const users = await sbq("users?select=id,legacy_user_id&legacy_user_id=lt.100000000&limit=1000");
const markers = await sbq("test_user_markers?select=user_id&limit=1000");
const markerSet = new Set(markers.map((m) => m.user_id));
const testers = users.filter((u) => markerSet.has(u.id));
const real = users.filter((u) => !markerSet.has(u.id));
console.log(`  브리지 124명 = 테스터 ${testers.length} + 비테스터 ${real.length}`);
const realIds = real.map((u) => u.legacy_user_id).sort((a, b) => a - b);
console.log(`  비테스터 legacy ids: ${realIds.join(",")}`);
const [found] = await conn.query(
  `SELECT UserID FROM usersinfo WHERE UserID IN (${realIds.map(() => "?").join(",")})`, realIds);
const foundSet = new Set(found.map((r) => Number(r.UserID)));
const notInPms = realIds.filter((id) => !foundSet.has(id));
console.log(`  PMS usersinfo 존재: ${foundSet.size}/${realIds.length} — 부재: ${notInPms.join(",") || "없음"}`);

// 테스터 legacy id 범위 (합성인지 PMS 충돌인지)
const tIds = testers.map((u) => u.legacy_user_id).sort((a, b) => a - b);
console.log(`  테스터 legacy id 범위: ${tIds[0]} ~ ${tIds.at(-1)}`);
const [tFound] = await conn.query(
  `SELECT COUNT(*) AS n FROM usersinfo WHERE UserID IN (${tIds.map(() => "?").join(",")})`, tIds);
console.log(`  테스터 legacy id 가 PMS usersinfo 에도 존재(충돌): ${tFound[0].n}건`);

// ── Vraxium 전체 org 분포 (비교 기준) ──
const profs = await sbq("user_profiles?select=organization_slug&limit=2000");
const dist = new Map();
for (const p of profs) dist.set(p.organization_slug ?? "NULL", (dist.get(p.organization_slug ?? "NULL") ?? 0) + 1);
console.log(`\n  Vraxium user_profiles org 분포: ${[...dist.entries()].map(([k, n]) => `${k}:${n}`).join(" ")}`);

// 비테스터 브리지 34명의 org 재확인 + 비브리지 실사용자 org 분포
const realProf = await sbq(`user_profiles?select=user_id,organization_slug&user_id=in.(${real.map((u) => u.id).join(",")})`);
const rd = new Map();
for (const p of realProf) rd.set(p.organization_slug ?? "NULL", (rd.get(p.organization_slug ?? "NULL") ?? 0) + 1);
console.log(`  비테스터 브리지 org 분포: ${[...rd.entries()].map(([k, n]) => `${k}:${n}`).join(" ")}`);

await conn.end();
