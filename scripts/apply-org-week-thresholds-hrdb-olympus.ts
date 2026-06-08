/**
 * HRDB(encre) / OLYMPUS(phalanx) org_week_thresholds 백필 apply — fail-closed.
 *
 *   npx tsx --env-file=.env.local scripts/apply-org-week-thresholds-hrdb-olympus.ts                 # preview (write 0)
 *   npx tsx --env-file=.env.local scripts/apply-org-week-thresholds-hrdb-olympus.ts --apply         # 적용 + run log
 *   npx tsx --env-file=.env.local scripts/apply-org-week-thresholds-hrdb-olympus.ts --rollback <runlog.json>
 *
 * 계약 (2026-06-07 dry-run 승인 기반 — claudedocs/org-week-thresholds-hrdb-olympus-dryrun-20260607.json):
 *   - 소스 {db}.weekssettings.confirmStar → org_week_thresholds(week_id, org) INSERT 만.
 *     org 는 resolveOrganizationSlug(source) 만 사용 (hrdb→encre · olympus→phalanx, fail-closed).
 *   - **drift 교차검증**: apply 시점에 plan 을 소스에서 재산출해 dry-run 산출물과 전수 비교 —
 *     1건이라도 불일치(추가/누락/값 변경)면 write 0 으로 중단 (B7 concurrent-drift 패턴).
 *   - **fail-closed 충돌**: 기존 (week_id,org) 행이 다른 값 보유 → 중단(덮어쓰기 금지).
 *     동일 값 보유 → noop(멱등 재실행). DB 레벨에서도 upsert 가 아닌 INSERT 사용 —
 *     검증과 write 사이 경합까지 PK/uq_owt_source 위반 에러로 차단.
 *   - 멱등 키: PK(week_id,organization_slug) + uq_owt_source(source_table, source_pk).
 *   - weeks 부재 소스 주차 → skip + 리포트 (기지: hrdb 2023-02-06 겨울 W6 — 1건 초과 시 경고).
 *   - rollback: run log 의 inserted 행을 (source_table, source_pk, org, value) 전수 대조 후
 *     일치 행만 delete. oranke 행·수동 행(source_pk NULL)은 어떤 경우에도 건드리지 않는다.
 *
 * write 범위: org_week_thresholds 의 encre/phalanx 행만.
 *   weeks·users·user_profiles·user_weekly_points·user_week_statuses·실무 경험·snapshot write 0.
 *   oranke org 행 write 0 — 실행 전후 fingerprint 로 불변 증명.
 *   snapshot 재계산 0 — 실행 전후 snapshot fingerprint 로 증명.
 */
import { writeFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { ledgerSourceTable, resolveOrganizationSlug } from "@/lib/pmsMigration";

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK_FILE = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
if (APPLY && ROLLBACK_FILE) {
  console.error("--apply 와 --rollback 동시 지정 불가.");
  process.exit(1);
}
const MODE = ROLLBACK_FILE ? "rollback" : APPLY ? "apply" : "preview";
const DRYRUN_PATH = "claudedocs/org-week-thresholds-hrdb-olympus-dryrun-20260607.json";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/owt-hrdb-olympus-${MODE}-${STAMP}.json`;
const SOURCES = ["hrdb", "olympus"] as const;
const EXPECTED = { hrdb: 93, olympus: 76 } as const; // dry-run 승인 수치

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

type PlanRow = {
  week_id: string;
  organization_slug: string;
  check_threshold: number;
  source_system: string;
  source_table: string;
  source_pk: string;
  start_date: string;
  season_key: string | null;
  week_number: number | null;
  payload: Record<string, unknown>;
};

// ── 불변 fingerprint: oranke org 행 + snapshot (write 0 증명용) ──────────
async function orankeFingerprint(): Promise<{ count: number; hash: string }> {
  const { data, error } = await sb
    .from("org_week_thresholds")
    .select("week_id,check_threshold,source_table,source_pk,updated_at")
    .eq("organization_slug", "oranke")
    .order("week_id", { ascending: true })
    .range(0, 4999);
  if (error) throw new Error(`oranke fingerprint: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  return { count: rows.length, hash: sha1(JSON.stringify(rows)) };
}

