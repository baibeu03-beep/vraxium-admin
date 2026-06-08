/**
 * Pilot 5명 최종 회귀 감사 (read-only) — PMS/DB/snapshot/HTTP 5층 × 10항목.
 *   npx tsx --env-file=.env.local scripts/audit-pilot5-final-regression.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const OUT = "claudedocs/audit-pilot5-final-regression-20260608.json";
const PILOT = [
  { p: "P1", src: "oranke", uid: 1092, name: "장승완" },
  { p: "P2", src: "hrdb", uid: 1463, name: "안은비" },
  { p: "P3", src: "olympus", uid: 249, name: "성채윤" },
  { p: "P4", src: "olympus", uid: 248, name: "박시은" },
  { p: "P5", src: "olympus", uid: 251, name: "정혜빈" },
] as const;
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });
  const rows: any[] = [];
  for (const t of PILOT) {
    // PMS
    const [[bal]] = (await conn.query(`SELECT Star, Shield FROM ${t.src}.userspoint WHERE UserID=?`, [t.uid])) as any;
    const [[info]] = (await conn.query(`SELECT Week, State FROM ${t.src}.usersinfo WHERE UserID=?`, [t.uid])) as any;
    const [logs] = (await conn.query(`SELECT Shield, IsDeleted FROM ${t.src}.pointlogs WHERE UserID=?`, [t.uid])) as [any[], unknown];
    const pmsPen = logs.filter((r) => r.IsDeleted === 0 && Number(r.Shield) < 0).reduce((s, r) => s - Number(r.Shield), 0);

    // DB
    const { data: u } = await sb.from("users").select("id").eq("source_system", t.src).eq("legacy_user_id", t.uid).maybeSingle();
    const uuid = (u as any).id;
    const { data: prof } = await sb.from("user_profiles").select("status,growth_status").eq("user_id", uuid).maybeSingle();
    const { data: gs } = await sb.from("user_growth_stats").select("approved_weeks,cumulative_weeks").eq("user_id", uuid).maybeSingle();
    const { data: uwp } = await sb.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", uuid).range(0, 999);
    const { data: subs } = await sb.from("cluster4_line_submissions").select("subtitle,growth_point").eq("user_id", uuid).range(0, 999);
    const { data: snap } = await sb.from("cluster4_weekly_card_snapshots").select("cards,dto_version,is_stale").eq("user_id", uuid).maybeSingle();
    const dbCheck = (uwp ?? []).reduce((s: number, r: any) => s + r.points, 0);
    const dbNet = (uwp ?? []).reduce((s: number, r: any) => s + r.advantages - r.penalty, 0);
    const dbPen = (uwp ?? []).reduce((s: number, r: any) => s + r.penalty, 0);
    const gpNonNull = (subs ?? []).filter((s: any) => s.growth_point != null).length;
    const subtitleNonNull = (subs ?? []).filter((s: any) => s.subtitle != null).length;

    // direct / HTTP / snapshot
    const direct = (await getCluster4WeeklyCardsForProfileUser(uuid)) as any[];
    const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${uuid}`, { headers: { "x-internal-api-key": envGet("INTERNAL_API_KEY")! } });
    const http = ((await res.json()).data ?? []) as any[];
    const demoRes = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${uuid}&demoUserId=${uuid}`).catch(() => null);
    const demo = demoRes && demoRes.ok ? (((await demoRes.json()).data ?? []) as any[]) : null;
    const view = (cards: any[]) => ({
      cards: cards.length,
      acc: cards.length ? Math.max(...cards.map((c) => c.accumulatedApprovedWeeks ?? 0)) : 0,
      check: cards.reduce((s, c) => s + (c.points?.star ?? 0), 0),
      net: cards.reduce((s, c) => s + (c.points?.shield ?? 0), 0),
      pen: cards.reduce((s, c) => s + (c.points?.lightning != null ? -c.points.lightning : 0), 0),
      success: cards.filter((c) => c.userWeekStatus === "success").length,
      fail: cards.filter((c) => c.userWeekStatus === "fail").length,
      tallying: cards.filter((c) => c.userWeekStatus === "tallying").length,
    });
    const dv = view(direct), hv = view(http);

    // 시즌 이력 (resume — LIVE)
    const resume = await getCluster1Resume(uuid).catch(() => null);
    const seasonRecords = ((resume as any)?.seasonRecords ?? []).map((r: any) => `${r.seasonName}:${r.progressStatus}(${r.approvedWeeks}/${r.totalWeeks})`);

    rows.push({
      pilot: `${t.p} ${t.name}`, uuid: uuid.slice(0, 8),
      pms: { week: Number(info.Week), state: info.State, star: Number(bal.Star), shield: Number(bal.Shield), pen: pmsPen },
      db: { approved: (gs as any)?.approved_weeks, cumulative: (gs as any)?.cumulative_weeks, check: dbCheck, net: dbNet, pen: dbPen, growth_status: (prof as any)?.growth_status, status: (prof as any)?.status, gpNonNull, subtitleNonNull },
      http: hv, snapshotMeta: { v: (snap as any)?.dto_version, stale: (snap as any)?.is_stale },
      seasonRecords,
      directEqHttp: canon(dv) === canon(hv),
      snapshotEqHttp: canon(((snap as any)?.cards ?? [])) === canon(http),
      demoEqHttp: demo ? canon(demo) === canon(http) : "demo 비대상(실사용자)",
      checks: {
        accMatchesPmsWeek: hv.acc === Number(info.Week),
        netMatchesBalance: dbNet === Number(bal.Shield),
        growthPointEmpty: gpNonNull === 0,
      },
    });
  }
  await conn.end();
  writeFileSync(OUT, JSON.stringify(rows, null, 1));
  for (const r of rows) {
    console.log(`\n══ ${r.pilot} (${r.uuid}) ══ direct==HTTP:${r.directEqHttp} snapshot==HTTP:${r.snapshotEqHttp} demo:${r.demoEqHttp} (snap v${r.snapshotMeta.v}·stale ${r.snapshotMeta.stale})`);
    console.log(`  누적: PMS Week ${r.pms.week} / DB approved ${r.db.approved} / 화면 ${r.http.acc} ${r.checks.accMatchesPmsWeek ? "✅" : "❌"}`);
    console.log(`  Check: PMS ${r.pms.star} / DB ${r.db.check} | Net: PMS ${r.pms.shield} / DB ${r.db.net} ${r.checks.netMatchesBalance ? "✅" : "❌"} | Penalty: PMS ${r.pms.pen} / DB ${r.db.pen}`);
    console.log(`  growth_status: ${r.db.growth_status} (PMS State ${r.pms.state}) | growth_point 비NULL ${r.db.gpNonNull} ${r.checks.growthPointEmpty ? "✅" : "❌"} | subtitle ${r.db.subtitleNonNull}`);
    console.log(`  카드 ${r.http.cards}: success ${r.http.success} / fail ${r.http.fail} / tallying ${r.http.tallying}`);
    console.log(`  시즌이력: ${r.seasonRecords.join(" · ")}`);
  }
  const allOk = rows.every((r) => r.directEqHttp && r.snapshotEqHttp && r.checks.accMatchesPmsWeek && r.checks.netMatchesBalance && r.checks.growthPointEmpty);
  console.log(`\n전원 일치(누적·net·gp NULL·direct==HTTP·snapshot==HTTP): ${allOk ? "YES" : "NO"}`);
  console.log("→", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
