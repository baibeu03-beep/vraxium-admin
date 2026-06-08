/**
 * Pilot 영향 미공표 이관 주차 11개 — result_published_at 소급 공표 (2026-06-07 승인).
 *
 *   npx tsx --env-file=.env.local scripts/apply-publish-pilot-weeks.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-publish-pilot-weeks.ts --apply
 *   npx tsx --env-file=.env.local scripts/apply-publish-pilot-weeks.ts --rollback <runlog.json>
 *
 * 대상: 2025-spring W4·W5·W9~W13 + 2025-summer W1~W4 (pilot preview 산정 11주).
 *   2026-spring W13 제외(운영 공표 사이클 몫). 소급값 = end_date+1일 00:00:00Z.
 *   가드: result_published_at IS NULL 인 행만 update (멱등·기존 공표 불침범).
 * snapshot: publish-result 패턴 재사용하되 **pilot 5명 한정** 재계산 (비대상 금지 —
 *   해당 주차 uws 보유자가 pilot 뿐임을 preview 로 실증, apply 시 재단언).
 * rollback: run log 의 week_id 별 (현재값==우리가 쓴 값) 가드로 NULL 복원 + pilot snapshot 재계산.
 */
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK_FILE = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK_FILE ? "rollback" : APPLY ? "apply" : "dry-run";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/publish-pilot-weeks-${MODE}-${STAMP}.json`;

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// 승인 대상 11주 (preview-publish-pilot-weeks-20260607 산정 고정)
const TARGET_STARTS = [
  "2025-03-24", "2025-03-31", "2025-04-28", "2025-05-05", "2025-05-12", "2025-05-19", "2025-05-26",
  "2025-06-30", "2025-07-07", "2025-07-14", "2025-07-21",
];
const PILOT_PAIRS = [
  ["oranke", 1092], ["hrdb", 1463], ["olympus", 249], ["olympus", 248], ["olympus", 251],
] as const;
const addDays = (iso: string, d: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};

async function pilotUuids(): Promise<string[]> {
  const out: string[] = [];
  for (const [src, uid] of PILOT_PAIRS) {
    const { data } = await sb.from("users").select("id").eq("source_system", src).eq("legacy_user_id", uid).maybeSingle();
    if (!data) throw new Error(`pilot 페어 (${src},${uid}) 부재`);
    out.push((data as any).id);
  }
  return out;
}

async function nonPilotSnapshotFp(pilot: Set<string>): Promise<{ rows: number; hash: string }> {
  const all: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,computed_at,is_stale,dto_version").order("user_id").range(f, f + 999);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const rows = all.filter((r) => !pilot.has(r.user_id));
  return { rows: rows.length, hash: sha1(JSON.stringify(rows)) };
}

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const issues: string[] = [];
  for (const r of log.applied ?? []) {
    const { data, error } = await sb
      .from("weeks")
      .update({ result_published_at: null })
      .eq("id", r.week_id)
      .eq("result_published_at", r.published_at) // 우리가 쓴 값일 때만 NULL 복원
      .select("id");
    if (error || (data ?? []).length !== 1) issues.push(`${r.week_id}: ${error?.message ?? "rows≠1 (값 변경됨 — skip)"}`);
  }
  const pilot = await pilotUuids();
  for (const u of pilot) {
    try { await recomputeAndStoreWeeklyCardsSnapshot(u); } catch (e) { issues.push(`snapshot ${u}: ${e}`); }
  }
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", source: file, issues }, null, 1));
  console.log(issues.length ? issues.join("\n") : "rollback 완료 (NULL 복원 + pilot snapshot 재계산)");
  process.exit(issues.length ? 1 : 0);
}

async function main() {
  if (ROLLBACK_FILE) return rollback(ROLLBACK_FILE);
  const pilot = await pilotUuids();
  const pilotSet = new Set(pilot);

  // 대상 로드 + 재단언: NULL ∧ 2025 시즌 ∧ 보유자=pilot 한정
  const { data: wk, error } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date,result_published_at")
    .in("start_date", TARGET_STARTS)
    .order("start_date");
  if (error) throw new Error(error.message);
  const target = ((wk ?? []) as any[]).filter((w) => w.result_published_at == null);
  const skippedAlreadyPublished = ((wk ?? []) as any[]).filter((w) => w.result_published_at != null);
  for (const w of target) {
    if (!String(w.season_key).startsWith("2025-")) throw new Error(`비대상 시즌 ${w.season_key} — 중단`);
    const { data: holders } = await sb.from("user_week_statuses").select("user_id").eq("week_start_date", w.start_date).range(0, 4999);
    const outsiders = ((holders ?? []) as any[]).map((h) => h.user_id).filter((u) => !pilotSet.has(u));
    if (outsiders.length) throw new Error(`${w.season_key} W${w.week_number}: 비대상 보유자 ${outsiders.length} — fail-closed`);
  }

  const fpBefore = await nonPilotSnapshotFp(pilotSet);
  const plan = target.map((w: any) => ({
    week_id: w.id, season_key: w.season_key, week_number: w.week_number,
    start_date: w.start_date, end_date: w.end_date,
    published_at: `${addDays(w.end_date, 1)}T00:00:00+00:00`,
  }));
  console.log(`대상 ${plan.length}주 (이미 공표 skip ${skippedAlreadyPublished.length})`);
  for (const p of plan) console.log(` ${p.season_key} W${p.week_number} → ${p.published_at}`);

  const applied: any[] = [];
  const errors: string[] = [];
  if (APPLY) {
    for (const p of plan) {
      const { data, error: ue } = await sb
        .from("weeks")
        .update({ result_published_at: p.published_at })
        .eq("id", p.week_id)
        .is("result_published_at", null) // NULL 가드 (멱등·기존 공표 불침범)
        .select("id");
      if (ue || (data ?? []).length !== 1) errors.push(`${p.week_id}: ${ue?.message ?? "rows≠1"}`);
      else applied.push(p);
    }
    // pilot 5명 한정 snapshot 재계산 (publish-result 의 참여자 재계산 패턴 — 대상 제한판)
    for (const u of pilot) {
      try { await recomputeAndStoreWeeklyCardsSnapshot(u); } catch (e) { errors.push(`snapshot ${u}: ${e}`); }
    }
  }
  const fpAfter = await nonPilotSnapshotFp(pilotSet);
  const report = {
    mode: MODE, plan, applied, errors,
    skippedAlreadyPublished: skippedAlreadyPublished.map((w: any) => `${w.season_key} W${w.week_number}`),
    nonPilotSnapshotFingerprint: { before: fpBefore, after: fpAfter, unchanged: fpBefore.hash === fpAfter.hash },
    snapshotRecomputed: APPLY ? pilot.length : 0,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ mode: MODE, planned: plan.length, applied: applied.length, errors, nonPilotSnapshotUnchanged: fpBefore.hash === fpAfter.hash }, null, 2));
  console.log("→", OUT);
  if (errors.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
