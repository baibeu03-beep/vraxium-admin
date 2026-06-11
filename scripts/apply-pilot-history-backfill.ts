// 권원중/권희윤 과거 시즌(summer/autumn/winter) uws/uwp 백필 (additive, approved 기준).
// DRY=1 → 계획만 출력(write 0). 미지정 → apply + rollback 산출물 기록.
// 기존 2026-spring 행은 week_start_date 중복으로 자동 skip (무접촉).
import { readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { normalizePmsSeasonType, isExcludedPmsSeason } from "@/lib/pmsSeasonAttribution";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { supabaseAdmin as sb } from "@/lib/supabaseAdmin";

const DRY = process.env.DRY === "1";
const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const addDays = (iso: string, d: number) => { const t = new Date(iso + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

async function main() {
  const SRC = "olympus";
  const PILOT = [
    { lg: 253, name: "권원중", uid: "361f69d5-a718-4675-bbcb-15b8f69bf431", target: 29 },
    { lg: 259, name: "권희윤", uid: "f7c159f8-ad78-46fd-b4c7-d39e6229f2e2", target: 26 },
  ];
  const conn = await mysql.createConnection({ host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306), user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true, ssl: { rejectUnauthorized: false } });
  const q = async (s: string, p: any[] = []) => (await conn.query(s, p))[0] as any[];
  const weeks = (await sb.from("weeks").select("id,season_key,week_number,iso_year,iso_week,start_date,end_date")).data ?? [];
  const weekByRange = (d: string) => weeks.find((w: any) => d >= w.start_date && d <= w.end_date) ?? null;
  const weekById = new Map(weeks.map((w: any) => [w.id, w]));

  console.log(`MODE: ${DRY ? "DRY-RUN (write 0)" : "APPLY"}`);
  const allUwsIds: string[] = [], allUwpIds: string[] = [];
  const summary: any = {};

  for (const p of PILOT) {
    console.log(`\n${"=".repeat(64)}\n■ ${p.name} (${p.uid.slice(0, 8)})`);
    // attribution
    const wp = new Map<string, { week: any; recognized: boolean }>();
    for (const table of ["useractivities", "manageractivities"]) {
      const rows = await q(`SELECT Season,SeasonWeek,IsActive,CAST(StartDate AS CHAR) StartDate,CAST(EndDate AS CHAR) EndDate FROM ${SRC}.${table} WHERE UserId=?`, [p.lg]);
      for (const r of rows) {
        if (isExcludedPmsSeason(r.Season)) continue;
        const type = normalizePmsSeasonType(r.Season);
        const cands = type ? weeks.filter((w: any) => w.season_key.endsWith(`-${type}`) && w.week_number === r.SeasonWeek) : [];
        const dates = [r.StartDate, r.EndDate].filter(Boolean).map((d: string) => String(d).slice(0, 10));
        let w: any = null;
        for (const c of cands) { const lo = addDays(c.start_date, -60), hi = addDays(c.end_date, 180); if (dates.some((d: string) => d >= lo && d <= hi)) { w = c; break; } }
        if (!w && dates.length) w = weekByRange(dates[0]) ?? (dates[1] ? weekByRange(dates[1]) : null);
        if (!w) continue;
        let v = wp.get(w.id); if (!v) { v = { week: w, recognized: false }; wp.set(w.id, v); }
        if (r.IsActive === 1) v.recognized = true;
      }
    }
    // pointlogs → uwp
    const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR) WHEN YEAR(ActivityTime)=1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
    const plogs = await q(`SELECT Star,CAST(${CORR} AS CHAR) corrected FROM ${SRC}.pointlogs WHERE UserID=? AND IsDeleted=0`, [p.lg]);
    const uwpAgg = new Map<string, number>();
    for (const r of plogs) { const w = weekByRange(String(r.corrected)); if (w) uwpAgg.set(w.id, (uwpAgg.get(w.id) ?? 0) + Number(r.Star ?? 0)); }

    // existing
    const exUws = new Set(((await sb.from("user_week_statuses").select("week_start_date").eq("user_id", p.uid)).data ?? []).map((r: any) => r.week_start_date));
    const exUwp = new Set(((await sb.from("user_weekly_points").select("week_start_date").eq("user_id", p.uid)).data ?? []).map((r: any) => r.week_start_date));

    // build uws inserts (skip existing + transition)
    const uwsRows: any[] = [];
    for (const v of wp.values()) {
      const w = v.week;
      if (exUws.has(w.start_date)) continue;
      if (isTransitionWeekStart(w.start_date)) continue;
      uwsRows.push({ user_id: p.uid, year: w.iso_year, week_number: w.iso_week, week_start_date: w.start_date, status: "success", note: null, is_official_rest_override: false, season_key: w.season_key });
    }
    // build uwp inserts (skip existing)
    const uwpRows: any[] = [];
    for (const [wid, star] of uwpAgg) {
      const w: any = weekById.get(wid);
      if (!w || exUwp.has(w.start_date)) continue;
      uwpRows.push({ user_id: p.uid, year: w.iso_year, week_number: w.iso_week, week_start_date: w.start_date, points: star, advantages: 0, penalty: 0, checks_migrated: false });
    }

    uwsRows.sort((a, b) => a.week_start_date.localeCompare(b.week_start_date));
    uwpRows.sort((a, b) => a.week_start_date.localeCompare(b.week_start_date));
    const bySeason: any = {}; for (const r of uwsRows) bySeason[r.season_key] = (bySeason[r.season_key] || 0) + 1;
    const overlapUws = uwsRows.filter(r => exUws.has(r.week_start_date)).length;
    const overlapUwp = uwpRows.filter(r => exUwp.has(r.week_start_date)).length;
    const projApproved = exUws.size /*existing all-success? no*/;
    console.log(`  신규 uws ${uwsRows.length}행 (시즌별 ${JSON.stringify(bySeason)}) · 신규 uwp ${uwpRows.length}행`);
    console.log(`  중복검사: uws겹침 ${overlapUws} · uwp겹침 ${overlapUwp} (0 이어야 함)`);
    console.log(`  기존 uws ${exUws.size} + 신규 ${uwsRows.length} = ${exUws.size + uwsRows.length} (cumulative 예상)`);
    console.log(`  uws 날짜: ${uwsRows.map(r => r.week_start_date).join(", ")}`);

    summary[p.name] = { newUws: uwsRows.length, newUwp: uwpRows.length, bySeason, cumulativeExpected: exUws.size + uwsRows.length };

    if (overlapUws || overlapUwp) { throw new Error(`${p.name}: 중복 발생 — 중단`); }

    if (!DRY) {
      if (uwsRows.length) {
        const ins = await sb.from("user_week_statuses").insert(uwsRows).select("id");
        if (ins.error) throw new Error("uws insert: " + ins.error.message);
        const ids = (ins.data ?? []).map((r: any) => r.id); allUwsIds.push(...ids);
        console.log(`  ✅ uws ${ids.length}행 insert`);
      }
      if (uwpRows.length) {
        const ins = await sb.from("user_weekly_points").insert(uwpRows).select("id");
        if (ins.error) throw new Error("uwp insert: " + ins.error.message);
        const ids = (ins.data ?? []).map((r: any) => r.id); allUwpIds.push(...ids);
        console.log(`  ✅ uwp ${ids.length}행 insert`);
      }
    }
  }
  await conn.end();

  if (!DRY) {
    const roll = {
      note: "권원중/권희윤 과거시즌 uws/uwp additive 백필 rollback (approved 기준). spring·growth_stats·snapshot 무관.",
      uwsIds: allUwsIds, uwpIds: allUwpIds,
      rollbackSql: `DELETE FROM user_week_statuses WHERE id IN ('${allUwsIds.join("','")}'); DELETE FROM user_weekly_points WHERE id IN ('${allUwpIds.join("','")}');`,
      summary,
    };
    writeFileSync("claudedocs/apply-pilot-history-backfill-rollback-20260611.json", JSON.stringify(roll, null, 2));
    console.log(`\n📄 rollback: claudedocs/apply-pilot-history-backfill-rollback-20260611.json (uws ${allUwsIds.length} · uwp ${allUwpIds.length})`);
  }
  console.log(`\n[${DRY ? "DRY-RUN 종료 — write 0" : "APPLY 완료"}]  summary: ${JSON.stringify(summary, null, 0)}`);
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
