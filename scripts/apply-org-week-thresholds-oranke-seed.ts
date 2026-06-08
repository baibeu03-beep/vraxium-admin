/**
 * ORANKE seed — weeks.check_threshold → org_week_thresholds(week_id,'oranke') 복사.
 *
 *   npx tsx --env-file=.env.local scripts/apply-org-week-thresholds-oranke-seed.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-org-week-thresholds-oranke-seed.ts --apply  # 적용
 *
 * 정책 (claudedocs/org-week-thresholds-design-20260607.md §10 Step 1):
 *   - **라이브 weeks 값 복사** (MySQL 재추출 아님) — B8 수동 보정분 포함, 값 동일성을
 *     구성적으로 보장 → ORANKE 판정 flip 0.
 *   - weeks.check_threshold IS NULL 주차는 seed 하지 않는다 (기본값 30 의미론 보존).
 *   - provenance: source_system='oranke', source_table='public.weeks', source_pk=week_id,
 *     inferred=false, payload={copied_from, b7_origin}.
 *   - 멱등: PK(week_id,organization_slug) upsert. 기존 행 값 동일 → noop 집계.
 *
 * write 범위: org_week_thresholds 만. weeks/uws/user_weekly_points/snapshot write 0.
 */
import { writeFileSync, readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const STAMP = "20260607";
const OUT = `claudedocs/org-week-thresholds-oranke-seed-${APPLY ? "apply" : "dryrun"}-${STAMP}.json`;

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

type WeekRow = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  check_threshold: number | null;
};

async function fetchAllWeeks(): Promise<WeekRow[]> {
  // PostgREST 1000행 cap 방어 — order+range 페이지네이션 (현재 weeks ~130행이지만 계약 준수).
  const out: WeekRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await sb
      .from("weeks")
      .select("id,season_key,week_number,start_date,check_threshold")
      .order("id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`weeks fetch failed: ${error.message}`);
    out.push(...((data ?? []) as WeekRow[]));
    if ((data ?? []).length < page) break;
  }
  return out;
}

async function main() {
  // 0) 테이블 존재 확인 (DDL 미적용이면 명시적 중단).
  {
    const { error } = await sb.from("org_week_thresholds").select("week_id").limit(1);
    if (error) {
      console.error(
        "org_week_thresholds 테이블 조회 실패 — db/migrations/2026-06-07_org_week_thresholds.sql 을 먼저 적용하세요.",
        error.message,
      );
      process.exit(1);
    }
  }

  const weeks = await fetchAllWeeks();
  const withThr = weeks.filter((w) => w.check_threshold != null && w.check_threshold >= 0);

  // 기존 oranke 행 (멱등 비교)
  const { data: existingData, error: exErr } = await sb
    .from("org_week_thresholds")
    .select("week_id,check_threshold,source_system,source_table,source_pk")
    .eq("organization_slug", "oranke")
    .order("week_id", { ascending: true })
    .range(0, 4999);
  if (exErr) throw new Error(`existing rows fetch failed: ${exErr.message}`);
  const existing = new Map(
    ((existingData ?? []) as { week_id: string; check_threshold: number }[]).map((r) => [
      r.week_id,
      r.check_threshold,
    ]),
  );

  const plan = withThr.map((w) => ({
    week_id: w.id,
    season_key: w.season_key,
    week_number: w.week_number,
    start_date: w.start_date,
    check_threshold: w.check_threshold as number,
    action: !existing.has(w.id)
      ? ("insert" as const)
      : existing.get(w.id) === w.check_threshold
        ? ("noop" as const)
        : ("update" as const),
    existing_value: existing.get(w.id) ?? null,
  }));
  // seed 대상 밖의 기존 oranke 행 = drift (weeks 값이 NULL 인데 org 행 존재 등) — 삭제하지 않고 리포트만.
  const planIds = new Set(plan.map((p) => p.week_id));
  const driftRows = [...existing.keys()].filter((id) => !planIds.has(id));

  const summary = {
    generatedAt: `2026-06-07 ORANKE seed (${APPLY ? "APPLY" : "dry-run"})`,
    mode: APPLY ? "apply (org_week_thresholds upsert only)" : "dry-run (DB writes: 0)",
    weeksTotal: weeks.length,
    weeksWithThreshold: withThr.length,
    weeksNullThreshold: weeks.length - withThr.length,
    inserts: plan.filter((p) => p.action === "insert").length,
    updates: plan.filter((p) => p.action === "update").length,
    noops: plan.filter((p) => p.action === "noop").length,
    driftOrgRowsWithoutWeeksValue: driftRows,
    valueDistribution: [...plan.reduce((m, p) => m.set(p.check_threshold, (m.get(p.check_threshold) ?? 0) + 1), new Map<number, number>())]
      .sort((a, b) => a[0] - b[0])
      .map(([v, n]) => `${v}:${n}`),
  };

  const applied = { upserted: 0, failed: 0 };
  if (APPLY) {
    const rows = plan
      .filter((p) => p.action !== "noop")
      .map((p) => ({
        week_id: p.week_id,
        organization_slug: "oranke",
        check_threshold: p.check_threshold,
        source_system: "oranke",
        source_table: "public.weeks",
        source_pk: p.week_id,
        inferred: false,
        payload: {
          copied_from: "weeks.check_threshold",
          b7_origin: "oranke.weekssettings.confirmStar (B7 apply 2026-06-06, B8 수동 보정 포함)",
          season_key: p.season_key,
          week_number: p.week_number,
          start_date: p.start_date,
        },
        updated_at: new Date().toISOString(),
      }));
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await sb
        .from("org_week_thresholds")
        .upsert(chunk, { onConflict: "week_id,organization_slug" });
      if (error) {
        applied.failed += chunk.length;
        console.error(`upsert chunk ${i} failed:`, error.message);
      } else {
        applied.upserted += chunk.length;
      }
    }
  }

  const report = { summary, applied: APPLY ? applied : null, plan };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (APPLY) console.log("applied:", JSON.stringify(applied));
  console.log("→", OUT);
  if (APPLY && applied.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
