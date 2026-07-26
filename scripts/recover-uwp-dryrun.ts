/**
 * READ-ONLY dry-run — 2026-07-25 `2026-07-25_point_resolver_sot.sql` §2 가 소멸시킨
 * user_weekly_points 활동주차 포인트의 복구 예상값 산출. **write 0 (select 만 발행)**.
 *
 *   npx tsx --env-file=.env.local scripts/recover-uwp-dryrun.ts
 *
 * 재구성 규칙 = apply-pms-{pilot-5,source-batch,olympus-batch}.ts / promote-restusers.ts /
 *   apply-held3-migration.ts / apply-jeonhyeonseong-migration.ts / pmsPointlogsSync.ts 와 동일:
 *     · 대상 = legacy_point_ledger 의 POINTLOG + POINTLOG_VOIDED (week_id NOT NULL)
 *       - MIGRATION_ADJUSTMENT(week_id NULL, 629행) = 1900-01-01 sentinel 행 전용 → 주차 복구 대상 아님
 *     · points += star   ← IsDeleted 무관 (POINTLOG_VOIDED 도 star 는 합산)
 *     · 활동시작 14일 이내 음수 star 보호: star<0 && corrected < (usersinfo.StartDate + 14d) → star=0
 *       (StartDate < 2020-01-01 이거나 부재면 보호 미적용 = 원 스크립트 "0000-00-00" 과 동일)
 *     · shield 는 IsDeleted=0(=entry_type POINTLOG) 만: >0 → advantage, <0 → penalty magnitude
 *     · 동일 (user, week) 복수 행은 단순 합산 (원 스크립트의 agg 와 동일)
 *     · week 귀속 = ledger.week_id (이관 당시 weekByRange(corrected) 결과) → weeks.start_date
 *
 * 출력: claudedocs/recover-uwp-dryrun-<stamp>.{json,csv} + 콘솔 요약.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import mysql from "mysql2/promise";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Num = number | null;
const WIPE_PREFIX = "2026-07-25T04:52:05";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_JSON = `claudedocs/recover-uwp-dryrun-${STAMP}.json`;
const OUT_CSV = `claudedocs/recover-uwp-dryrun-${STAMP}.csv`;

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const addDays = (iso: string, d: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};

function readEnvCreds() {
  const keys = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD"];
  const fromFile: Record<string, string> = {};
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const k of keys) {
      const m = raw.match(new RegExp(`^${k}=(.+)$`, "m"));
      if (m) fromFile[k] = m[1].trim();
    }
  } catch {
    /* noop */
  }
  return Object.fromEntries(keys.map((k) => [k, fromFile[k] ?? process.env[k]])) as Record<string, string | undefined>;
}

type Agg = { points: number; adv: number; pen: number; rows: number; protectedZeroed: number; voidedRows: number };