async function snapshotFingerprint(): Promise<{ count: number; hash: string }> {
  const out: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,computed_at,is_stale,dto_version")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`snapshot fingerprint: ${error.message}`);
    for (const r of (data ?? []) as Record<string, unknown>[]) out.push(JSON.stringify(r));
    if ((data ?? []).length < 1000) break;
  }
  return { count: out.length, hash: sha1(out.join("\n")) };
}

// ── plan 재산출 (dry-run 과 동일 로직) ───────────────────────────────────
async function recomputePlan(): Promise<{
  plans: PlanRow[];
  skips: Array<Record<string, unknown>>;
}> {
  type LiveWeek = {
    id: string;
    season_key: string | null;
    week_number: number | null;
    start_date: string | null;
    check_threshold: number | null;
  };
  const liveByStart = new Map<string, LiveWeek>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("weeks")
      .select("id,season_key,week_number,start_date,check_threshold")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const w of (data ?? []) as LiveWeek[]) if (w.start_date) liveByStart.set(w.start_date, w);
    if ((data ?? []).length < 1000) break;
  }

  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"),
    port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"),
    password: envGet("MYSQL_PASSWORD"),
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const plans: PlanRow[] = [];
  const skips: Array<Record<string, unknown>> = [];
  for (const src of SOURCES) {
    const org = resolveOrganizationSlug(src);
    const sourceTable = ledgerSourceTable(src, "weekssettings");
    type SourceRow = {
      Id: number;
      Season: string | null;
      week: string | number | null;
      s: string;
      e: string | null;
      confirmStar: number | null;
      IsPublic: number | null;
    };
    const [rows] = (await conn.query(`
      SELECT Id, Season, week, CAST(StartDate AS CHAR) AS s, CAST(EndDate AS CHAR) AS e,
             confirmStar, IsPublic
      FROM ${src}.weekssettings WHERE StartDate IS NOT NULL ORDER BY StartDate`)) as [SourceRow[], unknown];
    for (const r of rows) {
      const start = String(r.s).slice(0, 10);
      if (start < "2020-01-01") {
        skips.push({ source: src, id: r.Id, start, reason: "pre-2020 노이즈" });
        continue;
      }
      const thr = r.confirmStar != null && Number(r.confirmStar) >= 0 ? Number(r.confirmStar) : null;
      if (thr == null) {
        skips.push({ source: src, id: r.Id, start, reason: "confirmStar NULL/음수 — 공통 폴백 유지" });
        continue;
      }
      const live = liveByStart.get(start);
      if (!live) {
        skips.push({
          source: src, id: r.Id, start, season: r.Season, week: r.week, confirmStar: thr,
          reason: "weeks 행 부재 — skip (org 행 미생성 = 공통 폴백)",
        });
        continue;
      }
      plans.push({
        week_id: live.id,
        organization_slug: org,
        check_threshold: thr,
        source_system: src,
        source_table: sourceTable,
        source_pk: String(r.Id),
        start_date: start,
        season_key: live.season_key,
        week_number: live.week_number,
        payload: {
          origin: `${src}.weekssettings.confirmStar`,
          weekssettings_id: r.Id,
          season_raw: r.Season,
          week_raw: r.week,
          start_date: start,
          end_date: String(r.e ?? r.s).slice(0, 10),
          is_public: r.IsPublic,
          oranke_live_value_at_apply: live.check_threshold,
        },
      });
    }
  }
  await conn.end();
  return { plans, skips };
}

