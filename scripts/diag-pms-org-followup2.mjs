// PMS 조직 후속 진단 2 (read-only): usersmoreinfo/members/useraccounts + teamnames a/m/t 가설 + Vraxium 팀 사전
//   node scripts/diag-pms-org-followup2.mjs
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

const lowCard = async (table) => {
  console.log(`\n══ ${table} 컬럼 + 저카디널리티 DISTINCT ══`);
  const [cols] = await conn.query(`SHOW COLUMNS FROM ${table}`);
  console.log("  cols: " + cols.map((c) => `${c.Field}(${c.Type})`).join(" "));
  for (const c of cols) {
    if (!/char|text|enum|tinyint/i.test(c.Type)) continue;
    if (/password|token|hash/i.test(c.Field)) continue;
    const [[{ n }]] = await conn.query(`SELECT COUNT(DISTINCT \`${c.Field}\`) AS n FROM ${table}`);
    if (n <= 25) {
      const [rows] = await conn.query(
        `SELECT \`${c.Field}\` AS v, COUNT(*) AS cnt FROM ${table} GROUP BY \`${c.Field}\` ORDER BY cnt DESC`);
      console.log(`  ${c.Field} (distinct ${n}): ${rows.map((r) => `${r.v === null ? "NULL" : `'${r.v}'`}×${r.cnt}`).join(" ")}`);
    }
  }
};

await lowCard("usersmoreinfo");
await lowCard("members");

// useraccounts — 이메일 도메인 분포 (클럽 도메인 단서)
console.log("\n══ useraccounts 이메일 도메인 분포 ══");
const [uaCols] = await conn.query("SHOW COLUMNS FROM useraccounts");
console.log("  cols: " + uaCols.map((c) => `${c.Field}(${c.Type})`).join(" "));
const emailCol = uaCols.find((c) => /mail|email|account|username|id$/i.test(c.Field) && /char/i.test(c.Type))?.Field;
if (emailCol) {
  const [dom] = await conn.query(
    `SELECT LOWER(SUBSTRING_INDEX(\`${emailCol}\`, '@', -1)) AS d, COUNT(*) AS cnt
     FROM useraccounts WHERE \`${emailCol}\` LIKE '%@%' GROUP BY d ORDER BY cnt DESC LIMIT 20`);
  console.log(`  (${emailCol} 기준) ` + dom.map((r) => `${r.d}×${r.cnt}`).join(" "));
}
// members 도 이메일성 컬럼 도메인 분포
const [mCols] = await conn.query("SHOW COLUMNS FROM members");
const mEmail = mCols.find((c) => /mail|email/i.test(c.Field))?.Field;
if (mEmail) {
  const [dom] = await conn.query(
    `SELECT LOWER(SUBSTRING_INDEX(\`${mEmail}\`, '@', -1)) AS d, COUNT(*) AS cnt
     FROM members WHERE \`${mEmail}\` LIKE '%@%' GROUP BY d ORDER BY cnt DESC LIMIT 20`);
  console.log(`  members.${mEmail}: ` + dom.map((r) => `${r.d}×${r.cnt}`).join(" "));
}

// teamnames a/m/t 가설 — boards.Team 이 TeamId 코드를 쓰는지
console.log("\n══ boards.Team / boarddatas.Team DISTINCT (a/m/t 코드 가설) ══");
const [bt] = await conn.query("SELECT Team AS v, COUNT(*) AS cnt FROM boards GROUP BY Team ORDER BY cnt DESC LIMIT 25");
console.log("  boards.Team: " + bt.map((r) => `'${r.v}'×${r.cnt}`).join(" "));
const [bdt] = await conn.query("SELECT Team AS v, COUNT(*) AS cnt FROM boarddatas GROUP BY Team ORDER BY cnt DESC LIMIT 25");
console.log("  boarddatas.Team: " + bdt.map((r) => `'${r.v}'×${r.cnt}`).join(" "));

// users 테이블에도 org 성 컬럼이 있는지
console.log("\n══ users 컬럼 ══");
const [uc] = await conn.query("SHOW COLUMNS FROM users");
console.log("  " + uc.map((c) => `${c.Field}(${c.Type})`).join(" "));

// ── Vraxium 팀 사전: cluster4_teams (org 별 팀명) ──
console.log("\n══ Vraxium cluster4_teams ══");
try {
  const teams = await sbq("cluster4_teams?select=*&limit=100");
  if (teams.length) {
    const keys = Object.keys(teams[0]);
    console.log("  cols: " + keys.join(","));
    for (const t of teams) console.log("  " + JSON.stringify(t));
  } else console.log("  0행");
} catch (e) { console.log("  조회 실패: " + e.message.slice(0, 150)); }

// Vraxium org 별 멤버십 팀명 분포
console.log("\n══ Vraxium org × team_name 분포 (user_memberships ⋈ user_profiles) ══");
const profs = await sbq("user_profiles?select=user_id,organization_slug&limit=2000");
const orgByUid = new Map(profs.map((p) => [p.user_id, p.organization_slug]));
const mems = await sbq("user_memberships?select=user_id,team_name&limit=2000");
const cross = new Map();
for (const m of mems) {
  const k = `${orgByUid.get(m.user_id) ?? "?"} / '${m.team_name}'`;
  cross.set(k, (cross.get(k) ?? 0) + 1);
}
for (const [k, n] of [...cross.entries()].sort()) console.log(`  ${k}: ${n}`);

await conn.end();