async function main() {
  mkdirSync("claudedocs", { recursive: true });

  // ── 0. weeks ──
  const weeks = await pageAll<{ id: string; start_date: string | null; end_date: string | null; iso_year: Num; iso_week: Num; week_number: Num; season_key: string | null; is_official_rest: boolean | null }>(
    (f, t) => supabaseAdmin.from("weeks").select("id,start_date,end_date,iso_year,iso_week,week_number,season_key,is_official_rest").order("start_date").range(f, t),
  );
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const weekKind = new Map<string, "rest" | "transition" | "activity">();
  for (const w of weeks) {
    if (!w.start_date) continue;
    weekKind.set(w.start_date, w.week_number === 0 ? "transition" : w.is_official_rest ? "rest" : "activity");
  }

  // ── 1. users / profiles / test markers ──
  const users = await pageAll<{ id: string; source_system: string | null; legacy_user_id: number | null }>(
    (f, t) => supabaseAdmin.from("users").select("id,source_system,legacy_user_id").order("id").range(f, t),
  );
  const userMeta = new Map(users.map((u) => [u.id, u]));
  const profiles = await pageAll<{ user_id: string; display_name: string | null; organization_slug: string | null; activity_started_at: string | null }>(
    (f, t) => supabaseAdmin.from("user_profiles").select("user_id,display_name,organization_slug,activity_started_at").order("user_id").range(f, t),
  );
  const profById = new Map(profiles.map((p) => [p.user_id, p]));
  const markers = new Set((await pageAll<{ user_id: string }>((f, t) => supabaseAdmin.from("test_user_markers").select("user_id").order("user_id").range(f, t))).map((m) => m.user_id));

  // ── 2. PMS usersinfo.StartDate (14일 보호 규칙 원천) — fail-closed ──
  const creds = readEnvCreds();
  if (!creds.MYSQL_HOST || !creds.MYSQL_USER || creds.MYSQL_PASSWORD == null) {
    throw new Error("MYSQL_* 미설정 — 14일 보호 규칙을 재현할 수 없어 fail-closed (dry-run 중단).");
  }
  const conn = await mysql.createConnection({
    host: creds.MYSQL_HOST,
    port: Number(creds.MYSQL_PORT ?? 3306),
    user: creds.MYSQL_USER,
    password: creds.MYSQL_PASSWORD,
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const startDateByPair = new Map<string, string>(); // `${src}:${uid}` → StartDate(YYYY-MM-DD)
  for (const src of ["oranke", "hrdb", "olympus"]) {
    const [rows] = (await conn.query(`SELECT UserID, CAST(StartDate AS CHAR) AS StartDate FROM ${src}.usersinfo`)) as [any[], unknown];
    for (const r of rows) {
      const sd = String(r.StartDate ?? "").slice(0, 10);
      if (sd) startDateByPair.set(`${src}:${Number(r.UserID)}`, sd);
    }
    console.log(`[pms] ${src}.usersinfo StartDate ${rows.length}행 로드`);
  }
  await conn.end();

  // ── 3. ledger 전체 (POINTLOG + POINTLOG_VOIDED) ──
  const led = await pageAll<{
    source_table: string | null; source_pk: number | null; user_id: string | null; legacy_user_id: number | null;
    week_id: string | null; occurred_at: string | null; star: Num; shield: Num; entry_type: string | null; code: string | null;
  }>((f, t) =>
    supabaseAdmin
      .from("legacy_point_ledger")
      .select("source_table,source_pk,user_id,legacy_user_id,week_id,occurred_at,star,shield,entry_type,code")
      .order("id")
      .range(f, t),
  );
  console.log(`[ledger] ${led.length}행 로드`);

  // protectUntil per user_id
  const protectUntil = new Map<string, string>();
  let noStartDate = 0;
  for (const u of users) {
    if (!u.source_system || u.legacy_user_id == null) continue;
    const sd = startDateByPair.get(`${u.source_system}:${u.legacy_user_id}`);
    if (sd && sd >= "2020-01-01") protectUntil.set(u.id, addDays(sd, 14));
    else if (!sd) noStartDate++;
  }

  // (user_id, week_id) 집계
  const agg = new Map<string, Agg>();
  let skippedNullWeek = 0;
  let skippedAdjustment = 0;
  let ledgerNoUser = 0;
  const ledgerUsers = new Set<string>();
  for (const r of led) {
    if (r.entry_type === "MIGRATION_ADJUSTMENT") { skippedAdjustment++; continue; }
    if (!r.user_id) { ledgerNoUser++; continue; }
    ledgerUsers.add(r.user_id);
    if (!r.week_id) { skippedNullWeek++; continue; }
    const key = `${r.user_id}|${r.week_id}`;
    let a = agg.get(key);
    if (!a) { a = { points: 0, adv: 0, pen: 0, rows: 0, protectedZeroed: 0, voidedRows: 0 }; agg.set(key, a); }
    a.rows++;
    if (r.entry_type === "POINTLOG_VOIDED") a.voidedRows++;
    const corrected = String(r.occurred_at ?? "").slice(0, 10);
    let star = r.star ?? 0;
    const pu = protectUntil.get(r.user_id);
    if (star < 0 && pu && corrected < pu) { star = 0; a.protectedZeroed++; }
    a.points += star;
    const sh = r.shield ?? 0;
    if (r.entry_type === "POINTLOG") {
      if (sh > 0) a.adv += sh;
      else if (sh < 0) a.pen += -sh;
    }
  }

  // (user_id, week_start_date) 로 환산 — 동일 주차 매핑 충돌 검출
  const expected = new Map<string, Agg>();
  let weekIdUnmapped = 0;
  const collided: string[] = [];
  for (const [key, a] of agg) {
    const [userId, weekId] = key.split("|");
    const w = weekById.get(weekId);
    if (!w?.start_date) { weekIdUnmapped++; continue; }
    const k2 = `${userId}|${w.start_date}`;
    const prev = expected.get(k2);
    if (prev) {
      collided.push(k2);
      prev.points += a.points; prev.adv += a.adv; prev.pen += a.pen;
      prev.rows += a.rows; prev.protectedZeroed += a.protectedZeroed; prev.voidedRows += a.voidedRows;
    } else {
      expected.set(k2, { ...a });
    }
  }

  // ── 4. 현재 uwp ──
  const uwp = await pageAll<{
    id: string; user_id: string; year: Num; week_number: Num; week_start_date: string | null;
    points: Num; advantages: Num; penalty: Num; checks_migrated: boolean | null; updated_at: string | null;
  }>((f, t) =>
    supabaseAdmin
      .from("user_weekly_points")
      .select("id,user_id,year,week_number,week_start_date,points,advantages,penalty,checks_migrated,updated_at")
      .order("id")
      .range(f, t),
  );
  const uwpByKey = new Map(uwp.map((r) => [`${r.user_id}|${r.week_start_date}`, r]));

  // ── 4-b) §2 wipe 마커 원천 ────────────────────────────────────────────
  //   ⚠ user_weekly_points 에는 updated_at 자동 갱신 트리거가 있다. 2026-07-26 06:39 의
  //   legacy baseline 백필 UPDATE 가 전 14,581행의 updated_at 을 덮으면서 §2 실행 시각
  //   (2026-07-25T04:52:05.480492+00) 마커가 라이브 DB 에서 완전히 사라졌다.
  //   포인트 값은 무손상이지만 "이 행이 §2 피해행" 이라는 증거만 없어진 것이라,
  //   마커는 복구 전에 떠 둔 동결 스냅샷(backups/uwp-baseline-freeze-*/user_weekly_points.json)
  //   에서 읽는다. 동결본이 없으면 라이브 updated_at 으로 폴백한다(마이그 이전 환경 호환).
  const freezeDirs = existsSync("backups")
    ? readdirSync("backups").filter((d) => d.startsWith("uwp-baseline-freeze-")).sort()
    : [];
  const wipedIds = new Set<string>();
  let markerSource = "live updated_at";
  for (const d of freezeDirs) {
    const p = `backups/${d}/user_weekly_points.json`;
    if (!existsSync(p)) continue;
    const rows = JSON.parse(readFileSync(p, "utf8")) as Array<{ id: string; updated_at: string | null }>;
    const hits = rows.filter((r) => String(r.updated_at ?? "").startsWith(WIPE_PREFIX));
    if (hits.length > 0) {
      for (const r of hits) wipedIds.add(r.id);
      markerSource = `freeze:${d} (${hits.length}행)`;
      break; // 가장 이른 동결본 = §2 직후 상태
    }
  }
  const isWiped = (row: { id: string; updated_at: string | null } | undefined): boolean => {
    if (!row) return false;
    if (wipedIds.size > 0) return wipedIds.has(row.id);
    return String(row.updated_at ?? "").startsWith(WIPE_PREFIX);
  };
  console.log(`[marker] §2 wipe 판정 원천 = ${markerSource}`);

  // ── 5. process_point_awards (active) — §2 면제 키 & 중복 위험 ──
  const ppa = await pageAll<{ user_id: string; year: Num; week_number: Num; point_check: Num; point_advantage: Num; point_penalty: Num; cancelled_at: string | null }>(
    (f, t) => supabaseAdmin.from("process_point_awards").select("user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at").order("id").range(f, t),
  );
  const ppaByYW = new Map<string, { a: number; adv: number; pen: number; rows: number }>();
  for (const r of ppa) {
    if (r.cancelled_at) continue;
    const k = `${r.user_id}|${r.year}|${r.week_number}`;
    const e = ppaByYW.get(k) ?? { a: 0, adv: 0, pen: 0, rows: 0 };
    e.a += r.point_check ?? 0; e.adv += r.point_advantage ?? 0; e.pen += Math.abs(r.point_penalty ?? 0); e.rows++;
    ppaByYW.set(k, e);
  }
  const hasActiveAward = (r: { user_id: string; year: Num; week_number: Num }) => ppaByYW.has(`${r.user_id}|${r.year}|${r.week_number}`);

  // ── 6. 행 단위 비교 ──
  type Row = {
    user_id: string; display_name: string; org: string; is_test: boolean; source_system: string; legacy_user_id: number | null;
    week_start_date: string; week_kind: string; year: number | null; week_number: number | null;
    cur_a: number; exp_a: number; d_a: number;
    cur_adv: number; exp_adv: number; d_adv: number;
    cur_pen: number; exp_pen: number; d_pen: number;
    checks_migrated: boolean; wiped: boolean; has_award: boolean;
    ledger_rows: number; voided_rows: number; protected_zeroed: number;
    uwp_row_id: string | null; basis: string; group: 1 | 2 | 3 | 4;
  };
  const rows: Row[] = [];
  const allKeys = new Set<string>([...expected.keys(), ...uwp.map((r) => `${r.user_id}|${r.week_start_date}`)]);

  for (const k of allKeys) {
    const [userId, wsd] = k.split("|");
    if (wsd === "1900-01-01") continue; // sentinel — §2 미대상(cm=false), 원장 재구성 범위 밖
    const exp = expected.get(k);
    const cur = uwpByKey.get(k);
    if (!exp && !cur) continue;
    // 원장에도 uwp 에도 값이 전혀 없는 조합은 스킵
    const ea = exp?.points ?? 0, eadv = exp?.adv ?? 0, epen = exp?.pen ?? 0;
    const ca = cur?.points ?? 0, cadv = cur?.advantages ?? 0, cpen = cur?.penalty ?? 0;
    if (!exp && ca === 0 && cadv === 0 && cpen === 0) continue;

    const wiped = isWiped(cur);
    const award = cur ? hasActiveAward(cur) : false;
    const same = ea === ca && eadv === cadv && epen === cpen;
    const curZero = ca === 0 && cadv === 0 && cpen === 0;
    const expNonZero = ea !== 0 || eadv !== 0 || epen !== 0;

    let group: 1 | 2 | 3 | 4;
    if (!cur) group = 4;              // uwp 행 자체가 없음(원장에만 존재)
    else if (same) group = 3;
    else if (curZero && expNonZero) group = 1;
    else group = 2;

    const basis: string[] = [];
    if (wiped) basis.push(`§2 wipe(${markerSource.startsWith("freeze") ? "동결본 마커" : `updated_at=${WIPE_PREFIX}`})`);
    if (cur?.checks_migrated) basis.push("checks_migrated=true");
    else if (cur) basis.push("checks_migrated=false(§2 미대상)");
    if (award) basis.push("active award 존재(§2 면제·awards SoT)");
    else if (cur) basis.push("active award 없음");
    if (!cur) basis.push("uwp 행 부재");
    if (exp?.voidedRows) basis.push(`VOIDED ${exp.voidedRows}행 star 포함`);
    if (exp?.protectedZeroed) basis.push(`14일보호 ${exp.protectedZeroed}행 star→0`);

    const p = profById.get(userId);
    const um = userMeta.get(userId);
    const w = weeks.find((x) => x.start_date === wsd);
    rows.push({
      user_id: userId,
      display_name: p?.display_name ?? "(이름없음)",
      org: p?.organization_slug ?? "?",
      is_test: markers.has(userId),
      source_system: um?.source_system ?? "null",
      legacy_user_id: um?.legacy_user_id ?? null,
      week_start_date: wsd,
      week_kind: weekKind.get(wsd) ?? "unknown",
      year: cur?.year ?? w?.iso_year ?? null,
      week_number: cur?.week_number ?? w?.iso_week ?? null,
      cur_a: ca, exp_a: ea, d_a: ea - ca,
      cur_adv: cadv, exp_adv: eadv, d_adv: eadv - cadv,
      cur_pen: cpen, exp_pen: epen, d_pen: epen - cpen,
      checks_migrated: cur?.checks_migrated ?? false,
      wiped, has_award: award,
      ledger_rows: exp?.rows ?? 0, voided_rows: exp?.voidedRows ?? 0, protected_zeroed: exp?.protectedZeroed ?? 0,
      uwp_row_id: cur?.id ?? null,
      basis: basis.join(" · "),
      group,
    });
  }

  rows.sort((x, y) => y.d_a - x.d_a || x.user_id.localeCompare(y.user_id) || x.week_start_date.localeCompare(y.week_start_date));

  const g = (n: number) => rows.filter((r) => r.group === n);
  const sum = (rs: Row[], f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0);

  // ── 7. 요약 ──
  const restoreTargets = rows.filter((r) => r.group === 1 || r.group === 2);
  const restoreSafe = restoreTargets.filter((r) => !r.has_award);
  const restoreConflict = restoreTargets.filter((r) => r.has_award);

  const uwpTotal = uwp.reduce((a, r) => ({ a: a.a + (r.points ?? 0), adv: a.adv + (r.advantages ?? 0), pen: a.pen + (r.penalty ?? 0) }), { a: 0, adv: 0, pen: 0 });

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: "DRY-RUN (write 0)",
    ledger: {
      totalRows: led.length,
      adjustmentSkipped: skippedAdjustment,
      nullWeekSkipped: skippedNullWeek,
      noUser: ledgerNoUser,
      ledgerUsers: ledgerUsers.size,
      weekIdUnmapped,
      collidedWeekStartKeys: collided.length,
      usersWithoutPmsStartDate: noStartDate,
      protectUntilUsers: protectUntil.size,
      protectedZeroedRows: [...agg.values()].reduce((s, a) => s + a.protectedZeroed, 0),
    },
    uwpNow: { rows: uwp.length, ...uwpTotal },
    groups: {
      "1_zeroed_but_ledger_has_value": {
        rows: g(1).length, users: new Set(g(1).map((r) => r.user_id)).size,
        cur: { a: sum(g(1), (r) => r.cur_a), adv: sum(g(1), (r) => r.cur_adv), pen: sum(g(1), (r) => r.cur_pen) },
        exp: { a: sum(g(1), (r) => r.exp_a), adv: sum(g(1), (r) => r.exp_adv), pen: sum(g(1), (r) => r.exp_pen) },
      },
      "2_partial_but_different": {
        rows: g(2).length, users: new Set(g(2).map((r) => r.user_id)).size,
        cur: { a: sum(g(2), (r) => r.cur_a), adv: sum(g(2), (r) => r.cur_adv), pen: sum(g(2), (r) => r.cur_pen) },
        exp: { a: sum(g(2), (r) => r.exp_a), adv: sum(g(2), (r) => r.exp_adv), pen: sum(g(2), (r) => r.exp_pen) },
      },
      "3_identical": {
        rows: g(3).length, users: new Set(g(3).map((r) => r.user_id)).size,
        cur: { a: sum(g(3), (r) => r.cur_a), adv: sum(g(3), (r) => r.cur_adv), pen: sum(g(3), (r) => r.cur_pen) },
      },
      "4_uwp_row_missing": {
        rows: g(4).length, users: new Set(g(4).map((r) => r.user_id)).size,
        exp: { a: sum(g(4), (r) => r.exp_a), adv: sum(g(4), (r) => r.exp_adv), pen: sum(g(4), (r) => r.exp_pen) },
      },
    },
    restore: {
      targetRows: restoreTargets.length,
      targetUsers: new Set(restoreTargets.map((r) => r.user_id)).size,
      safeRows: restoreSafe.length,
      awardConflictRows: restoreConflict.length,
      awardConflictUsers: new Set(restoreConflict.map((r) => r.user_id)).size,
      deltaOnSafe: { a: sum(restoreSafe, (r) => r.d_a), adv: sum(restoreSafe, (r) => r.d_adv), pen: sum(restoreSafe, (r) => r.d_pen) },
      deltaOnConflict: { a: sum(restoreConflict, (r) => r.d_a), adv: sum(restoreConflict, (r) => r.d_adv), pen: sum(restoreConflict, (r) => r.d_pen) },
    },
    globalTotals: {
      current: uwpTotal,
      afterRestoreSafeOnly: {
        a: uwpTotal.a + sum(restoreSafe, (r) => r.d_a),
        adv: uwpTotal.adv + sum(restoreSafe, (r) => r.d_adv),
        pen: uwpTotal.pen + sum(restoreSafe, (r) => r.d_pen),
      },
    },
    byWeekKind: (() => {
      const m: Record<string, { rows: number; dA: number }> = {};
      for (const r of restoreTargets) {
        const e = (m[r.week_kind] ??= { rows: 0, dA: 0 });
        e.rows++; e.dA += r.d_a;
      }
      return m;
    })(),
  };

  console.log("\n=== DRY-RUN 요약 ===");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n=== 상위 30 복구 대상 행 (ΔA 내림차순) ===");
  for (const r of restoreTargets.slice(0, 30)) {
    console.log(`${r.display_name}(${r.org}${r.is_test ? ",TEST" : ""}) ${r.week_start_date}[${r.week_kind}] A ${r.cur_a}→${r.exp_a} (Δ${r.d_a}) adv ${r.cur_adv}→${r.exp_adv} pen ${r.cur_pen}→${r.exp_pen} | ${r.basis}`);
  }

  // ── 8. 파일 출력 ──
  const csvEsc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "group", "user_id", "display_name", "org", "is_test", "source_system", "legacy_user_id",
    "week_start_date", "week_kind", "year", "week_number",
    "cur_a", "exp_a", "d_a", "cur_adv", "exp_adv", "d_adv", "cur_pen", "exp_pen", "d_pen",
    "checks_migrated", "wiped", "has_award", "ledger_rows", "voided_rows", "protected_zeroed", "uwp_row_id", "basis",
  ];
  const csv = [header.join(",")].concat(
    rows.map((r) => header.map((h) => csvEsc((r as unknown as Record<string, unknown>)[h])).join(",")),
  ).join("\n");
  writeFileSync(OUT_CSV, "﻿" + csv, "utf8");
  writeFileSync(OUT_JSON, JSON.stringify({ summary, rows }, null, 1), "utf8");
  console.log(`\n→ ${OUT_CSV}`);
  console.log(`→ ${OUT_JSON}`);
  console.log("\n=== DONE (writes: 0) ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