// ── rollback ─────────────────────────────────────────────────────────────
async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8")) as {
    mode?: string;
    inserted?: Array<{ week_id: string; organization_slug: string; check_threshold: number; source_table: string; source_pk: string }>;
  };
  const rows = log.inserted ?? [];
  if (!rows.length) {
    console.error("run log 에 inserted 행이 없음 — rollback 대상 없음.");
    process.exit(1);
  }
  let deleted = 0, mismatched = 0, missing = 0;
  const issues: string[] = [];
  for (const r of rows) {
    if (r.organization_slug === "oranke" || !r.source_pk) {
      mismatched++;
      issues.push(`보호 대상 skip: ${r.week_id}|${r.organization_slug}`);
      continue;
    }
    // 현재 행이 run log 와 정확히 일치할 때만 삭제 (수동 변경분 보호 — fail-closed).
    const { data: cur } = await sb
      .from("org_week_thresholds")
      .select("check_threshold,source_table,source_pk")
      .eq("week_id", r.week_id)
      .eq("organization_slug", r.organization_slug)
      .maybeSingle();
    if (!cur) { missing++; continue; }
    const c = cur as { check_threshold: number; source_table: string | null; source_pk: string | null };
    if (c.check_threshold !== r.check_threshold || c.source_table !== r.source_table || c.source_pk !== r.source_pk) {
      mismatched++;
      issues.push(`변경 감지 skip: ${r.week_id}|${r.organization_slug} (cur=${c.check_threshold})`);
      continue;
    }
    const { error } = await sb
      .from("org_week_thresholds")
      .delete()
      .eq("week_id", r.week_id)
      .eq("organization_slug", r.organization_slug);
    if (error) { issues.push(`delete 실패: ${r.week_id}|${r.organization_slug}: ${error.message}`); }
    else deleted++;
  }
  const report = { mode: "rollback", source: file, target: rows.length, deleted, mismatched, missing, issues };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log("→", OUT);
  process.exit(issues.length > 0 ? 1 : 0);
}

