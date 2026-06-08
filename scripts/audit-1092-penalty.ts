/**
 * 장승완(oranke 1092) point.penalty 정합 감사 (read-only · 수정/공표/재계산 0).
 *   npx tsx scripts/audit-1092-penalty.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const OUT = "claudedocs/audit-1092-penalty-20260607.json";
const UUID = "14f5c826-b2cf-4a88-abda-7168f3be907d";

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });

  // ── 1·3) PMS 원본 — penalty 후보 전수 분해 ──
  const [rows] = (await conn.query(`
    SELECT LogNum, code, log, Star, Shield, IsDeleted, CAST(ActivityTime AS CHAR) AS at
    FROM oranke.pointlogs WHERE UserID = 1092 ORDER BY LogNum`)) as [any[], unknown];
  const [[bal]] = (await conn.query(`SELECT Star, Shield FROM oranke.userspoint WHERE UserID = 1092`)) as any;
  await conn.end();
  const shieldNegAlive = rows.filter((r) => r.IsDeleted === 0 && Number(r.Shield) < 0);
  const shieldNegDeleted = rows.filter((r) => r.IsDeleted === 1 && Number(r.Shield) < 0);
  const shieldPosAlive = rows.filter((r) => r.IsDeleted === 0 && Number(r.Shield) > 0);
  const starNeg = rows.filter((r) => Number(r.Star) < 0);
  const pms = {
    balance: { star: Number(bal.Star), shield: Number(bal.Shield) },
    shieldNegAlive: { rows: shieldNegAlive.length, sumAbs: shieldNegAlive.reduce((s, r) => s - Number(r.Shield), 0) },
    shieldNegDeleted: { rows: shieldNegDeleted.length, sumAbs: shieldNegDeleted.reduce((s, r) => s - Number(r.Shield), 0) },
    shieldPosAlive: { rows: shieldPosAlive.length, sum: shieldPosAlive.reduce((s, r) => s + Number(r.Shield), 0) },
    starNeg: { rows: starNeg.length, sumAbs: starNeg.reduce((s, r) => s - Number(r.Star), 0) },
    shieldNegAliveByCode: shieldNegAlive.reduce((m: Record<string, number>, r) => ((m[r.code] = (m[r.code] ?? 0) + 1), m), {}),
    shieldNegSamples: shieldNegAlive.slice(0, 6).map((r) => ({ LogNum: r.LogNum, code: r.code, shield: r.Shield, log: String(r.log ?? "").slice(0, 30), at: String(r.at).slice(0, 10) })),
  };

  // ── 2·4) Vraxium DB — uwp.penalty ──
  const { data: uwp } = await sb
    .from("user_weekly_points")
    .select("week_start_date,points,advantages,penalty,checks_migrated")
    .eq("user_id", UUID).order("week_start_date").range(0, 999);
  const weekly = ((uwp ?? []) as any[]).filter((r) => r.week_start_date !== "1900-01-01");
  const sentinel = ((uwp ?? []) as any[]).find((r) => r.week_start_date === "1900-01-01");
  const db = {
    weeklyPenaltySum: weekly.reduce((s, r) => s + r.penalty, 0),
    weeklyAdvSum: weekly.reduce((s, r) => s + r.advantages, 0),
    sentinel: sentinel ? { adv: sentinel.advantages, pen: sentinel.penalty } : null,
    totalNetShield: weekly.reduce((s, r) => s + r.advantages - r.penalty, 0) + (sentinel ? sentinel.advantages - sentinel.penalty : 0),
  };

  // ── ledger 대조 ──
  const { data: led } = await sb
    .from("legacy_point_ledger").select("shield,entry_type").eq("user_id", UUID).range(0, 4999);
  const ledger = {
    negAliveSumAbs: ((led ?? []) as any[]).filter((r) => r.entry_type === "POINTLOG" && r.shield < 0).reduce((s, r) => s - r.shield, 0),
    negVoidedSumAbs: ((led ?? []) as any[]).filter((r) => r.entry_type === "POINTLOG_VOIDED" && r.shield < 0).reduce((s, r) => s - r.shield, 0),
    adjShield: ((led ?? []) as any[]).filter((r) => r.entry_type === "MIGRATION_ADJUSTMENT").reduce((s, r) => s + r.shield, 0),
  };

  // ── 5·6·7) direct / HTTP / snapshot — 카드 lightning(−penalty)·shield(net) 합 ──
  const { getCluster4WeeklyCardsForProfileUser } = await import("@/lib/cluster4WeeklyCardsData");
  const direct = (await getCluster4WeeklyCardsForProfileUser(UUID)) as any[];
  const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${UUID}`, {
    headers: { "x-internal-api-key": envGet("INTERNAL_API_KEY")! },
  });
  const http = ((await res.json()).data ?? []) as any[];
  const { data: snap } = await sb.from("cluster4_weekly_card_snapshots").select("cards").eq("user_id", UUID).maybeSingle();
  const snapCards = ((snap as any)?.cards ?? []) as any[];
  const sumView = (cards: any[]) => ({
    cards: cards.length,
    penaltySum: cards.reduce((s, c) => s + (c.points?.lightning != null ? -c.points.lightning : 0), 0),
    shieldNetSum: cards.reduce((s, c) => s + (c.points?.shield ?? 0), 0),
  });
  const report = {
    displayPolicy: "방패=advantages−penalty(net)·번개=−penalty (per-week, shared/cluster4.contracts.ts:278)",
    migrationFormula: "§5-1: penalty=Σ max(−Shield,0) [IsDeleted=0 alive만] · Star 음수는 points(net_all)로 흡수(14일 보호)",
    pms, vraxiumDb: db, ledger,
    direct: sumView(direct), http: sumView(http), snapshot: sumView(snapCards),
    directEqHttp: JSON.stringify(sumView(direct)) === JSON.stringify(sumView(http)),
  };
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log("══ PMS 원본 분해 ══");
  console.log(`잔액 Shield=${pms.balance.shield} | Shield<0 alive: ${pms.shieldNegAlive.rows}행 Σ|${pms.shieldNegAlive.sumAbs}| · deleted: ${pms.shieldNegDeleted.rows}행 Σ|${pms.shieldNegDeleted.sumAbs}| | Shield>0 alive: Σ${pms.shieldPosAlive.sum} | Star<0: ${pms.starNeg.rows}행 Σ|${pms.starNeg.sumAbs}|`);
  console.log("Shield<0 alive code 분포:", JSON.stringify(pms.shieldNegAliveByCode), "| 샘플:", JSON.stringify(pms.shieldNegSamples.slice(0, 3)));
  console.log("\n══ Vraxium ══");
  console.log(`uwp 주차 Σpenalty=${db.weeklyPenaltySum} Σadv=${db.weeklyAdvSum} | sentinel adv=${db.sentinel?.adv} pen=${db.sentinel?.pen} | net 합=${db.totalNetShield} (PMS 잔액 ${pms.balance.shield})`);
  console.log(`ledger: alive Shield<0 Σ|${ledger.negAliveSumAbs}| · voided Σ|${ledger.negVoidedSumAbs}| · ADJ shield ${ledger.adjShield}`);
  console.log(`direct: ${JSON.stringify(report.direct)} | http: ${JSON.stringify(report.http)} | snapshot: ${JSON.stringify(report.snapshot)}`);
  console.log(`direct==HTTP(요약): ${report.directEqHttp}`);
  console.log("→", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
