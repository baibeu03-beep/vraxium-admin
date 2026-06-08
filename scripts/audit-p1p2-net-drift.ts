/**
 * P1·P2 Net 1 차이 — 컷오버 drift 증명 (read-only).
 *   node --input-type=module 로 실행 권장이나 tsx 가능 (MYSQL pw 특수문자 → .env.local 직독).
 *   npx tsx scripts/audit-p1p2-net-drift.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const raw = readFileSync(".env.local", "utf8");
const get = (k: string) => raw.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL")!, get("SUPABASE_SERVICE_ROLE_KEY")!);
const OUT = "claudedocs/audit-p1p2-net-drift-20260608.json";

const TARGETS = [
  { p: "P1", src: "oranke", uid: 1092, name: "장승완", applyLog: "claudedocs/pilot-apply-5-apply-2026-06-07T12-36-42.json" },
  { p: "P2", src: "hrdb", uid: 1463, name: "안은비", applyLog: "claudedocs/pilot-apply-5-apply-2026-06-07T12-36-42.json" },
] as const;

async function main() {
  const conn = await mysql.createConnection({
    host: get("MYSQL_HOST"), port: Number(get("MYSQL_PORT") ?? 3306),
    user: get("MYSQL_USER"), password: get("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });
  const APPLY_CUTOFF = "2026-06-07 12:36:42"; // pilot apply(2차) 시점 — 이후 PMS 변경 = drift
  const report: any[] = [];

  for (const t of TARGETS) {
    // ── 1) PMS 현재 원본 ──
    const [[bal]] = (await conn.query(`SELECT Star, Shield FROM ${t.src}.userspoint WHERE UserID=?`, [t.uid])) as any;
    const [logs] = (await conn.query(
      `SELECT LogNum, Star, Shield, IsDeleted, log, code, CAST(ActivityTime AS CHAR) AS at, CAST(createtime AS CHAR) AS ct
       FROM ${t.src}.pointlogs WHERE UserID=? ORDER BY LogNum`, [t.uid])) as [any[], unknown];
    const aliveShieldPos = logs.filter((r) => r.IsDeleted === 0 && Number(r.Shield) > 0).reduce((s, r) => s + Number(r.Shield), 0);
    const aliveShieldNeg = logs.filter((r) => r.IsDeleted === 0 && Number(r.Shield) < 0).reduce((s, r) => s - Number(r.Shield), 0);
    const pmsNet = aliveShieldPos - aliveShieldNeg; // raw adv − raw pen (alive)

    // ── 2) apply 이후 추가된 로그 (createtime > cutoff) ──
    const postApply = logs.filter((r) => String(r.ct) > APPLY_CUTOFF);

    // ── 3) DB / ledger / API ──
    const { data: u } = await sb.from("users").select("id").eq("source_system", t.src).eq("legacy_user_id", t.uid).maybeSingle();
    const uuid = (u as any).id;
    const { data: uwp } = await sb.from("user_weekly_points").select("advantages,penalty,week_start_date").eq("user_id", uuid).range(0, 999);
    const dbNet = (uwp ?? []).reduce((s: number, r: any) => s + r.advantages - r.penalty, 0);
    const { data: led } = await sb.from("legacy_point_ledger").select("shield,entry_type,source_pk").eq("user_id", uuid).range(0, 4999);
    const ledgerRows = (led ?? []).length;
    const ledgerNetAlive = (led ?? []).filter((r: any) => r.entry_type === "POINTLOG").reduce((s: number, r: any) => s + r.shield, 0);
    const ledgerAdj = (led ?? []).filter((r: any) => r.entry_type === "MIGRATION_ADJUSTMENT").reduce((s: number, r: any) => s + r.shield, 0);

    // migration 산출물 (apply run log 의 sentinel/balance)
    let migBalanceShield: number | null = null;
    try {
      const log = JSON.parse(readFileSync(t.applyLog, "utf8"));
      const applied = (log.applied ?? []).find((a: any) => a.uuid === uuid);
      migBalanceShield = applied?.sentinel?.shieldDelta ?? null;
    } catch { /* ignore */ }

    // ledger 에 post-apply 로그가 있는지 (없어야 — 이관 후 PMS 추가분 미적재 = drift 근거)
    const ledgerSourcePks = new Set((led ?? []).map((r: any) => String(r.source_pk)));
    const postApplyInLedger = postApply.filter((r) => ledgerSourcePks.has(String(r.LogNum)));

    report.push({
      pilot: `${t.p} ${t.name}`, src: t.src, uid: t.uid, uuid: uuid.slice(0, 8),
      pmsBalanceShield: Number(bal.Shield),
      pmsNetFromLogs: pmsNet,
      dbNet,
      ledgerNetAlive_plus_adj: ledgerNetAlive + ledgerAdj,
      drift: Number(bal.Shield) - dbNet,
      postApplyLogs: postApply.map((r) => ({
        LogNum: r.LogNum, Shield: r.Shield, Star: r.Star, IsDeleted: r.IsDeleted,
        log: String(r.log ?? "").replace(/\s+/g, " ").slice(0, 30), code: r.code,
        activityTime: String(r.at).slice(0, 16), createtime: String(r.ct).slice(0, 16),
      })),
      postApplyInLedger: postApplyInLedger.map((r) => r.LogNum), // 기대 [] (이관 후 추가분 미적재)
      ledgerRows, migBalanceShield,
    });
  }
  await conn.end();
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  for (const r of report) {
    console.log(`\n══ ${r.pilot} (${r.uuid}) ══`);
    console.log(`  PMS 잔액 Shield(net) = ${r.pmsBalanceShield} | DB Net = ${r.dbNet} | drift = ${r.drift}`);
    console.log(`  ledger(alive net + adj) = ${r.ledgerNetAlive_plus_adj} (ledger ${r.ledgerRows}행)`);
    console.log(`  apply(${"2026-06-07 12:36"}) 이후 PMS 추가 로그 ${r.postApplyLogs.length}건:`);
    for (const l of r.postApplyLogs) console.log(`     LogNum=${l.LogNum} Shield=${l.Shield} "${l.log}" AT=${l.activityTime} CT=${l.createtime}`);
    console.log(`  그 로그가 ledger 에 적재됨? ${r.postApplyInLedger.length ? r.postApplyInLedger.join(",") : "없음(=drift 근거 — 이관 후 추가분 미반영)"}`);
    console.log(`  drift 설명: PMS net ${r.pmsBalanceShield} = DB net ${r.dbNet} ${r.drift < 0 ? r.drift : "+" + r.drift} (post-apply Shield 합 ${r.postApplyLogs.reduce((s: number, l: any) => s + Number(l.Shield), 0)})`);
  }
  console.log("\n→", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
