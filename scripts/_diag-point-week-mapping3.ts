// READ-ONLY 진단 3 — 주차별 포인트 분포(활동주차 vs 공식휴식주차) + uwp 행 타임스탬프.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Num = number | null;

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  const weeks = await pageAll<{
    season_key: string | null; week_number: Num; start_date: string | null;
    is_official_rest: boolean | null;
  }>((f, t) =>
    supabaseAdmin.from("weeks")
      .select("season_key,week_number,start_date,is_official_rest")
      .order("start_date", { ascending: true }).range(f, t),
  );
  const weekByStart = new Map(weeks.filter((w) => w.start_date).map((w) => [w.start_date!, w]));

  // uwp 컬럼 탐색(생성/수정 시각 존재 여부)
  const probe = await supabaseAdmin.from("user_weekly_points").select("*").limit(1);
  console.log("uwp 컬럼:", Object.keys((probe.data?.[0] ?? {}) as object).join(", "));

  const uwp = await pageAll<{
    user_id: string; week_start_date: string | null; points: Num; advantages: Num; penalty: Num;
    checks_migrated?: boolean | null; created_at?: string | null; updated_at?: string | null;
  }>((f, t) =>
    supabaseAdmin.from("user_weekly_points")
      .select("user_id,week_start_date,points,advantages,penalty,checks_migrated,created_at,updated_at")
      .order("id", { ascending: true }).range(f, t),
  );

  type Agg = { rows: number; nonzero: number; a: number; adv: number; pen: number; updatedMax: string; createdMax: string };
  const byStart = new Map<string, Agg>();
  for (const r of uwp) {
    const k = r.week_start_date ?? "(null)";
    const e = byStart.get(k) ?? { rows: 0, nonzero: 0, a: 0, adv: 0, pen: 0, updatedMax: "", createdMax: "" };
    e.rows += 1;
    if ((r.points ?? 0) || (r.advantages ?? 0) || (r.penalty ?? 0)) e.nonzero += 1;
    e.a += r.points ?? 0; e.adv += r.advantages ?? 0; e.pen += Math.abs(r.penalty ?? 0);
    if ((r.updated_at ?? "") > e.updatedMax) e.updatedMax = r.updated_at ?? "";
    if ((r.created_at ?? "") > e.createdMax) e.createdMax = r.created_at ?? "";
    byStart.set(k, e);
  }

  console.log("\n=== 주차별 uwp 분포 (2025-autumn 이후) ===");
  console.log("start_date  시즌 W#   휴식  행수 비영행  ΣA   Σadv  Σpen   최신 updated_at");
  for (const [start, e] of [...byStart.entries()].sort()) {
    if (start < "2025-08-01") continue;
    const w = weekByStart.get(start);
    console.log(
      `${start}  ${(w?.season_key ?? "?").padEnd(12)} W${String(w?.week_number ?? "?").padEnd(3)} ` +
        `${w?.is_official_rest ? "휴식" : "  · "}  ${String(e.rows).padStart(4)} ${String(e.nonzero).padStart(5)}  ` +
        `${String(e.a).padStart(6)} ${String(e.adv).padStart(5)} ${String(e.pen).padStart(5)}   ${e.updatedMax.slice(0, 19)}`,
    );
  }

  console.log("\n=== 전 기간 요약: 공식휴식 vs 활동주차 ===");
  let restRows = 0, restNz = 0, actRows = 0, actNz = 0, transRows = 0, transNz = 0;
  for (const [start, e] of byStart) {
    const w = weekByStart.get(start);
    if (!w) continue;
    if (w.week_number === 0) { transRows += e.rows; transNz += e.nonzero; continue; }
    if (w.is_official_rest) { restRows += e.rows; restNz += e.nonzero; }
    else { actRows += e.rows; actNz += e.nonzero; }
  }
  console.log(`공식휴식 주차: ${restRows}행 중 비영 ${restNz}`);
  console.log(`활동  주차: ${actRows}행 중 비영 ${actNz}`);
  console.log(`전환(W0) 주차: ${transRows}행 중 비영 ${transNz}`);

  // checks_migrated 별 분리(PMS 이관 vs 프로세스 체크 적립)
  console.log("\n=== checks_migrated 별 ===");
  const byFlag = new Map<string, { rows: number; nz: number }>();
  for (const r of uwp) {
    const w = r.week_start_date ? weekByStart.get(r.week_start_date) : undefined;
    const kind = !w ? "week없음(1900)" : w.week_number === 0 ? "전환" : w.is_official_rest ? "공식휴식" : "활동";
    const k = `${r.checks_migrated ? "migrated=T" : "migrated=F"} / ${kind}`;
    const e = byFlag.get(k) ?? { rows: 0, nz: 0 };
    e.rows += 1;
    if ((r.points ?? 0) || (r.advantages ?? 0) || (r.penalty ?? 0)) e.nz += 1;
    byFlag.set(k, e);
  }
  [...byFlag.entries()].sort().forEach(([k, v]) => console.log(`  ${k.padEnd(32)} 행 ${String(v.rows).padStart(6)}  비영 ${v.nz}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
