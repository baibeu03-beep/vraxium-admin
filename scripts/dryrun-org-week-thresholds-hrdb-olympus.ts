/**
 * HRDB(encre) / OLYMPUS(phalanx) threshold 백필 dry-run — write 0 보장.
 *
 *   npx tsx --env-file=.env.local scripts/dryrun-org-week-thresholds-hrdb-olympus.ts
 *
 * 계획 (claudedocs/org-week-thresholds-design-20260607.md §10 Step 2):
 *   소스 {db}.weekssettings (Id, season, week, StartDate, EndDate, confirmStar, IsPublic)
 *   → DATE(StartDate) = 라이브 weeks.start_date 매칭 (B7 과 동일 그리드)
 *   → org_week_thresholds(week_id, resolveOrganizationSlug(src), confirmStar) upsert PLAN.
 *
 * 정책:
 *   - org 는 resolveOrganizationSlug(source) 만 사용 (fail-closed) — Team 파생 금지.
 *   - confirmStar NULL/음수 → skip (org 행 미생성 = 공통 폴백, fail-safe).
 *   - weeks 행 부재 소스 주차 → unmatched 리포트 (B7류 weeks 백필 필요 여부 판단 자료 —
 *     본 작업 범위 밖, 자동 보정 금지).
 *   - 기존 org 행과 값 충돌 → conflict 리포트 (덮어쓰지 않음 — apply 시 별도 결정).
 *   - oranke seed 값과의 차이를 정량화 — "org 분리가 실제 필요한 주차" 증거.
 *
 * write: 0 (--apply 미구현 — 전달 시 즉시 종료. apply 는 본 리포트 승인 후 별도 스크립트).
 */
import { writeFileSync, readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { ledgerSourceTable, resolveOrganizationSlug } from "@/lib/pmsMigration";

if (process.argv.includes("--apply")) {
  console.error("--apply 는 미구현 (의도적) — dry-run 리포트 승인 후 별도 apply 스크립트로 진행.");
  process.exit(1);
}

const OUT_JSON = "claudedocs/org-week-thresholds-hrdb-olympus-dryrun-20260607.json";
const OUT_MD = "claudedocs/org-week-thresholds-hrdb-olympus-dryrun-20260607.md";
const SOURCES = ["hrdb", "olympus"] as const;

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

type LiveWeek = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  check_threshold: number | null;
};

type PlanRow = {
  source: string;
  source_pk: string;
  start_date: string;
  season_raw: string;
  week_raw: string;
  confirm_star: number;
  week_id: string;
  season_key: string | null;
  week_number: number | null;
  organization_slug: string;
  oranke_live_value: number | null; // = weeks.check_threshold (비교용)
  differs_from_oranke: boolean;
  action: "insert" | "noop" | "conflict";
  existing_value?: number | null;
};

