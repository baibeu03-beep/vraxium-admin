// PMS → Vraxium pointlogs 증분 동기화 (additive-only · idempotent).
//
//   목적: PMS 가 컷오버(2026-06-08 일회성 이관) 이후에도 계속 적립하는 신규 pointlogs
//   (예: "심화 크루 별 자동 부여")를 Vraxium 에 증분 반영해 점수 drift 를 막는다.
//   ⚠ PMS 잔액(userspoint.Star) 동기화가 아니라 pointlogs 신규 이벤트 반영이다 —
//      sentinel 보정으로 잔액을 강제로 맞추지 않는다(미귀속/미매칭은 skip + report).
//
// 멱등성(두 축 모두 재실행 안전):
//   1) ledger 삽입 = legacy_point_ledger UNIQUE(source_table, source_pk) +
//      upsert ignoreDuplicates → 이미 이관된 LogNum 은 무시(중복 적립 금지).
//   2) uwp 반영 = 영향 (user, week) 만 ledger 재합산(re-sum)으로 덮어쓰기(가산 아님).
//      → 같은 sync 두 번 = 2회차 insert 0 · uwp 변화 0.
//
// 범위(additive-only, 2026-06 브리지 결정):
//   - 신규 = source 별 watermark(=ledger 내 max source_pk) 초과 LogNum 만 조회.
//     PMS LogNum 은 전역 증가라 컷오버 이후 신규 적립은 항상 watermark 보다 크다.
//   - 기존 로그 삭제/소급수정은 추적하지 않는다(최근 14일 재대조 제외). IsDeleted=1
//     신규 로그는 skip + report(suspectDeleted).
//   - week 미귀속 로그 skip + report(sentinel 가산 금지).
//   - source UserId ↔ Vraxium user 미매칭 skip + report(신규 user 생성 안 함).
//   - 테스트 계정(test_user_markers) 제외 — skip + report(testSkipped).
//
// 반영 후 캐시 동기화(영향 user 만): user_cumulative_points(직접 upsert — 자동 트리거
//   미적용 DB) · user_growth_stats(recalcUserGrowthStats) · user_grade_stats(syncGradeStats)
//   · weekly-cards snapshot(invalidateWeeklyCardsForUsers → 재계산).
//
// ON/OFF: 이 lib 은 순수 함수(게이트 미검사). 호출부(route=cron)가 ENABLE_PMS_INCREMENTAL_SYNC
//   를 검사한다. PMS 종료 시 환경변수만 OFF → 코드/구조 변경 없이 자동 동기화 중단.

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import mysql from "mysql2/promise";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  ledgerSourceTable,
  resolveOrganizationSlug,
  type PmsSourceSystem,
} from "@/lib/pmsMigration";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { syncGradeStats } from "@/lib/cluster3ClubRankData";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

export const PMS_SYNC_SOURCES: PmsSourceSystem[] = ["oranke", "hrdb", "olympus"];

// PMS ActivityTime 보정(이관 산식과 동일): YY(20~99)→20YY · YEAR=1 → createtime · else ActivityTime.
const CORR_SQL = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                       WHEN YEAR(ActivityTime)=1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;

type LiveWeek = {
  id: string;
  start_date: string;
  end_date: string;
  iso_year: number | null;
  iso_week: number | null;
  week_number: number;
};

export type PmsSyncReport = {
  apply: boolean;
  startedAt: string;
  durationMs: number;
  sources: PmsSourceSystem[];
  perSource: Record<string, { watermark: number; fetched: number }>;
  newLogsFetched: number;
  alreadyMigratedSkipped: number;
  ledgerInserted: number;
  affectedUsers: number;
  affectedWeeks: number;
  unmatchedUserLogs: number;
  unmatchedUsers: Array<{ source: string; uid: number; logs: number }>;
  unattributedLogs: number;
  unattributedSample: Array<{ source: string; logNum: number; corrected: string; star: number }>;
  suspectDeletedLogs: number;
  testSkippedLogs: number;
  testSkippedUsers: string[];
  snapshotsRecomputed: number;
  snapshotMode: string;
  cacheSynced: { cumulative: number; growthStats: number; gradeStats: number };
  sampleAffected: Array<{ userId: string; name: string | null; org: string; weeks: number; addedStar: number }>;
};

