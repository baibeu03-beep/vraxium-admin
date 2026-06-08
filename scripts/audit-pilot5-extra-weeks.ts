/**
 * Pilot 5명 — "PMS에 없는데 Vraxium에 있는 주차" 전수 조사 (read-only).
 *   npx tsx scripts/audit-pilot5-extra-weeks.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const OUT = "claudedocs/audit-pilot5-extra-weeks-20260607.json";

const PILOT = [
  { p: "P1", src: "oranke", uid: 1092, name: "장승완" },
  { p: "P2", src: "hrdb", uid: 1463, name: "안은비" },
  { p: "P3", src: "olympus", uid: 249, name: "성채윤" },
  { p: "P4", src: "olympus", uid: 248, name: "박시은" },
  { p: "P5", src: "olympus", uid: 251, name: "정혜빈" },
] as const;

const SEASON_DICT = new Map([["봄", "spring"], ["여름", "summer"], ["가을", "autumn"], ["겨울", "winter"], ["거울", "winter"]]);
const normSeason = (s: unknown) => {
  let x = String(s ?? "").replace(/[\s\r\n ]+/g, "");
  if (x.endsWith("시즌")) x = x.slice(0, -2);
  return SEASON_DICT.get(x) ?? null;
};
const addDays = (iso: string, d: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};

// 생성 주체 분류 (created_at 기준)
const origin = (c: string) => {
  if (c >= "2026-06-07T12:31" && c < "2026-06-07T12:36") return "pilot apply 1차(12:31)";
  if (c >= "2026-06-07T12:36" && c < "2026-06-07T12:45") return "pilot apply 2차(12:36)";
  if (c < "2026-06-07T12:00") return `이관 이전 기존 행(${c.slice(0, 16)})`;
  return `기타(${c.slice(0, 16)})`;
};

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });
  type W = { id: string; season_key: string; week_number: number; start_date: string; end_date: string };
  const weeks: W[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("weeks").select("id,season_key,week_number,start_date,end_date").order("start_date").range(f, f + 999);
    weeks.push(...((data ?? []) as W[]));
    if ((data ?? []).length < 1000) break;
  }
  const wByStart = new Map(weeks.map((w) => [w.start_date, w]));
  const label = (s: string) => {
    const w = wByStart.get(s);
    return w ? `${w.season_key} W${w.week_number}` : s;
  };

  const report: any[] = [];
  for (const t of PILOT) {
    const { data: u } = await sb.from("users").select("id").eq("source_system", t.src).eq("legacy_user_id", t.uid).maybeSingle();
    const uuid = (u as any).id;
    const { data: uws } = await sb
      .from("user_week_statuses")
      .select("week_start_date,status,created_at")
      .eq("user_id", uuid).order("week_start_date").range(0, 999);

    // PMS 귀속 주차 (이관과 동일 로직)
    const pmsStarts = new Set<string>();
    for (const table of ["useractivities", "manageractivities"]) {
      const [rows] = (await conn.query(
        `SELECT Season, SeasonWeek, CAST(StartDate AS CHAR) AS s, CAST(EndDate AS CHAR) AS e
         FROM ${t.src}.${table} WHERE UserId=?`, [t.uid])) as [any[], unknown];
      for (const r of rows) {
        const type = normSeason(r.Season);
        const cands = type ? weeks.filter((w) => w.season_key.endsWith(`-${type}`) && w.week_number === Number(r.SeasonWeek)) : [];
        const dates = [r.s, r.e].filter(Boolean).map((d: string) => String(d).slice(0, 10));
        for (const w of cands) {
          const lo = addDays(w.start_date, -60), hi = addDays(w.end_date, 180);
          if (dates.some((d: string) => d >= lo && d <= hi)) { pmsStarts.add(w.start_date); break; }
        }
      }
    }

    const extra = ((uws ?? []) as any[]).filter((r) => !pmsStarts.has(r.week_start_date));
    const missing = [...pmsStarts].filter((s) => !((uws ?? []) as any[]).some((r) => r.week_start_date === s)).sort();
    report.push({
      pilot: `${t.p} ${t.name}`,
      uuid: uuid.slice(0, 8),
      uwsTotal: (uws ?? []).length,
      pmsWeeks: pmsStarts.size,
      extraInVraxium: extra.map((r: any) => ({
        week: label(r.week_start_date), start: r.week_start_date, status: r.status,
        created_at: r.created_at, origin: origin(String(r.created_at)),
      })),
      missingFromVraxium: missing.map(label),
      springW13: ((uws ?? []) as any[]).some((r) => r.week_start_date === "2026-05-25"),
      springW14: ((uws ?? []) as any[]).some((r) => r.week_start_date === "2026-06-01"),
    });
  }
  await conn.end();
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  for (const r of report) {
    console.log(`\n══ ${r.pilot} — uws ${r.uwsTotal} | PMS 귀속 ${r.pmsWeeks} | W13:${r.springW13} W14:${r.springW14} ══`);
    if (r.extraInVraxium.length) {
      console.log(" PMS에 없는 Vraxium 주차:");
      for (const e of r.extraInVraxium) console.log(`  ${e.week.padEnd(18)} ${e.status.padEnd(8)} created=${String(e.created_at).slice(0, 19)} → ${e.origin}`);
    } else console.log(" PMS에 없는 주차: 없음");
    if (r.missingFromVraxium.length) console.log(" PMS에 있는데 Vraxium에 없는 주차:", r.missingFromVraxium.join(", "));
  }
  console.log("\n→", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
