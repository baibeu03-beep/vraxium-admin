/**
 * 장승완(oranke 1092) PMS ↔ Vraxium 전수 감사 (read-only — 수정/재계산/write 0).
 *   npx tsx scripts/audit-1092-pms-vs-vraxium.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const OUT = "claudedocs/audit-1092-pms-vs-vraxium-20260607.json";
const UID = 1092;

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

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });

  // ── 1) PMS 원본 ──
  const [[info]] = (await conn.query(`SELECT Team, Part, Week, Level, State, CAST(StartDate AS CHAR) AS StartDate FROM oranke.usersinfo WHERE UserID=?`, [UID])) as any;
  const [[bal]] = (await conn.query(`SELECT Star, Shield FROM oranke.userspoint WHERE UserID=?`, [UID])) as any;
  const [[plog]] = (await conn.query(`SELECT COUNT(*) AS n, SUM(Star) AS sumStar FROM oranke.pointlogs WHERE UserID=?`, [UID])) as any;
  const acts: any[] = [];
  for (const t of ["useractivities", "manageractivities"]) {
    const [rows] = (await conn.query(
      `SELECT '${t}' AS src, ActivityId, Season, SeasonWeek, Star, IsActive, CAST(StartDate AS CHAR) AS s, CAST(EndDate AS CHAR) AS e, Activity
       FROM oranke.${t} WHERE UserId=? ORDER BY StartDate, SeasonWeek`, [UID])) as any;
    acts.push(...rows);
  }
  await conn.end();

  // ── 라이브 주차 ──
  type W = { id: string; season_key: string; week_number: number; start_date: string; end_date: string };
  const weeks: W[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("weeks").select("id,season_key,week_number,start_date,end_date").order("start_date").range(f, f + 999);
    weeks.push(...((data ?? []) as W[]));
    if ((data ?? []).length < 1000) break;
  }
  const wLabel = (w: W) => `${w.season_key} W${w.week_number}`;
  const attribute = (r: any): W | null => {
    const type = normSeason(r.Season);
    if (!type) return null;
    const cands = weeks.filter((w) => w.season_key.endsWith(`-${type}`) && w.week_number === Number(r.SeasonWeek));
    const dates = [r.s, r.e].filter(Boolean).map((d: string) => String(d).slice(0, 10));
    for (const w of cands) {
      const lo = addDays(w.start_date, -60), hi = addDays(w.end_date, 180);
      if (dates.some((d: string) => d >= lo && d <= hi)) return w;
    }
    return null;
  };

  // PMS 활동 → 귀속 주차 (인정 = IsActive=1 존재)
  const pmsByWeek = new Map<string, { label: string; recognized: boolean; rows: any[] }>();
  const unattributedActs: any[] = [];
  for (const r of acts) {
    const w = attribute(r);
    if (!w) { unattributedActs.push({ src: r.src, season: r.Season, weekNum: r.SeasonWeek, dates: [r.s, r.e] }); continue; }
    let v = pmsByWeek.get(w.start_date);
    if (!v) { v = { label: wLabel(w), recognized: false, rows: [] }; pmsByWeek.set(w.start_date, v); }
    if (r.IsActive === 1) v.recognized = true;
    v.rows.push({ src: r.src, season: String(r.Season).trim(), weekNum: r.SeasonWeek, isActive: r.IsActive, star: r.Star, dates: [String(r.s).slice(0, 10), String(r.e ?? "").slice(0, 10)] });
  }

  // ── 3) Vraxium 실제 DB ──
  const { data: u } = await sb.from("users").select("id,legacy_user_id,source_system,created_at").eq("source_system", "oranke").eq("legacy_user_id", UID).maybeSingle();
  const uuid = (u as any)?.id;
  const { data: prof } = await sb.from("user_profiles").select("display_name,organization_slug,created_at").eq("user_id", uuid).maybeSingle();
  const { data: uwsRows } = await sb.from("user_week_statuses").select("week_start_date,status,year,week_number,created_at").eq("user_id", uuid).order("week_start_date").range(0, 999);
  const { data: uwpRows } = await sb.from("user_weekly_points").select("week_start_date,points,advantages,penalty,checks_migrated").eq("user_id", uuid).order("week_start_date").range(0, 999);
  const { count: ledgerN } = await sb.from("legacy_point_ledger").select("id", { count: "exact", head: true }).eq("user_id", uuid);
  const { count: targetsN } = await sb.from("cluster4_line_targets").select("id", { count: "exact", head: true }).eq("target_user_id", uuid);
  const { data: gs } = await sb.from("user_growth_stats").select("approved_weeks,cumulative_weeks").eq("user_id", uuid).maybeSingle();
  const weekByStart = new Map(weeks.map((w) => [w.start_date, w]));

  // ── 4~6) 주차 목록 나란히 비교 ──
  const allStarts = [...new Set([...pmsByWeek.keys(), ...((uwsRows ?? []) as any[]).map((r) => r.week_start_date)])].sort();
  const sideBySide: string[] = [];
  const onlyVraxium: string[] = [];
  const onlyPms: string[] = [];
  const statusMismatch: string[] = [];
  for (const s of allStarts) {
    const w = weekByStart.get(s);
    const label = w ? wLabel(w) : s;
    const pms = pmsByWeek.get(s);
    const vx = ((uwsRows ?? []) as any[]).find((r) => r.week_start_date === s);
    const pmsCol = pms ? (pms.recognized ? "인정" : "미인정(fail)") : "—";
    const vxCol = vx ? vx.status : "—";
    sideBySide.push(`${label.padEnd(22)} | PMS: ${pmsCol.padEnd(10)} | Vraxium: ${vxCol}`);
    if (!pms && vx) onlyVraxium.push(`${label} (${s}) — Vraxium status=${vx.status}`);
    if (pms && !vx) onlyPms.push(`${label} (${s}) — PMS ${pmsCol}`);
    if (pms && vx) {
      const expect = pms.recognized ? "success" : "fail";
      if (vx.status !== expect) statusMismatch.push(`${label}: PMS ${pmsCol} → 기대 ${expect}, 실제 ${vx.status}`);
    }
  }

  // ── 7) 누적 계산식 ──
  const pmsRecognized = [...pmsByWeek.values()].filter((v) => v.recognized).length;
  const vxSuccess = ((uwsRows ?? []) as any[]).filter((r) => r.status === "success").length;
  const sumUwp = ((uwpRows ?? []) as any[]).reduce((s, r) => s + r.points, 0);
  const sentinel = ((uwpRows ?? []) as any[]).find((r) => r.week_start_date === "1900-01-01");

  // ── 8) 기존 데이터 합산 여부 — 신규 채번이므로 apply 이전 생성 행 0 기대 ──
  const preExisting = ((uwsRows ?? []) as any[]).filter((r) => r.created_at < "2026-06-07T12:30:00Z").length;

  const report = {
    pms: {
      usersinfo: info, balance: bal, pointlogs: { rows: Number(plog.n), sumStar: Number(plog.sumStar) },
      activityRows: acts.length, unattributedActivityRows: unattributedActs,
      weeksAttributed: pmsByWeek.size, weeksRecognized: pmsRecognized,
    },
    plan: "claudedocs/dryrun-pms-1092-20260607.json (§12 weekRows)",
    vraxium: {
      uuid, sourcePair: u, profile: prof,
      uwsRows: (uwsRows ?? []).length, uwpRows: (uwpRows ?? []).length,
      ledger: ledgerN, targets: targetsN, growthStats: gs,
      uwsCreatedBeforeApply: preExisting,
    },
    sideBySide, onlyVraxium, onlyPms, statusMismatch,
    cumulative: {
      pms_formula: "usersinfo.Week(수동 필드) vs 인정 활동 주차 수(IsActive=1 귀속 distinct)",
      pms_week_field: Number(info.Week),
      pms_recognized_weeks: pmsRecognized,
      vraxium_formula: "user_growth_stats.approved_weeks = uws status='success' (전환 주차 제외)",
      vraxium_approved: (gs as any)?.approved_weeks ?? null,
      vraxium_cumulative: (gs as any)?.cumulative_weeks ?? null,
      vraxium_uws_success_raw: vxSuccess,
      points_pms_balance: Number(bal.Star),
      points_vraxium_sum_uwp: sumUwp,
      points_sentinel: sentinel ? sentinel.points : null,
    },
  };
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log("══ PMS 원본 ══");
  console.log(`usersinfo: Week=${info.Week} State=${info.State} Team=${info.Team}/${info.Part} Start=${String(info.StartDate).slice(0, 10)}`);
  console.log(`잔액: Star=${bal.Star} Shield=${bal.Shield} | pointlogs ${plog.n}행 ΣStar=${plog.sumStar} | 활동행 ${acts.length} (미귀속 ${unattributedActs.length})`);
  console.log(`PMS 귀속 주차 ${pmsByWeek.size} · 인정 ${pmsRecognized}`);
  console.log("\n══ Vraxium 실제 ══");
  console.log(`uuid=${uuid?.slice(0, 8)} pair=(${(u as any)?.source_system},${(u as any)?.legacy_user_id}) | uws ${(uwsRows ?? []).length} uwp ${(uwpRows ?? []).length} ledger ${ledgerN} targets ${targetsN}`);
  console.log(`growth_stats: approved=${(gs as any)?.approved_weeks} cumulative=${(gs as any)?.cumulative_weeks} | Σuwp.points=${sumUwp} (sentinel ${sentinel?.points})`);
  console.log(`apply 이전 생성 uws 행: ${preExisting} (0=기존 합산 없음)`);
  console.log("\n══ 주차 나란히 비교 ══");
  for (const l of sideBySide) console.log(" " + l);
  console.log("\nVraxium에만:", onlyVraxium.length ? onlyVraxium.join(" ; ") : "없음");
  console.log("PMS에만:", onlyPms.length ? onlyPms.join(" ; ") : "없음");
  console.log("status 불일치:", statusMismatch.length ? statusMismatch.join(" ; ") : "없음");
  console.log("\n→", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
