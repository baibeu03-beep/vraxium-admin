/**
 * Pilot 5명 — PMS ↔ Migration ↔ DB ↔ 고객 API ↔ 표시 전수 비교 (read-only).
 *   npx tsx scripts/audit-pilot5-display-vs-pms.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const OUT = "claudedocs/audit-pilot5-display-vs-pms-20260607.json";

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
  const { getCluster4WeeklyCardsForProfileUser } = await import("@/lib/cluster4WeeklyCardsData");

  const rows: any[] = [];
  for (const t of PILOT) {
    // ── PMS ──
    const [[bal]] = (await conn.query(`SELECT Star, Shield FROM ${t.src}.userspoint WHERE UserID=?`, [t.uid])) as any;
    const [[info]] = (await conn.query(`SELECT Week FROM ${t.src}.usersinfo WHERE UserID=?`, [t.uid])) as any;
    const [logs] = (await conn.query(`SELECT Star, Shield, IsDeleted FROM ${t.src}.pointlogs WHERE UserID=?`, [t.uid])) as [any[], unknown];
    const pmsPen = logs.filter((r) => r.IsDeleted === 0 && Number(r.Shield) < 0).reduce((s, r) => s - Number(r.Shield), 0);
    const [[actN]] = (await conn.query(
      `SELECT (SELECT COUNT(*) FROM ${t.src}.useractivities WHERE UserId=?) + (SELECT COUNT(*) FROM ${t.src}.manageractivities WHERE UserId=?) AS n`,
      [t.uid, t.uid])) as any;

    // ── Migration 계산값 (per-user dry-run 산출물) ──
    const file = t.p === "P1" ? "dryrun-pms-1092-20260607.json" : `dryrun-pms-${t.src}-${t.uid}-20260607.json`;
    const plan = JSON.parse(readFileSync(`claudedocs/${file}`, "utf8"));
    const planWeeks = (plan.weekRows ?? []) as any[];
    const mig = {
      check: planWeeks.reduce((s, r) => s + r.uwp.points, 0) + (plan.step8_adjustment?.sentinelRow?.points ?? 0),
      pen: planWeeks.reduce((s, r) => s + r.uwp.penalty, 0) + (plan.step8_adjustment?.sentinelRow?.penalty ?? 0),
      netAdv:
        planWeeks.reduce((s, r) => s + r.uwp.advantages - r.uwp.penalty, 0) +
        ((plan.step8_adjustment?.sentinelRow?.advantages ?? 0) - (plan.step8_adjustment?.sentinelRow?.penalty ?? 0)),
      uwsSuccess: planWeeks.filter((r) => r.uws?.status === "success").length,
      uwsFail: planWeeks.filter((r) => r.uws?.status === "fail").length,
    };

    // ── DB ──
    const { data: u } = await sb.from("users").select("id").eq("source_system", t.src).eq("legacy_user_id", t.uid).maybeSingle();
    const uuid = (u as any).id;
    const { data: uwp } = await sb.from("user_weekly_points").select("week_start_date,points,advantages,penalty").eq("user_id", uuid).range(0, 999);
    const { data: uws } = await sb.from("user_week_statuses").select("status").eq("user_id", uuid).range(0, 999);
    const { data: gs } = await sb.from("user_growth_stats").select("approved_weeks,cumulative_weeks").eq("user_id", uuid).maybeSingle();
    const db = {
      check: ((uwp ?? []) as any[]).reduce((s, r) => s + r.points, 0),
      netAdv: ((uwp ?? []) as any[]).reduce((s, r) => s + r.advantages - r.penalty, 0),
      pen: ((uwp ?? []) as any[]).reduce((s, r) => s + r.penalty, 0),
      approved: (gs as any)?.approved_weeks,
      cumulative: (gs as any)?.cumulative_weeks,
      uwsSuccess: ((uws ?? []) as any[]).filter((r) => r.status === "success").length,
      uwsFail: ((uws ?? []) as any[]).filter((r) => r.status === "fail").length,
    };

    // ── direct / HTTP / snapshot (고객 API·화면 원천) ──
    const direct = (await getCluster4WeeklyCardsForProfileUser(uuid)) as any[];
    const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${uuid}`, {
      headers: { "x-internal-api-key": envGet("INTERNAL_API_KEY")! },
    });
    const http = ((await res.json()).data ?? []) as any[];
    const { data: snap } = await sb.from("cluster4_weekly_card_snapshots").select("cards,dto_version,is_stale").eq("user_id", uuid).maybeSingle();
    const view = (cards: any[]) => ({
      check: cards.reduce((s, c) => s + (c.points?.star ?? 0), 0),
      netAdv: cards.reduce((s, c) => s + (c.points?.shield ?? 0), 0),
      pen: cards.reduce((s, c) => s + (c.points?.lightning != null ? -c.points.lightning : 0), 0),
      accumulated: cards.length ? Math.max(...cards.map((c) => c.accumulatedApprovedWeeks ?? 0)) : 0,
      success: cards.filter((c) => c.userWeekStatus === "success").length,
      fail: cards.filter((c) => c.userWeekStatus === "fail").length,
      tallying: cards.filter((c) => c.userWeekStatus === "tallying").length,
      cards: cards.length,
    });
    const d = view(direct), h = view(http), s = view(((snap as any)?.cards ?? []) as any[]);

    rows.push({
      pilot: `${t.p} ${t.name}`,
      pms: { check: Number(bal.Star), netAdv: Number(bal.Shield), pen: pmsPen, week: Number(info.Week), actRows: Number(actN.n) },
      migration: mig, db, direct: d, http: h, snapshot: s,
      directEqHttp: canon(d) === canon(h),
      snapshotEqDirect: canon(s) === canon(d),
      snapshotMeta: { v: (snap as any)?.dto_version, stale: (snap as any)?.is_stale },
    });
  }
  await conn.end();
  writeFileSync(OUT, JSON.stringify(rows, null, 1));
  for (const r of rows) {
    console.log(`\n══ ${r.pilot} ══  direct==HTTP:${r.directEqHttp} snapshot==direct:${r.snapshotEqDirect} (v${r.snapshotMeta.v}·stale ${r.snapshotMeta.stale})`);
    console.log(` 항목        | PMS    | Migration | DB     | API(HTTP) | 화면(=API)`);
    console.log(` Check       | ${String(r.pms.check).padEnd(6)} | ${String(r.migration.check).padEnd(9)} | ${String(r.db.check).padEnd(6)} | ${String(r.http.check).padEnd(9)} | 동일`);
    console.log(` Adv(Net)    | ${String(r.pms.netAdv).padEnd(6)} | ${String(r.migration.netAdv).padEnd(9)} | ${String(r.db.netAdv).padEnd(6)} | ${String(r.http.netAdv).padEnd(9)} | 동일`);
    console.log(` Penalty     | ${String(r.pms.pen).padEnd(6)} | ${String(r.migration.pen).padEnd(9)} | ${String(r.db.pen).padEnd(6)} | ${String(r.http.pen).padEnd(9)} | 동일`);
    console.log(` 누적 인정    | ${String(r.pms.week).padEnd(6)} | ${String(r.migration.uwsSuccess).padEnd(9)} | ${String(r.db.approved).padEnd(6)} | ${String(r.http.accumulated).padEnd(9)} | 동일`);
    console.log(` 활동내역(행) | ${String(r.pms.actRows).padEnd(6)} | uws ${String(r.migration.uwsSuccess + r.migration.uwsFail).padEnd(5)} | ${String(r.db.uwsSuccess + r.db.uwsFail).padEnd(6)} | 카드 ${r.http.cards}`);
    console.log(` 성공/실패    | (귀속 ${r.pms.week}/-)`.padEnd(20) + `| ${r.migration.uwsSuccess}/${r.migration.uwsFail}`.padEnd(12) + `| ${r.db.uwsSuccess}/${r.db.uwsFail}`.padEnd(9) + `| ${r.http.success}/${r.http.fail} (집계중 ${r.http.tallying})`);
  }
  console.log("\n→", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
