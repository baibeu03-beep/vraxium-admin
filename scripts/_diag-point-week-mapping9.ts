// READ-ONLY — "주차별 포인트가 휴식 주차에만 보인다" 현상의 사용자 규모 정량화.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Num = number | null;
async function pageAll<T>(build: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; const PAGE = 1000; let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[]; out.push(...rows);
    if (rows.length < PAGE) break; from += PAGE;
  }
  return out;
}

async function main() {
  const weeks = await pageAll<{ start_date: string | null; week_number: Num; is_official_rest: boolean | null }>(
    (f, t) => supabaseAdmin.from("weeks").select("start_date,week_number,is_official_rest").order("start_date").range(f, t));
  const kind = new Map<string, "rest" | "transition" | "activity">();
  for (const w of weeks) {
    if (!w.start_date) continue;
    kind.set(w.start_date, w.week_number === 0 ? "transition" : w.is_official_rest ? "rest" : "activity");
  }

  const uwp = await pageAll<{ user_id: string; week_start_date: string | null; points: Num; advantages: Num; penalty: Num; checks_migrated: boolean | null; updated_at: string | null }>(
    (f, t) => supabaseAdmin.from("user_weekly_points")
      .select("user_id,week_start_date,points,advantages,penalty,checks_migrated,updated_at").order("id").range(f, t));

  const per = new Map<string, { nzRest: number; nzTrans: number; nzAct: number; zeroedRows: number; totalRows: number }>();
  for (const r of uwp) {
    const e = per.get(r.user_id) ?? { nzRest: 0, nzTrans: 0, nzAct: 0, zeroedRows: 0, totalRows: 0 };
    e.totalRows += 1;
    if (String(r.updated_at ?? "").startsWith("2026-07-25T04:52:05") && r.checks_migrated) e.zeroedRows += 1;
    const nz = (r.points ?? 0) !== 0 || (r.advantages ?? 0) !== 0 || (r.penalty ?? 0) !== 0;
    if (nz && r.week_start_date) {
      const k = kind.get(r.week_start_date);
      if (k === "rest") e.nzRest += 1;
      else if (k === "transition") e.nzTrans += 1;
      else if (k === "activity") e.nzAct += 1;
      // week 부재(1900 sentinel)는 카드/표에 안 나오므로 제외
    }
    per.set(r.user_id, e);
  }

  let onlyRestLike = 0, hasAny = 0, allZeroDisplayable = 0;
  for (const [, e] of per) {
    const displayableNz = e.nzRest + e.nzTrans + e.nzAct;
    if (displayableNz === 0) { allZeroDisplayable += 1; continue; }
    hasAny += 1;
    if (e.nzAct === 0) onlyRestLike += 1;
  }
  console.log(`uwp 보유 사용자 ${per.size}명`);
  console.log(`  · 표에 표시될 비영 주차가 아예 없음(전부 0)        : ${allZeroDisplayable}명`);
  console.log(`  · 비영 주차 보유                                  : ${hasAny}명`);
  console.log(`     - 그중 비영 주차가 전부 공식휴식/전환 주차       : ${onlyRestLike}명  ← "휴식 주차에만 포인트" 화면`);
  console.log(`     - 활동 주차에도 값이 남음                        : ${hasAny - onlyRestLike}명`);

  const zeroedUsers = [...per.values()].filter((e) => e.zeroedRows > 0).length;
  const zeroedRows = [...per.values()].reduce((s, e) => s + e.zeroedRows, 0);
  console.log(`\n2026-07-25T04:52:05 일괄 갱신(=마이그 §1·§2) 영향: ${zeroedRows}행 / ${zeroedUsers}명`);

  const cmTrue = uwp.filter((r) => r.checks_migrated).length;
  console.log(`checks_migrated=true 행: ${cmTrue} / 전체 ${uwp.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
