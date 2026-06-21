/**
 * 라인 개설 주차 필터 — 잘못된 주차(0주차 / 시즌 최대 초과) 데이터 진단.
 *   npx tsx --env-file=.env.local scripts/diag-invalid-line-opening-weeks.ts
 *
 * 점검:
 *   - weeks 테이블에서 week_number = 0 행
 *   - season_key 별 최대 주차 초과 행(봄/가을 >16, 여름/겨울 >8) — 전환 주차(+1) 포함
 *   - 겨울 경계(시작 연도 != 종료 연도) 행 — 연도 표시 기준 검증용
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const SEASON_MAX: Record<string, number> = {
  spring: 16,
  summer: 8,
  autumn: 16,
  winter: 8,
};

function seasonTypeOf(seasonKey: string | null): string | null {
  if (!seasonKey) return null;
  const m = /(spring|summer|autumn|winter)/i.exec(seasonKey);
  return m ? m[1].toLowerCase() : null;
}

async function main() {
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date,is_official_rest")
    .order("start_date", { ascending: true });

  if (error) {
    console.error("query error:", error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as Array<{
    id: string;
    season_key: string | null;
    week_number: number | null;
    start_date: string | null;
    end_date: string | null;
    is_official_rest: boolean | null;
  }>;

  console.log(`총 weeks 행: ${rows.length}`);

  const zero = rows.filter((r) => r.week_number === 0);
  console.log(`\n=== week_number = 0 (${zero.length}) ===`);
  for (const r of zero) {
    console.log(`  ${r.season_key} W${r.week_number} ${r.start_date}~${r.end_date} rest=${r.is_official_rest}`);
  }

  const over = rows.filter((r) => {
    const t = seasonTypeOf(r.season_key);
    const max = t ? SEASON_MAX[t] : null;
    return max != null && r.week_number != null && r.week_number > max;
  });
  console.log(`\n=== 시즌 최대 초과 (${over.length}) — 봄/가을>16, 여름/겨울>8 ===`);
  const byKey = new Map<string, number[]>();
  for (const r of over) {
    const k = r.season_key ?? "?";
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r.week_number ?? -1);
  }
  for (const [k, nums] of Array.from(byKey.entries()).sort()) {
    console.log(`  ${k}: W${nums.sort((a, b) => a - b).join(", W")}`);
  }

  const boundary = rows.filter(
    (r) =>
      r.start_date &&
      r.end_date &&
      r.start_date.slice(0, 4) !== r.end_date.slice(0, 4),
  );
  console.log(`\n=== 연도 경계(시작연도 != 종료연도) 행 (${boundary.length}) ===`);
  for (const r of boundary) {
    console.log(
      `  ${r.season_key} W${r.week_number} ${r.start_date}~${r.end_date} → 시작연도=${r.start_date!.slice(0, 4)} 종료연도=${r.end_date!.slice(0, 4)}`,
    );
  }
}

main().then(() => process.exit(0));