type NewLog = {
  source: PmsSourceSystem;
  logNum: number;
  code: string;
  log: string;
  info: string | null;
  star: number;
  shield: number;
  isDeleted: number;
  corrected: string;
  raw: Record<string, unknown>;
};

// MySQL 자격 — 로컬(.env.local 존재)은 파일 직접 파싱으로 읽는다. tsx --env-file 파서는
//   값 안의 '#' 을 주석으로 절단해 비밀번호가 잘리는 트랩이 있어(실측: 끝 '#' 1자 손실)
//   파일을 우선한다. 배포(파일 부재)는 process.env(@next/env 가 정상 파싱) 로 폴백.
function readEnvCreds(): Record<string, string | undefined> {
  const keys = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD"];
  const fromFile: Record<string, string> = {};
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const k of keys) {
      const m = raw.match(new RegExp(`^${k}=(.+)$`, "m"));
      if (m) fromFile[k] = m[1].trim();
    }
  } catch {
    /* 배포 등 파일 부재 — process.env 사용 */
  }
  return Object.fromEntries(keys.map((k) => [k, fromFile[k] ?? process.env[k]]));
}

function mysqlConn() {
  const creds = readEnvCreds();
  const host = creds.MYSQL_HOST;
  const user = creds.MYSQL_USER;
  const password = creds.MYSQL_PASSWORD;
  if (!host || !user || password == null) {
    throw new Error("MYSQL_* 환경변수 미설정 — PMS 접속 불가(fail-closed).");
  }
  return mysql.createConnection({
    host,
    port: Number(creds.MYSQL_PORT ?? 3306),
    user,
    password,
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
}

async function fetchAllSb<T>(
  table: string,
  select: string,
  orderCol: string,
  filt?: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = supabaseAdmin.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

// source 별 watermark = legacy_point_ledger 내 해당 source_table 의 max(source_pk).
//   sentinel(source_pk<0) 은 max 에 영향 없음. 행 없으면 0(전체가 신규).
async function watermarkFor(sourceTable: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("legacy_point_ledger")
    .select("source_pk")
    .eq("source_table", sourceTable)
    .order("source_pk", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`watermark(${sourceTable}): ${error.message}`);
  const v = Number((data as { source_pk: number } | null)?.source_pk ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * PMS → Vraxium pointlogs 증분 동기화.
 * @param opts.apply  false=dry-run(write 0), true=실제 반영
 * @param opts.sources 대상 소스(기본 전체)
 * @param opts.log    진행 로그 콜백
 */
export async function syncPmsPointlogsIncremental(opts: {
  apply: boolean;
  sources?: PmsSourceSystem[];
  log?: (msg: string) => void;
}): Promise<PmsSyncReport> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const apply = opts.apply;
  const sources = opts.sources ?? PMS_SYNC_SOURCES;
  const log = opts.log ?? (() => {});

  // ── 공통 로드 ──
  const weeks = await fetchAllSb<LiveWeek>(
    "weeks",
    "id,start_date,end_date,iso_year,iso_week,week_number",
    "start_date",
  );
  const weekByRange = (d: string): LiveWeek | null =>
    weeks.find((w) => d >= w.start_date && d <= w.end_date) ?? null;

  const markers = new Set(
    (await fetchAllSb<{ user_id: string }>("test_user_markers", "user_id", "user_id")).map((m) => m.user_id),
  );

  // (source, legacy_user_id) → user_id
  const usersRows = await fetchAllSb<{ id: string; source_system: string; legacy_user_id: number | null }>(
    "users",
    "id,source_system,legacy_user_id",
    "id",
    (q) => q.in("source_system", sources),
  );
  const userByPair = new Map<string, string>();
  for (const u of usersRows) {
    if (u.legacy_user_id != null) userByPair.set(`${u.source_system}:${u.legacy_user_id}`, u.id);
  }

  // ── 1) source 별 신규 pointlogs 조회 ──
  const perSource: PmsSyncReport["perSource"] = {};
  const newLogs: NewLog[] = [];
  const conn = await mysqlConn();
  try {
    for (const src of sources) {
      const sourceTable = ledgerSourceTable(src, "pointlogs"); // "<src>.pointlogs"
      const watermark = await watermarkFor(sourceTable);
      const [rows] = (await conn.query(
        `SELECT LogNum, UserID, code, log, Info, Star, Shield, IsDeleted,
                CAST(ActivityTime AS CHAR) AS ActivityTime, CAST(createtime AS CHAR) AS createtime,
                CAST(${CORR_SQL} AS CHAR) AS corrected
         FROM ${src}.pointlogs WHERE LogNum > ? ORDER BY LogNum`,
        [watermark],
      )) as [any[], unknown];
      perSource[src] = { watermark, fetched: rows.length };
      log(`[${src}] watermark=${watermark} 신규 ${rows.length}건`);
      for (const r of rows) {
        newLogs.push({
          source: src,
          logNum: Number(r.LogNum),
          code: String(r.code ?? ""),
          log: String(r.log ?? ""),
          info: r.Info != null ? String(r.Info) : null,
          star: Number(r.Star ?? 0),
          shield: Number(r.Shield ?? 0),
          isDeleted: Number(r.IsDeleted ?? 0),
          corrected: String(r.corrected ?? "").slice(0, 10),
          raw: r as Record<string, unknown>,
        });
      }
    }
  } finally {
    await conn.end();
  }

  // ── 2) 분류: 반영 대상 vs skip ──
  const ledgerToInsert: Array<Record<string, unknown>> = [];
  const affectedPairs = new Set<string>(); // `${userId}:${weekId}`
  const affectedUserIds = new Set<string>();
  const affectedWeekIds = new Set<string>();
  const addedStarByUser = new Map<string, number>();

  let suspectDeletedLogs = 0;
  let unattributedLogs = 0;
  const unattributedSample: PmsSyncReport["unattributedSample"] = [];
  let testSkippedLogs = 0;
  const testSkippedUsers = new Set<string>();
  const unmatchedCount = new Map<string, number>(); // `${src}:${uid}` → logs
  const nowIso = new Date(startedAtMs).toISOString();

  for (const r of newLogs) {
    const pmsUid = Number(r.raw.UserID ?? r.raw.UserId ?? NaN);
    const pairKey = `${r.source}:${pmsUid}`;
    const userId = Number.isFinite(pmsUid) ? userByPair.get(pairKey) : undefined;

    if (!userId) {
      unmatchedCount.set(pairKey, (unmatchedCount.get(pairKey) ?? 0) + 1);
      continue;
    }
    if (markers.has(userId)) {
      testSkippedLogs++;
      testSkippedUsers.add(userId);
      continue;
    }
    if (r.isDeleted === 1) {
      // additive-only: 삭제/voided 신규 로그는 반영하지 않는다(skip + report).
      suspectDeletedLogs++;
      continue;
    }
    const w = weekByRange(r.corrected);
    if (!w) {
      unattributedLogs++;
      if (unattributedSample.length < 50)
        unattributedSample.push({ source: r.source, logNum: r.logNum, corrected: r.corrected, star: r.star });
      continue;
    }

    ledgerToInsert.push({
      id: randomUUID(),
      source_table: ledgerSourceTable(r.source, "pointlogs"),
      source_pk: r.logNum,
      user_id: userId,
      legacy_user_id: pmsUid,
      week_id: w.id,
      occurred_at: `${r.corrected}T00:00:00Z`,
      code: r.code,
      reason: r.log,
      star: r.star,
      shield: r.shield,
      entry_type: "POINTLOG",
      snapshot: r.raw,
      payload: { Info: r.info, IsDeleted: r.isDeleted },
      migrated_at: nowIso,
      created_by: "pms-incr-sync",
    });
    affectedPairs.add(`${userId}:${w.id}`);
    affectedUserIds.add(userId);
    affectedWeekIds.add(w.id);
    addedStarByUser.set(userId, (addedStarByUser.get(userId) ?? 0) + r.star);
  }

  const unmatchedUsers = [...unmatchedCount.entries()].map(([k, logs]) => {
    const [source, uid] = k.split(":");
    return { source, uid: Number(uid), logs };
  });
  const unmatchedUserLogs = unmatchedUsers.reduce((s, u) => s + u.logs, 0);

  const baseReport: PmsSyncReport = {
    apply,
    startedAt,
    durationMs: 0,
    sources,
    perSource,
    newLogsFetched: newLogs.length,
    alreadyMigratedSkipped: 0,
    ledgerInserted: 0,
    affectedUsers: affectedUserIds.size,
    affectedWeeks: affectedWeekIds.size,
    unmatchedUserLogs,
    unmatchedUsers,
    unattributedLogs,
    unattributedSample,
    suspectDeletedLogs,
    testSkippedLogs,
    testSkippedUsers: [...testSkippedUsers],
    snapshotsRecomputed: 0,
    snapshotMode: "none",
    cacheSynced: { cumulative: 0, growthStats: 0, gradeStats: 0 },
    sampleAffected: [],
  };

  // dry-run: 여기서 종료(write 0).
  if (!apply) {
    baseReport.durationMs = Date.now() - startedAtMs;
    return baseReport;
  }

  // ── 3) APPLY: ledger 삽입(멱등) ──
  let inserted = 0;
  let duplicates = 0;
  for (let i = 0; i < ledgerToInsert.length; i += 200) {
    const chunk = ledgerToInsert.slice(i, i + 200);
    const { data, error } = await supabaseAdmin
      .from("legacy_point_ledger")
      .upsert(chunk, { onConflict: "source_table,source_pk", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`ledger insert: ${error.message}`);
    const got = (data ?? []).length;
    inserted += got;
    duplicates += chunk.length - got; // ignoreDuplicates 로 무시된 기존 행
  }
  baseReport.ledgerInserted = inserted;
  baseReport.alreadyMigratedSkipped = duplicates;
  log(`ledger insert ${inserted} · dup skip ${duplicates}`);

  // ── 4) 영향 (user, week) uwp 재합산(멱등 덮어쓰기) ──
  // 영향 user 의 ledger POINTLOG 전부를 읽어 (user, week) 별 재합산. 영향 week 만 반영.
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const affectedUserList = [...affectedUserIds];
  // ledger 재조회(방금 삽입분 포함) — 영향 user 한정.
  const ledgerByUserWeek = new Map<string, { points: number; adv: number; pen: number }>();
  for (let i = 0; i < affectedUserList.length; i += 50) {
    const chunk = affectedUserList.slice(i, i + 50);
    const rows = await fetchAllSb<{ user_id: string; week_id: string | null; star: number; shield: number; entry_type: string }>(
      "legacy_point_ledger",
      "user_id,week_id,star,shield,entry_type",
      "user_id",
      (q) => q.in("user_id", chunk).eq("entry_type", "POINTLOG"),
    );
    for (const r of rows) {
      if (!r.week_id) continue;
      const key = `${r.user_id}:${r.week_id}`;
      if (!affectedPairs.has(key)) continue; // 영향받은 (user, week) 만 재계산
      let a = ledgerByUserWeek.get(key);
      if (!a) { a = { points: 0, adv: 0, pen: 0 }; ledgerByUserWeek.set(key, a); }
      a.points += r.star ?? 0;
      const sh = r.shield ?? 0;
      if (sh > 0) a.adv += sh;
      else if (sh < 0) a.pen += -sh;
    }
  }

  // 기존 uwp 조회(checks_migrated 보존). 키 = user_id + week_start_date.
  const existingUwp = new Map<string, { id: string; checks_migrated: boolean }>();
  for (let i = 0; i < affectedUserList.length; i += 50) {
    const chunk = affectedUserList.slice(i, i + 50);
    const rows = await fetchAllSb<{ id: string; user_id: string; week_start_date: string; checks_migrated: boolean }>(
      "user_weekly_points",
      "id,user_id,week_start_date,checks_migrated",
      "id",
      (q) => q.in("user_id", chunk),
    );
    for (const r of rows) existingUwp.set(`${r.user_id}:${r.week_start_date}`, { id: r.id, checks_migrated: r.checks_migrated });
  }

  for (const [key, agg] of ledgerByUserWeek) {
    const [userId, weekId] = key.split(":");
    const w = weekById.get(weekId);
    if (!w) continue;
    const ex = existingUwp.get(`${userId}:${w.start_date}`);
    if (ex) {
      const { error } = await supabaseAdmin
        .from("user_weekly_points")
        .update({ points: agg.points, advantages: agg.adv, penalty: agg.pen, updated_at: nowIso })
        .eq("id", ex.id);
      if (error) throw new Error(`uwp update ${userId} ${w.start_date}: ${error.message}`);
    } else {
      const { error } = await supabaseAdmin.from("user_weekly_points").insert({
        id: randomUUID(),
        user_id: userId,
        year: w.iso_year ?? Number(w.start_date.slice(0, 4)),
        week_number: w.iso_week ?? w.week_number,
        week_start_date: w.start_date,
        points: agg.points,
        advantages: agg.adv,
        penalty: agg.pen,
        checks_migrated: false, // 보너스 적립 주차 — 체크게이트 미관여(보수적).
      });
      if (error) throw new Error(`uwp insert ${userId} ${w.start_date}: ${error.message}`);
    }
  }

  // ── 5) 캐시 동기화(영향 user) ──
  let cumN = 0, growthN = 0, gradeN = 0;
  for (const userId of affectedUserList) {
    // 5a. user_cumulative_points 직접 upsert(자동 트리거 미적용 DB — 실제 컬럼 기준).
    const uwpRows = await fetchAllSb<{ points: number; advantages: number; penalty: number }>(
      "user_weekly_points",
      "points,advantages,penalty",
      "id",
      (q) => q.eq("user_id", userId),
    );
    let sp = 0, sa = 0, spen = 0;
    for (const r of uwpRows) { sp += r.points ?? 0; sa += r.advantages ?? 0; spen += r.penalty ?? 0; }
    const { error: cumErr } = await supabaseAdmin.from("user_cumulative_points").upsert(
      {
        user_id: userId,
        total_checks: sp,
        total_raw_advantages: sa,
        total_penalties: spen,
        total_advantages: sa - spen, // net 방패
        updated_at: nowIso,
      },
      { onConflict: "user_id" },
    );
    if (cumErr) throw new Error(`cumulative upsert ${userId}: ${cumErr.message}`);
    cumN++;

    // 5b. user_growth_stats(uws 기반 — 멱등) · 5c. user_grade_stats(품계 재계산).
    try { await recalcUserGrowthStats(userId); growthN++; } catch (e) { log(`growthStats ${userId} 실패(격리): ${(e as Error).message}`); }
    try { await syncGradeStats(userId); gradeN++; } catch (e) { log(`gradeStats ${userId} 실패(격리): ${(e as Error).message}`); }
  }
  baseReport.cacheSynced = { cumulative: cumN, growthStats: growthN, gradeStats: gradeN };

  // ── 6) snapshot 재계산(영향 user) ──
  const inv = await invalidateWeeklyCardsForUsers(affectedUserList);
  baseReport.snapshotMode = inv.mode;
  baseReport.snapshotsRecomputed = inv.count;
  log(`snapshot invalidate mode=${inv.mode} count=${inv.count}`);

  // ── 7) sample(보고용) ──
  if (affectedUserList.length) {
    const profs = await fetchAllSb<{ user_id: string; display_name: string | null; organization_slug: string | null }>(
      "user_profiles",
      "user_id,display_name,organization_slug",
      "user_id",
      (q) => q.in("user_id", affectedUserList.slice(0, 200)),
    );
    const pById = new Map(profs.map((p) => [p.user_id, p]));
    const weeksByUser = new Map<string, number>();
    for (const key of affectedPairs) {
      const uid = key.split(":")[0];
      weeksByUser.set(uid, (weeksByUser.get(uid) ?? 0) + 1);
    }
    baseReport.sampleAffected = affectedUserList
      .map((uid) => ({
        userId: uid,
        name: pById.get(uid)?.display_name ?? null,
        org: pById.get(uid)?.organization_slug ?? "?",
        weeks: weeksByUser.get(uid) ?? 0,
        addedStar: addedStarByUser.get(uid) ?? 0,
      }))
      .sort((a, b) => b.addedStar - a.addedStar)
      .slice(0, 50);
  }

  baseReport.durationMs = Date.now() - startedAtMs;
  return baseReport;
}
