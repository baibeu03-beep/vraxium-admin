/**
 * READ-ONLY 감사 — process_point_awards 원장에서 패널티(Po.C) 동시 지급 사례 census.
 *   npx tsx --env-file=.env.local scripts/diag-poc-double-grant-audit.ts
 * 정책(2026-07-04): 원장 대상자는 전원 recipients match_type='matched'(=이행자). 이행자는 Po.C 금지.
 *   → point_penalty>0 인 원장행은 모두 위반. A+C / B+C / C-only 로 분해 보고.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function fetchAll(cols: string) {
  const out: any[] = [];
  const page = 1000; let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("process_point_awards").select(cols)
      .order("ref_id", { ascending: true }).range(from, from + page - 1);
    if (error) throw new Error("process_point_awards: " + error.message);
    const b = (data ?? []) as any[]; out.push(...b);
    if (b.length < page) break; from += page;
  }
  return out;
}

async function main() {
  const rows = await fetchAll("id,source,ref_id,user_id,year,week_number,point_check,point_advantage,point_penalty,organization_slug,scope_mode");
  console.log("총 원장행:", rows.length);

  const withPen = rows.filter((r) => (r.point_penalty ?? 0) > 0);
  const aAndC = withPen.filter((r) => (r.point_check ?? 0) > 0);
  const bAndC = withPen.filter((r) => (r.point_advantage ?? 0) > 0);
  const aOrBandC = withPen.filter((r) => (r.point_check ?? 0) > 0 || (r.point_advantage ?? 0) > 0);
  const cOnly = withPen.filter((r) => (r.point_check ?? 0) === 0 && (r.point_advantage ?? 0) === 0);

  console.table([{
    "penalty>0 원장행": withPen.length,
    "A+C(check&pen)": aAndC.length,
    "B+C(adv&pen)": bAndC.length,
    "A||B + C(위반 핵심)": aOrBandC.length,
    "C-only": cOnly.length,
  }]);

  const byMode: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const users = new Set<string>();
  const weeks = new Set<string>();
  const refs = new Set<string>();
  for (const r of withPen) {
    byMode[r.scope_mode ?? "null"] = (byMode[r.scope_mode ?? "null"] ?? 0) + 1;
    bySource[r.source ?? "null"] = (bySource[r.source ?? "null"] ?? 0) + 1;
    users.add(r.user_id); weeks.add(`${r.year}-${r.week_number}`); refs.add(`${r.source}:${r.ref_id}`);
  }
  console.log("penalty>0 분포:", { byMode, bySource,
    "영향 유저": users.size, "영향 주차": [...weeks], "영향 act(ref)": refs.size });

  console.log("\n── penalty>0 상세(최대 40) ──");
  console.table(withPen.slice(0, 40).map((r) => ({
    source: r.source, ref: String(r.ref_id).slice(0, 8), user: String(r.user_id).slice(0, 8),
    yw: `${r.year}W${r.week_number}`, A: r.point_check, B: r.point_advantage, C: r.point_penalty,
    org: r.organization_slug, mode: r.scope_mode,
  })));
  console.log("[done] READ-ONLY.");
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
