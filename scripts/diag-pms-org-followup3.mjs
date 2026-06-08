// PMS 조직 후속 진단 3 (read-only): 브리지 34명 동일인 검증 — legacy_user_id 가 진짜 pms UserId 인가?
//   node scripts/diag-pms-org-followup3.mjs
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

const users = await sbq("users?select=id,legacy_user_id&legacy_user_id=lt.100000000&limit=1000");
const markers = await sbq("test_user_markers?select=user_id&limit=1000");
const markerSet = new Set(markers.map((m) => m.user_id));
const real = users.filter((u) => !markerSet.has(u.id));
const ids = real.map((u) => u.legacy_user_id);

const profs = await sbq(`user_profiles?select=user_id,display_name,birth_date,contact_email,contact_phone,organization_slug&user_id=in.(${real.map((u) => u.id).join(",")})`);
const profByUid = new Map(profs.map((p) => [p.user_id, p]));

const [pms] = await conn.query(
  `SELECT u.UserId, u.Name, CAST(u.BirthDay AS CHAR) AS BirthDay, u.mail, u.Contact, i.Team, i.Part, i.State, i.Level
   FROM users u LEFT JOIN usersinfo i ON i.UserID = u.UserId
   WHERE u.UserId IN (${ids.map(() => "?").join(",")})`, ids);
const pmsById = new Map(pms.map((r) => [Number(r.UserId), r]));

const bd6 = (iso) => (iso ? iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10) : null);
const phone = (s) => (s ?? "").replace(/\D/g, "");

let match = 0, mismatch = 0, noProfile = 0;
console.log("══ 브리지 비테스터 34명 동일인 검증 (Vraxium ↔ PMS 같은 id) ══");
for (const u of real.sort((a, b) => a.legacy_user_id - b.legacy_user_id)) {
  const p = profByUid.get(u.id);
  const m = pmsById.get(Number(u.legacy_user_id));
  if (!p) { noProfile++; console.log(`  #${u.legacy_user_id}: Vraxium profile 부재 (PMS '${m?.Name}')`); continue; }
  const nameEq = p.display_name === m?.Name;
  const birthEq = bd6(p.birth_date) === String(m?.BirthDay ?? "");
  const phoneEq = phone(p.contact_phone) !== "" && phone(p.contact_phone) === phone(m?.Contact);
  const emailEq = (p.contact_email ?? "").toLowerCase() === String(m?.mail ?? "").toLowerCase();
  const same = nameEq && (birthEq || phoneEq || emailEq);
  same ? match++ : mismatch++;
  console.log(`  #${u.legacy_user_id}: ${same ? "✅ 동일인" : "❌ 불일치"} — vrax '${p.display_name}'(${p.birth_date ?? "-"}, ${p.organization_slug}) ↔ pms '${m?.Name}'(${m?.BirthDay}, Team=${m?.Team}/${m?.Part}, State=${m?.State}) [name=${nameEq} birth=${birthEq} phone=${phoneEq} email=${emailEq}]`);
}
console.log(`\n  요약: 동일인 ${match} / 불일치 ${mismatch} / profile 부재 ${noProfile}`);

// PMS 전체 사용자 중 졸업·활동정지 외 "일반/운영진" State 분포 → 이관 모수의 현재 상태
const [st] = await conn.query(
  "SELECT i.State, COUNT(*) AS cnt FROM usersinfo i GROUP BY i.State ORDER BY cnt DESC");
console.log("\n  PMS usersinfo State 분포(재확인): " + st.map((r) => `'${r.State}'×${r.cnt}`).join(" "));

await conn.end();
