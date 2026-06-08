/**
 * P4 박시은(olympus 248) · P5 정혜빈(olympus 251) — Season 오염 누락 2주 보강 (2026-06-07 승인).
 *
 *   npx tsx --env-file=.env.local scripts/apply-pilot-backfill-2weeks.ts            # preview
 *   npx tsx --env-file=.env.local scripts/apply-pilot-backfill-2weeks.ts --apply
 *   npx tsx --env-file=.env.local scripts/apply-pilot-backfill-2weeks.ts --rollback <runlog>
 *
 * 보강 주차: 2026-winter W1(2025-12-29 — PMS "겨을" W1) · 2026-spring W1(2026-03-02 — "봄`" W1).
 * 정책: 오염 누락분만 보강 — 기존 pilot/Vraxium-native 행 보존·중복 생성 금지(부재 시만 insert).
 *   uwp 는 1차 apply 가 날짜 귀속으로 이미 적재(FLIP 0 — cm 변경 불요) → 무접촉.
 *   write 범위: uws insert(부재 시) + 경험행(타깃 재사용·부재 시만) + P4/P5 snapshot 재계산.
 */
import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK_FILE = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK_FILE ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/pilot-backfill-2weeks-${MODE}-${STAMP}.json`;

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

const TARGET_USERS = [
  { p: "P4", uid: 248, name: "박시은" },
  { p: "P5", uid: 251, name: "정혜빈" },
];
const TARGET_WEEK_STARTS = ["2025-12-29", "2026-03-02"];

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const issues: string[] = [];
  for (const t of ["cluster4_experience_line_evaluations", "cluster4_line_submissions", "cluster4_line_targets", "user_week_statuses"]) {
    const ids: string[] = (log.inserted ?? []).filter((r: any) => r.table === t).map((r: any) => r.id);
    if (!ids.length) continue;
    const { error } = await sb.from(t).delete().in("id", ids);
    if (error) issues.push(`${t}: ${error.message}`);
  }
  for (const u of log.users ?? []) {
    try { await recalcUserGrowthStats(u.uuid); await recomputeAndStoreWeeklyCardsSnapshot(u.uuid); } catch (e) { issues.push(`recalc/snapshot ${u.uuid}: ${e}`); }
  }
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", source: file, issues }, null, 1));
  console.log(issues.length ? issues.join("\n") : "rollback 완료");
  process.exit(issues.length ? 1 : 0);
}

async function main() {
  if (ROLLBACK_FILE) return rollback(ROLLBACK_FILE);
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });
  const { data: wk } = await sb.from("weeks").select("id,season_key,week_number,start_date,end_date,iso_year,iso_week").in("start_date", TARGET_WEEK_STARTS);
  const weekByStart = new Map(((wk ?? []) as any[]).map((w) => [w.start_date, w]));
  const { data: lines } = await sb.from("cluster4_lines").select("id,week_id").in("week_id", ((wk ?? []) as any[]).map((w) => w.id)).like("line_code", "EXBS-EN%");
  const lineByWeekId = new Map(((lines ?? []) as any[]).map((l) => [l.week_id, l.id]));

  const plan: any[] = [];
  const inserted: Array<{ table: string; id: string }> = [];
  const users: any[] = [];
  const errors: string[] = [];

  for (const t of TARGET_USERS) {
    const { data: u } = await sb.from("users").select("id").eq("source_system", "olympus").eq("legacy_user_id", t.uid).maybeSingle();
    const uuid = (u as any).id;
    users.push({ pilot: t.p, uuid });
    // PMS 원본 (오염 2행 — 강화 정규화 기준 해당 주차)
    const [rows] = (await conn.query(
      `SELECT Season, SeasonWeek, IsActive, Star, Activity, CAST(DATE(StartDate) AS CHAR) AS s
       FROM olympus.useractivities WHERE UserId=? AND SeasonWeek=1
         AND DATE(StartDate) IN ('2025-12-29','2026-03-02') ORDER BY StartDate`, [t.uid])) as [any[], unknown];
    for (const r of rows) {
      const start = String(r.s).slice(0, 10);
      const w = weekByStart.get(start);
      if (!w) { errors.push(`${t.p} ${start}: weeks 부재`); continue; }
      // 기존 행 존재 검사 (중복 금지)
      const { data: exUws } = await sb.from("user_week_statuses").select("id,status").eq("user_id", uuid).eq("week_start_date", start).maybeSingle();
      const { data: exT } = await sb.from("cluster4_line_targets").select("id").eq("target_user_id", uuid).eq("week_id", w.id).maybeSingle();
      let exSub = null, exEval = null;
      if (exT) {
        const { data: s1 } = await sb.from("cluster4_line_submissions").select("id").eq("line_target_id", (exT as any).id).maybeSingle();
        const { data: e1 } = await sb.from("cluster4_experience_line_evaluations").select("id").eq("line_target_id", (exT as any).id).maybeSingle();
        exSub = s1; exEval = e1;
      }
      const status = r.IsActive === 1 ? "success" : "fail";
      plan.push({
        pilot: t.p, week: `${w.season_key} W${w.week_number}`, start, status, rating: r.Star,
        uws: exUws ? `보존(${(exUws as any).status})` : "insert",
        target: exT ? "재사용" : "insert",
        submission: exSub ? "보존" : "insert",
        evaluation: exEval ? "보존" : r.Star != null ? "insert" : "-",
      });
      if (!APPLY) continue;
      // ── apply ──
      const nowIso = new Date().toISOString();
      if (!exUws) {
        const id = randomUUID();
        const { error } = await sb.from("user_week_statuses").insert({
          id, user_id: uuid, year: w.iso_year, week_number: w.iso_week, week_start_date: start,
          status, season_key: w.season_key,
        });
        if (error) { errors.push(`${t.p} uws ${start}: ${error.message}`); continue; }
        inserted.push({ table: "user_week_statuses", id });
      }
      let tid = (exT as any)?.id ?? null;
      if (!tid) {
        tid = randomUUID();
        const { error } = await sb.from("cluster4_line_targets").insert({
          id: tid, line_id: lineByWeekId.get(w.id), week_id: w.id, target_mode: "user", target_user_id: uuid, target_rule: {},
        });
        if (error) { errors.push(`${t.p} target ${start}: ${error.message}`); continue; }
        inserted.push({ table: "cluster4_line_targets", id: tid });
      }
      if (!exSub) {
        const sid = randomUUID();
        const { error } = await sb.from("cluster4_line_submissions").insert({
          id: sid, line_target_id: tid, user_id: uuid, subtitle: String(r.Activity ?? "주차 활동 내역(PMS 이관 보강)").slice(0, 500),
          submitted_at: `${w.end_date}T22:59:59Z`, output_links: [], output_images: [], growth_point: null, // PMS 이관: growth_point 미저장
        });
        if (error) { errors.push(`${t.p} submission ${start}: ${error.message}`); continue; }
        inserted.push({ table: "cluster4_line_submissions", id: sid });
      }
      if (!exEval && r.Star != null) {
        const eid = randomUUID();
        const { error } = await sb.from("cluster4_experience_line_evaluations").insert({
          id: eid, line_target_id: tid, user_id: uuid, rating: Number(r.Star), evaluated_at: `${w.end_date}T23:00:00Z`,
        });
        if (error) { errors.push(`${t.p} evaluation ${start}: ${error.message}`); continue; }
        inserted.push({ table: "cluster4_experience_line_evaluations", id: eid });
      }
      void nowIso;
    }
  }
  await conn.end();

  if (APPLY && errors.length === 0) {
    for (const u of users) {
      try {
        await recalcUserGrowthStats(u.uuid);
        await recomputeAndStoreWeeklyCardsSnapshot(u.uuid);
      } catch (e) { errors.push(`recalc/snapshot ${u.uuid}: ${e}`); }
    }
  }
  writeFileSync(OUT, JSON.stringify({ mode: MODE, plan, inserted, users, errors }, null, 1));
  console.log(`mode=${MODE}`);
  for (const p of plan) console.log(` ${p.pilot} ${p.week} (${p.start}) status=${p.status} rating=${p.rating} | uws:${p.uws} target:${p.target} sub:${p.submission} eval:${p.evaluation}`);
  if (APPLY) console.log(`inserted ${inserted.length}행 · snapshot 재계산 ${users.length}명 · errors ${errors.length}`);
  console.log("→", OUT);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
