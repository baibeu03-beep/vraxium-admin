// PMS usersinfo 조직 컬럼 진단 (read-only — SELECT/SHOW 만):
//   ① usersinfo 전 컬럼 ② 저카디널리티 컬럼 DISTINCT 전수 ③ Team DISTINCT/분포
//   ④ 전 테이블 org성 컬럼명 스캔 ⑤ 기존 매칭 124명: PMS 값 ↔ Vraxium organization_slug 실증 크로스탭
//   node scripts/diag-pms-usersinfo-org.mjs
// MYSQL_* 는 .env.local 수동 파싱 (--env-file 특수문자 비밀번호 변형 함정 — dryrun-pms-1092 와 동일)
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
  host: get("MYSQL_HOST"),
  port: Number(get("MYSQL_PORT") ?? 3306),
  user: get("MYSQL_USER"),
  password: get("MYSQL_PASSWORD"),
  database: get("MYSQL_DATABASE"),
  dateStrings: true,
  ssl: { rejectUnauthorized: false },
});
const db = get("MYSQL_DATABASE");

// ════════ ① usersinfo 전 컬럼 ════════
console.log("══ ① usersinfo 컬럼 전체 ══");
const [cols] = await conn.query("SHOW FULL COLUMNS FROM usersinfo");
for (const c of cols) console.log(`  ${c.Field}\t${c.Type}\t${c.Null}\t${c.Comment || ""}`);

// ════════ ② 텍스트 컬럼 카디널리티 + 저카디널리티 DISTINCT 전수 ════════
console.log("\n══ ② 컬럼별 카디널리티 (저카디널리티는 DISTINCT 전수) ══");
const textCols = cols.filter((c) => /char|text|enum/i.test(c.Type)).map((c) => c.Field);
for (const f of textCols) {
  const [[{ n }]] = await conn.query(`SELECT COUNT(DISTINCT \`${f}\`) AS n FROM usersinfo`);
  if (n <= 40) {
    const [rows] = await conn.query(
      `SELECT \`${f}\` AS v, COUNT(*) AS cnt FROM usersinfo GROUP BY \`${f}\` ORDER BY cnt DESC`);
    console.log(`  ${f} (distinct ${n}): ${rows.map((r) => `${r.v === null ? "NULL" : `'${r.v}'`}×${r.cnt}`).join(" ")}`);
  } else {
    console.log(`  ${f} (distinct ${n}) — 고카디널리티, 생략`);
  }
}

// ════════ ③④ Team DISTINCT / 분포 (위 ②에 포함되지만 명시 출력) ════════
console.log("\n══ ③ Team × Part 크로스탭 ══");
const [tp] = await conn.query(
  "SELECT Team, Part, COUNT(*) AS cnt FROM usersinfo GROUP BY Team, Part ORDER BY Team, cnt DESC");
for (const r of tp) console.log(`  ${r.Team ?? "NULL"} / ${r.Part ?? "NULL"}: ${r.cnt}`);

// ════════ ④ 전 테이블 org성 컬럼명 스캔 + 조직명 값 스캔 ════════
console.log("\n══ ④ 전 테이블 org성 컬럼명 (information_schema) ══");
const [orgCols] = await conn.query(
  `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = ? AND (
     COLUMN_NAME REGEXP 'org|club|branch|group|division|company|crew'
     OR COLUMN_NAME REGEXP 'team|part|level'
   ) ORDER BY TABLE_NAME, COLUMN_NAME`, [db]);
for (const r of orgCols) console.log(`  ${r.TABLE_NAME}.${r.COLUMN_NAME} (${r.DATA_TYPE})`);

// Vraxium 조직 슬러그/표기 후보 문자열이 PMS 어디든 존재하는지 — usersinfo 텍스트 컬럼 한정 스캔
console.log("\n══ ④-2 usersinfo 텍스트 컬럼에서 조직명 후보 검색 ══");
const ORG_TOKENS = ["encre", "oranke", "phalanx", "앙크르", "엔크레", "앙크레", "오랑케", "팔랑크스", "팔랑스"];
for (const f of textCols) {
  const likes = ORG_TOKENS.map(() => `LOWER(\`${f}\`) LIKE ?`).join(" OR ");
  const [rows] = await conn.query(
    `SELECT \`${f}\` AS v, COUNT(*) AS cnt FROM usersinfo WHERE ${likes} GROUP BY \`${f}\``,
    ORG_TOKENS.map((t) => `%${t.toLowerCase()}%`));
  if (rows.length) console.log(`  ${f}: ${rows.map((r) => `'${r.v}'×${r.cnt}`).join(" ")}`);
}

// ════════ ⑤ 실증: 기존 매칭 124명 PMS Team/Part ↔ Vraxium organization_slug ════════
console.log("\n══ ⑤ 기존 브리지 사용자: PMS usersinfo ↔ Vraxium organization_slug 크로스탭 ══");
const users = await sbq("users?select=id,legacy_user_id&legacy_user_id=lt.100000000&limit=1000");
console.log(`  Vraxium legacy 브리지 사용자: ${users.length}명`);
const profs = await sbq(`user_profiles?select=user_id,organization_slug,current_team_name,current_part_name&user_id=in.(${users.map((u) => u.id).join(",")})`);
const profByUid = new Map(profs.map((p) => [p.user_id, p]));
const legacyIds = users.map((u) => u.legacy_user_id);
const [pmsRows] = await conn.query(
  `SELECT UserID, Team, Part, Level, State FROM usersinfo WHERE UserID IN (${legacyIds.map(() => "?").join(",")})`,
  legacyIds);
const pmsById = new Map(pmsRows.map((r) => [Number(r.UserID), r]));
console.log(`  PMS usersinfo 매칭: ${pmsRows.length}/${legacyIds.length}`);

const cross = new Map(); // "pmsTeam → vraxOrg" 카운트
let missing = 0;
for (const u of users) {
  const pms = pmsById.get(Number(u.legacy_user_id));
  const prof = profByUid.get(u.id);
  if (!pms || !prof) { missing++; continue; }
  const k = `PMS Team='${pms.Team}' → vraxium org='${prof.organization_slug}'`;
  cross.set(k, (cross.get(k) ?? 0) + 1);
}
for (const [k, n] of [...cross.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}명`);
if (missing) console.log(`  (어느 한쪽 부재 ${missing}명)`);

// 보조: PMS Team ↔ Vraxium current_team_name (Team 이 '팀'인지 직접 대조)
console.log("\n══ ⑤-2 PMS Team ↔ Vraxium current_team_name 대조 (표본 20) ══");
let i = 0;
for (const u of users) {
  const pms = pmsById.get(Number(u.legacy_user_id));
  const prof = profByUid.get(u.id);
  if (!pms || !prof) continue;
  if (i++ >= 20) break;
  console.log(`  pms#${u.legacy_user_id}: Team='${pms.Team}' Part='${pms.Part}' ↔ vrax team='${prof.current_team_name}' part='${prof.current_part_name}' org='${prof.organization_slug}'`);
}

// Vraxium 조직 슬러그 목록 (참조)
try {
  const orgs = await sbq("organizations?select=slug,name&limit=50");
  console.log(`\n  Vraxium organizations: ${orgs.map((o) => `${o.slug}(${o.name})`).join(" ")}`);
} catch (e) {
  console.log(`\n  organizations 테이블 조회 실패: ${e.message.slice(0, 120)}`);
}

await conn.end();