async function main() {
  if (ROLLBACK_FILE) return rollback(ROLLBACK_FILE);

  // 0) 테이블 존재 + 불변 fingerprint (before)
  {
    const { error } = await sb.from("org_week_thresholds").select("week_id").limit(1);
    if (error) {
      console.error("org_week_thresholds 조회 실패 — DDL 미적용:", error.message);
      process.exit(1);
    }
  }
  const orankeBefore = await orankeFingerprint();
  const snapBefore = await snapshotFingerprint();

  // 1) plan 재산출 + dry-run drift 교차검증 (fail-closed)
  const { plans, skips } = await recomputePlan();
  const drift: string[] = [];
  {
    const dryrun = JSON.parse(readFileSync(DRYRUN_PATH, "utf8")) as {
      plans: Array<{ source: string; source_pk: string; week_id: string; confirm_star: number; organization_slug: string }>;
    };
    const key = (p: { source_system?: string; source?: string; source_pk: string; week_id: string; check_threshold?: number; confirm_star?: number; organization_slug: string }) =>
      `${p.source_system ?? p.source}|${p.source_pk}|${p.week_id}|${p.check_threshold ?? p.confirm_star}|${p.organization_slug}`;
    const dryKeys = new Set(dryrun.plans.map(key));
    const nowKeys = new Set(plans.map(key));
    for (const k of nowKeys) if (!dryKeys.has(k)) drift.push(`dry-run 에 없음: ${k}`);
    for (const k of dryKeys) if (!nowKeys.has(k)) drift.push(`apply 시점에 사라짐: ${k}`);
  }
  // 승인 수치 고정 검증
  const bySrc = (s: string) => plans.filter((p) => p.source_system === s).length;
  for (const s of SOURCES) {
    if (bySrc(s) !== EXPECTED[s]) drift.push(`${s} plan ${bySrc(s)}건 ≠ 승인 ${EXPECTED[s]}건`);
  }
  const weeksMissingSkips = skips.filter((s) => String(s.reason).startsWith("weeks 행 부재"));
  if (weeksMissingSkips.length !== 1) drift.push(`weeks 부재 skip ${weeksMissingSkips.length}건 ≠ 기지 1건`);

  // 2) 기존 행 충돌 검증 (fail-closed) — encre/phalanx 만 조회
  const existing = new Map<string, { check_threshold: number; source_table: string | null; source_pk: string | null }>();
  {
    const { data, error } = await sb
      .from("org_week_thresholds")
      .select("week_id,organization_slug,check_threshold,source_table,source_pk")
      .in("organization_slug", ["encre", "phalanx"])
      .order("week_id", { ascending: true })
      .range(0, 4999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ week_id: string; organization_slug: string; check_threshold: number; source_table: string | null; source_pk: string | null }>) {
      existing.set(`${r.week_id}|${r.organization_slug}`, r);
    }
  }
  const conflicts: string[] = [];
  const toInsert: PlanRow[] = [];
  let noop = 0;
  for (const p of plans) {
    const cur = existing.get(`${p.week_id}|${p.organization_slug}`);
    if (!cur) {
      toInsert.push(p);
    } else if (
      cur.check_threshold === p.check_threshold &&
      cur.source_table === p.source_table &&
      cur.source_pk === p.source_pk
    ) {
      noop++; // 멱등 재실행
    } else {
      conflicts.push(
        `${p.week_id}|${p.organization_slug}: 기존 ${cur.check_threshold}(${cur.source_table}/${cur.source_pk}) ≠ plan ${p.check_threshold}(${p.source_table}/${p.source_pk})`,
      );
    }
  }

  const blocked = drift.length > 0 || conflicts.length > 0;
  const summary = {
    generatedAt: `2026-06-07 HRDB/OLYMPUS org_week_thresholds ${MODE}`,
    mode: MODE,
    planTotal: plans.length,
    perSource: Object.fromEntries(SOURCES.map((s) => [s, bySrc(s)])),
    toInsert: toInsert.length,
    noop,
    skips: skips.length,
    weeksMissingSkips,
    drift,
    conflicts,
    blocked,
    invariants: { orankeBefore, snapshotBefore: snapBefore },
  };

  if (blocked) {
    writeFileSync(OUT, JSON.stringify({ summary, plans, skips }, null, 2));
    console.error(JSON.stringify(summary, null, 2));
    console.error("fail-closed — write 0 으로 중단. →", OUT);
    process.exit(1);
  }

  // 3) apply
  const inserted: Array<Pick<PlanRow, "week_id" | "organization_slug" | "check_threshold" | "source_table" | "source_pk">> = [];
  const writeErrors: string[] = [];
  if (APPLY) {
    const nowIso = new Date().toISOString();
    for (let i = 0; i < toInsert.length; i += 100) {
      const chunk = toInsert.slice(i, i + 100).map((p) => ({
        week_id: p.week_id,
        organization_slug: p.organization_slug,
        check_threshold: p.check_threshold,
        source_system: p.source_system,
        source_table: p.source_table,
        source_pk: p.source_pk,
        inferred: false,
        payload: p.payload,
        updated_at: nowIso,
      }));
      // INSERT (upsert 아님) — 경합 시 PK/uq_owt_source 위반으로 즉시 실패 (fail-closed).
      const { error } = await sb.from("org_week_thresholds").insert(chunk);
      if (error) {
        writeErrors.push(`chunk ${i}: ${error.message}`);
        break; // 부분 실패 시 즉시 중단 — run log 의 inserted 로 rollback 가능
      }
      inserted.push(
        ...chunk.map((c) => ({
          week_id: c.week_id,
          organization_slug: c.organization_slug,
          check_threshold: c.check_threshold,
          source_table: c.source_table,
          source_pk: c.source_pk,
        })),
      );
    }
  }

  // 4) 불변 fingerprint (after) — oranke·snapshot write 0 증명
  const orankeAfter = await orankeFingerprint();
  const snapAfter = await snapshotFingerprint();
  const invariantOk =
    orankeAfter.hash === orankeBefore.hash &&
    orankeAfter.count === orankeBefore.count &&
    snapAfter.hash === snapBefore.hash &&
    snapAfter.count === snapBefore.count;

  const report = {
    summary: {
      ...summary,
      applied: APPLY ? { inserted: inserted.length, writeErrors } : null,
      invariantsAfter: { orankeAfter, snapshotAfter: snapAfter, invariantOk },
      rollback: APPLY
        ? `npx tsx --env-file=.env.local scripts/apply-org-week-thresholds-hrdb-olympus.ts --rollback ${OUT}`
        : null,
    },
    inserted,
    skips,
    plans: APPLY ? undefined : plans, // preview 는 전체 plan 보존
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  console.log("→", OUT);
  if (APPLY && (writeErrors.length > 0 || !invariantOk)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