async function fetchAllLiveWeeks(): Promise<LiveWeek[]> {
  const out: LiveWeek[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("weeks")
      .select("id,season_key,week_number,start_date,check_threshold")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as LiveWeek[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const liveWeeks = await fetchAllLiveWeeks();
  const liveByStart = new Map<string, LiveWeek>();
  for (const w of liveWeeks) if (w.start_date) liveByStart.set(w.start_date, w);

  // 기존 org 행 (테이블 미생성이면 빈 취급 — dry-run 은 진행 가능)
  const existingByKey = new Map<string, number>(); // `${week_id}|${org}`
  {
    const { data, error } = await sb
      .from("org_week_thresholds")
      .select("week_id,organization_slug,check_threshold")
      .order("week_id", { ascending: true })
      .range(0, 4999);
    if (error) {
      console.warn("org_week_thresholds 조회 실패(미생성?) — 기존 행 없음으로 진행:", error.message);
    } else {
      for (const r of (data ?? []) as { week_id: string; organization_slug: string; check_threshold: number }[]) {
        existingByKey.set(`${r.week_id}|${r.organization_slug}`, r.check_threshold);
      }
    }
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
  const unmatched: Array<Record<string, unknown>> = [];
  const perSource: Record<string, Record<string, number>> = {};

  for (const src of SOURCES) {
    const org = resolveOrganizationSlug(src); // fail-closed
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

    const stat = { total: 0, planned: 0, noop: 0, conflict: 0, skippedNullThr: 0, unmatchedWeeks: 0, differsFromOranke: 0 };
    for (const r of rows) {
      stat.total++;
      const start = String(r.s).slice(0, 10);
      if (start < "2020-01-01") {
        skips.push({ source: src, id: r.Id, start, reason: "pre-2020 노이즈" });
        continue;
      }
      const thr =
        r.confirmStar != null && Number(r.confirmStar) >= 0 ? Number(r.confirmStar) : null;
      if (thr == null) {
        stat.skippedNullThr++;
        skips.push({ source: src, id: r.Id, start, reason: "confirmStar NULL/음수 — 공통 폴백 유지" });
        continue;
      }
      const live = liveByStart.get(start);
      if (!live) {
        stat.unmatchedWeeks++;
        unmatched.push({
          source: src, id: r.Id, start, end: String(r.e ?? r.s).slice(0, 10),
          season: r.Season, week: r.week, confirmStar: thr,
          note: "라이브 weeks 행 부재 — B7류 weeks 백필 필요 여부 별도 판단",
        });
        continue;
      }
      const key = `${live.id}|${org}`;
      const existing = existingByKey.has(key) ? existingByKey.get(key)! : null;
      const action: PlanRow["action"] =
        existing == null ? "insert" : existing === thr ? "noop" : "conflict";
      const differs = live.check_threshold != null && live.check_threshold !== thr;
      if (differs) stat.differsFromOranke++;
      if (action === "insert") stat.planned++;
      else if (action === "noop") stat.noop++;
      else stat.conflict++;
      plans.push({
        source: src,
        source_pk: String(r.Id),
        start_date: start,
        season_raw: String(r.Season ?? ""),
        week_raw: String(r.week ?? ""),
        confirm_star: thr,
        week_id: live.id,
        season_key: live.season_key,
        week_number: live.week_number,
        organization_slug: org,
        oranke_live_value: live.check_threshold,
        differs_from_oranke: differs,
        action,
        existing_value: existing,
      });
      void sourceTable; // apply 시 source_table 로 기록 (plan 메타에 포함)
    }
    perSource[src] = stat;
  }
  await conn.end();

  const summary = {
    generatedAt: "2026-06-07 HRDB/OLYMPUS threshold 백필 dry-run",
    mode: "dry-run (DB writes: 0 — guaranteed; --apply unimplemented)",
    mapping: { hrdb: "encre", olympus: "phalanx" },
    sourceTableContract: SOURCES.map((s) => ledgerSourceTable(s, "weekssettings")),
    perSource,
    plannedTotal: plans.filter((p) => p.action === "insert").length,
    conflictTotal: plans.filter((p) => p.action === "conflict").length,
    unmatchedTotal: unmatched.length,
    differsFromOrankeTotal: plans.filter((p) => p.differs_from_oranke).length,
  };

  writeFileSync(OUT_JSON, JSON.stringify({ summary, plans, unmatched, skips }, null, 2));

  const md: string[] = [
    "# HRDB/OLYMPUS threshold 백필 dry-run (2026-06-07)",
    "",
    "> write 0 (--apply 미구현). org = source_system 매핑만 (hrdb→encre · olympus→phalanx).",
    "",
    "## 소스별 집계",
    "",
    "| source | org | 소스 주차 | insert 계획 | noop | conflict | thr NULL skip | weeks 부재 | oranke와 값 차이 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...SOURCES.map((s) => {
      const st = perSource[s];
      return `| ${s} | ${resolveOrganizationSlug(s)} | ${st.total} | ${st.planned} | ${st.noop} | ${st.conflict} | ${st.skippedNullThr} | ${st.unmatchedWeeks} | ${st.differsFromOranke} |`;
    }),
    "",
    `oranke 와 값이 다른 주차 합계: **${summary.differsFromOrankeTotal}** — org 분리가 실제로 필요한 주차 수 (0 이면 분리 무의미).`,
    "",
    "## weeks 행 부재 (백필 불가 — 별도 판단)",
    "",
    ...(unmatched.length
      ? unmatched.slice(0, 40).map((u) => `- ${u.source} Id=${u.id} ${u.start} (${u.season} ${u.week}) thr=${u.confirmStar}`)
      : ["- 없음"]),
    unmatched.length > 40 ? `- …외 ${unmatched.length - 40}건 (JSON 참조)` : "",
    "",
    "## oranke 와 값이 다른 주차 (상위 40)",
    "",
    "| source | start_date | season_key | W | confirmStar | oranke(live) |",
    "|---|---|---|---|---|---|",
    ...plans
      .filter((p) => p.differs_from_oranke)
      .slice(0, 40)
      .map((p) => `| ${p.source} | ${p.start_date} | ${p.season_key} | ${p.week_number} | ${p.confirm_star} | ${p.oranke_live_value} |`),
    "",
    "## apply 계약 (승인 후 별도 스크립트)",
    "",
    "- upsert `onConflict: week_id,organization_slug`, provenance: `source_system`·`source_table`(소스 프리픽스)·`source_pk=weekssettings.Id`·`inferred=false`·`payload`=원본 행.",
    "- conflict 행은 자동 덮어쓰기 금지 — 본 리포트에서 건별 결정.",
    "- weeks/uws/user_weekly_points/snapshot write 0 유지.",
  ];
  writeFileSync(OUT_MD, md.filter((l) => l !== "").join("\n") + "\n");

  console.log(JSON.stringify(summary, null, 2));
  console.log("→", OUT_JSON);
  console.log("→", OUT_MD);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
