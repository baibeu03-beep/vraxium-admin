// READ-ONLY 진단 4 — uwp 행 created_at / updated_at 분포 + 2026-07-25 대량 갱신 정체 파악.
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
  const uwp = await pageAll<{
    id: number | string; user_id: string; year: Num; week_number: Num; week_start_date: string | null;
    points: Num; advantages: Num; penalty: Num; checks_migrated: boolean | null;
    created_at: string | null; updated_at: string | null;
  }>((f, t) =>
    supabaseAdmin.from("user_weekly_points")
      .select("id,user_id,year,week_number,week_start_date,points,advantages,penalty,checks_migrated,created_at,updated_at")
      .order("id", { ascending: true }).range(f, t),
  );

  const bucket = (iso: string | null) => (iso ? iso.slice(0, 13) : "(null)");
  const cAgg = new Map<string, number>();
  const uAgg = new Map<string, number>();
  for (const r of uwp) {
    cAgg.set(bucket(r.created_at), (cAgg.get(bucket(r.created_at)) ?? 0) + 1);
    uAgg.set(bucket(r.updated_at), (uAgg.get(bucket(r.updated_at)) ?? 0) + 1);
  }
  console.log("=== created_at 시간대별(UTC, 상위 20) ===");
  [...cAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, v]) => console.log(`  ${k}  ${v}`));
  console.log("\n=== updated_at 시간대별(UTC, 상위 20) ===");
  [...uAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, v]) => console.log(`  ${k}  ${v}`));

  const exact = uwp.filter((r) => (r.updated_at ?? "").startsWith("2026-07-25T04:52:05"));
  console.log(`\n2026-07-25T04:52:05 정각 갱신 행: ${exact.length}`);
  const exactCreated = new Map<string, number>();
  for (const r of exact) exactCreated.set(bucket(r.created_at), (exactCreated.get(bucket(r.created_at)) ?? 0) + 1);
  console.log("  그 행들의 created_at 분포:");
  [...exactCreated.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`    ${k}  ${v}`));
  const exactNonZero = exact.filter((r) => (r.points ?? 0) || (r.advantages ?? 0) || (r.penalty ?? 0));
  console.log(`  그 중 값이 0 아닌 행: ${exactNonZero.length}`);
  console.log(`  그 중 checks_migrated=true: ${exact.filter((r) => r.checks_migrated).length}`);

  // created==updated (한 번도 갱신 안 됨) 비율
  const untouched = uwp.filter((r) => r.created_at === r.updated_at);
  console.log(`\ncreated_at == updated_at (미갱신) 행: ${untouched.length} / ${uwp.length}`);

  // 최근 갱신 상위 20행 상세
  console.log("\n=== updated_at 최신 20행 ===");
  [...uwp].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 20)
    .forEach((r) => console.log(
      `  ${r.updated_at}  created=${r.created_at}  ${r.user_id.slice(0, 8)} ${r.year}-W${r.week_number} ` +
      `${r.week_start_date} A=${r.points} adv=${r.advantages} pen=${r.penalty} migrated=${r.checks_migrated}`,
    ));
}

main().catch((e) => { console.error(e); process.exit(1); });
