// APPLY (ingest): weekly-league 회원명부 정합 데이터 적재.
//   node scripts/apply-weekly-league-member-roster.mjs
// 신규 3테이블에만 write. user_week_statuses/uwp/snapshot/개인카드 무변경. 멱등 upsert + rollback 파일.
// 전제: db/migrations/2026-06-10_weekly_league_member_roster.sql 적용(테이블 생성) 완료.
import { readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
const env = readFileSync(".env.local", "utf8");
const g = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sbUrl = g("NEXT_PUBLIC_SUPABASE_URL"), sbKey = g("SUPABASE_SERVICE_ROLE_KEY");
const SH = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json" };
async function sbAll(p) { const A = []; for (let f = 0; ; f += 1000) { const s = p.includes("?") ? "&" : "?"; const r = await fetch(`${sbUrl}/rest/v1/${p}${s}limit=1000&offset=${f}`, { headers: SH }); if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`); const j = await r.json(); A.push(...j); if (j.length < 1000) break; } return A; }
async function tableExists(t) { const r = await fetch(`${sbUrl}/rest/v1/${t}?select=*&limit=1`, { headers: SH }); return r.ok; }
async function countOf(t) { const r = await fetch(`${sbUrl}/rest/v1/${t}?select=*`, { headers: { ...SH, Prefer: "count=exact", Range: "0-0" } }); return Number((r.headers.get("content-range") || "*/0").split("/")[1]); }
async function upsert(t, rows, onConflict) { for (let i = 0; i < rows.length; i += 200) { const chunk = rows.slice(i, i + 200); const url = `${sbUrl}/rest/v1/${t}` + (onConflict ? `?on_conflict=${onConflict}` : ""); const r = await fetch(url, { method: "POST", headers: { ...SH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(chunk) }); if (!r.ok) throw new Error(`upsert ${t} chunk ${i}: ${r.status} ${await r.text()}`); } }

const conn = await mysql.createConnection({ host: g("MYSQL_HOST"), port: Number(g("MYSQL_PORT") ?? 3306), user: g("MYSQL_USER"), password: g("MYSQL_PASSWORD"), database: g("MYSQL_DATABASE"), dateStrings: true, ssl: { rejectUnauthorized: false } });
const q = async (s) => (await conn.query(s))[0];

// 0) 전제 테이블 확인
for (const t of ["crew_personal_rest_periods", "operator_markers", "weekly_league_roster_orgs"]) {
  if (!(await tableExists(t))) { console.error(`❌ 테이블 ${t} 없음 — db/migrations/2026-06-10_weekly_league_member_roster.sql 먼저 적용 필요.`); await conn.end(); process.exit(1); }
}
console.log("✅ 신규 3테이블 존재 확인");

// baseline (무변경 검증용)
const before = { uws: await countOf("user_week_statuses"), uwp: await countOf("user_weekly_points") };

const test = new Set((await sbAll("test_user_markers?select=user_id")).map((t) => t.user_id));
const um = await sbAll("users?select=id,legacy_user_id,source_system");

// ── 1) crew_personal_rest_periods : restdates 전 org 공용 적재 ──
const ORGS = [{ org: "encre", src: "hrdb" }, { org: "oranke", src: "oranke" }, { org: "phalanx", src: "olympus" }];
const restRows = [];
for (const { org, src } of ORGS) {
  const l2u = new Map(um.filter((u) => u.source_system === src && u.legacy_user_id != null).map((u) => [u.legacy_user_id, u.id]));
  const rd = await q(`SELECT DateId,UserId,CAST(StartDate AS CHAR) s,CAST(EndDate AS CHAR) e FROM ${src}.restdates WHERE StartDate>='2026-02-01' AND StartDate<='2026-07-01'`);
  for (const r of rd) { const uid = l2u.get(r.UserId); if (uid && !test.has(uid)) restRows.push({ user_id: uid, organization_slug: org, start_date: r.s.slice(0, 10), end_date: r.e.slice(0, 10), source_system: src, legacy_user_id: r.UserId, source_rest_id: r.DateId }); }
}
await upsert("crew_personal_rest_periods", restRows, "source_system,source_rest_id");
console.log(`1) crew_personal_rest_periods upsert ${restRows.length}행 (encre/oranke/phalanx 공용)`);

// ── 2) operator_markers : encre 운영진(PMS State='운영진') ──
const opLg = new Set((await q(`SELECT UserID FROM hrdb.usersinfo WHERE State='운영진'`)).map((r) => r.UserID));
const u2lH = new Map(um.filter((u) => u.source_system === "hrdb" && u.legacy_user_id != null).map((u) => [u.id, u.legacy_user_id]));
const encreProf = (await sbAll(`user_profiles?select=user_id,display_name&organization_slug=eq.encre&status=in.(active,seasonal_rest,weekly_rest)`)).filter((p) => !test.has(p.user_id));
const opRows = encreProf.filter((p) => { const lg = u2lH.get(p.user_id); return lg != null && opLg.has(lg); }).map((p) => ({ user_id: p.user_id, organization_slug: "encre", source_system: "hrdb", legacy_user_id: u2lH.get(p.user_id), note: "PMS usersinfo.State=운영진" }));
await upsert("operator_markers", opRows, "user_id");
console.log(`2) operator_markers upsert ${opRows.length}행 (encre 운영진, 기대 12)`);

// ── 3) 이유나 → test_user_markers ──
const yuna = encreProf.find((p) => p.display_name === "이유나" && u2lH.get(p.user_id) == null);
if (yuna) { const yLegacy = um.find((u) => u.id === yuna.user_id)?.legacy_user_id ?? 100000000; await upsert("test_user_markers", [{ user_id: yuna.user_id, seed_batch_id: "2026-06-10_weekly_league_exclude", legacy_user_id: yLegacy, user_type: "operator_admin_only", note: "weekly-league 정합: PMS 운영진·admin sentinel" }], "user_id"); console.log(`3) test_user_markers + 이유나 (${yuna.user_id}, legacy=${yLegacy})`); }
else console.log("3) 이유나 미발견 — skip");

// ── 4) weekly_league_roster_orgs : encre 게이트 ON ──
await upsert("weekly_league_roster_orgs", [{ organization_slug: "encre", enabled: true, note: "회원명부+restdates 모드" }], "organization_slug");
console.log("4) weekly_league_roster_orgs + encre (enabled)");

// ── 검증 ──
const after = { uws: await countOf("user_week_statuses"), uwp: await countOf("user_weekly_points") };
const counts = { rest: await countOf("crew_personal_rest_periods"), op: await countOf("operator_markers"), gate: await countOf("weekly_league_roster_orgs") };
console.log("\n검증:");
console.log(`  crew_personal_rest_periods ${counts.rest} · operator_markers ${counts.op} · gate ${counts.gate}`);
console.log(`  uws 무변경: ${before.uws}→${after.uws} ${before.uws === after.uws ? "✅" : "⚠"} · uwp ${before.uwp}→${after.uwp} ${before.uwp === after.uwp ? "✅" : "⚠"}`);

writeFileSync("claudedocs/apply-weekly-league-member-roster-rollback-20260610.json", JSON.stringify({
  generatedAt: "2026-06-10", restIds: restRows.map((r) => r.source_rest_id), operatorUserIds: opRows.map((r) => r.user_id), yunaUserId: yuna?.user_id ?? null,
  rollback: "DELETE FROM crew_personal_rest_periods; DELETE FROM operator_markers; DELETE FROM weekly_league_roster_orgs WHERE organization_slug='encre'; DELETE FROM test_user_markers WHERE user_id='<yuna>'; (또는 테이블 DROP)",
}, null, 2));
console.log("📄 rollback: claudedocs/apply-weekly-league-member-roster-rollback-20260610.json");
await conn.end();
