/**
 * 진단(read-only): /admin/members 모집단 vs 2026-summer SoT 318.
 *   npx tsx --env-file=.env.local scripts/diag-summer-roster-population.ts
 */
import { readFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listAdminCrewDtos } from "@/lib/adminCrewData";

const DUMP = "claudedocs/summer-final-xlsx-dump.json";
const ORG_MAP: Record<string, string> = { "엥크레": "encre", "오랑캐": "oranke", "팔랑크스": "phalanx" };
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(76));

function cat(status: string): string {
  const s = status.replace(/\s+/g, "");
  if (s.includes("운영진")) return "운영진";
  if (s.includes("휴식")) return "휴식";
  if (s.includes("중단")) return "중단";
  if (s.includes("검수")) return "검수";
  if (s.includes("활동")) return "활동";
  return "기타";
}
function loadExcel() {
  const d = JSON.parse(readFileSync(DUMP, "utf8"));
  const rows: string[][] = d.sheets[0].rows;
  const out: Array<{ orgSlug: string; name: string; cat: string; weeks: number | null }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const name = (r[1] ?? "").trim(); if (!name) continue;
    const c2 = (r[2] ?? "").trim(), c3 = (r[3] ?? "").trim(); const c2num = /^\d+$/.test(c2);
    const status = c2num ? c3 : c2; const wr = c2num ? c2 : c3;
    out.push({ orgSlug: ORG_MAP[(r[0] ?? "").trim()] ?? "", name, cat: cat(status), weeks: /^\d+$/.test(wr) ? Number(wr) : null });
  }
  return out;
}

async function main() {
  hr(); line("1. /admin/members 현재 모집단 (listAdminCrewDtos = user_profiles org+scope, season 필터 없음)"); hr();
  const operating = await listAdminCrewDtos(null, "operating");
  line(`  operating 모집단 = ${operating.length}명 (DB user_profiles 전체 — season 무관)`);

  // 2026-summer user_season_statuses 보유자
  const summerByStatus: Record<string, Set<string>> = { rest: new Set(), stopped: new Set(), success: new Set(), active: new Set() };
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_season_statuses").select("user_id,status").eq("season_key", "2026-summer").order("user_id").range(from, from + 999);
    for (const r of (data ?? []) as any[]) (summerByStatus[r.status] ?? (summerByStatus[r.status] = new Set())).add(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  const summerAll = new Set([...Object.values(summerByStatus)].flatMap((s) => [...s]));
  hr(); line("2. 2026-summer user_season_statuses 현황"); hr();
  for (const [k, s] of Object.entries(summerByStatus)) if (s.size) line(`  ${k}: ${s.size}`);
  line(`  → 2026-summer 행 보유 합계 = ${summerAll.size} (현재 rest50+stopped66=116)`);
  line(`  ⇒ user_season_statuses(rest/stopped)만으로는 318 모집단 불가 — 활동/운영진 ${318 - 116}명은 행 없음`);

  hr(); line("3. Excel SoT 318 분류 + user_id 해석"); hr();
  const excel = loadExcel();
  const byCat: Record<string, number> = {};
  for (const e of excel) byCat[e.cat] = (byCat[e.cat] ?? 0) + 1;
  line(`  Excel 318 카테고리: ${JSON.stringify(byCat)}`);

  // 프로필 + approved (동명이인 해석)
  const profByOrgName = new Map<string, any[]>();
  const approvedById = new Map<string, number>();
  const allProf: any[] = [];
  for (const org of ["encre", "oranke", "phalanx"]) {
    for (let from = 0; ; from += 1000) {
      const { data } = await supabaseAdmin.from("user_profiles").select("user_id,display_name,organization_slug").eq("organization_slug", org).order("user_id").range(from, from + 999);
      const rows = (data ?? []) as any[];
      for (const p of rows) { const k = `${org}|${(p.display_name ?? "").trim()}`; const a = profByOrgName.get(k) ?? []; a.push(p); profByOrgName.set(k, a); allProf.push(p); }
      if (rows.length < 1000) break;
    }
  }
  for (let i = 0; i < allProf.length; i += 300) { const { data } = await supabaseAdmin.from("user_growth_stats").select("user_id,approved_weeks").in("user_id", allProf.slice(i, i + 300).map((p) => p.user_id)); for (const g of (data ?? []) as any[]) approvedById.set(g.user_id, g.approved_weeks); }

  const resolvedIds = new Set<string>(); let missing = 0, ambiguous = 0;
  const needRowByCat: Record<string, number> = {};
  for (const e of excel) {
    const cands = profByOrgName.get(`${e.orgSlug}|${e.name}`) ?? [];
    let chosen: any = null;
    if (cands.length === 1) chosen = cands[0];
    else if (cands.length === 0) { missing++; continue; }
    else { if (e.weeks == null) { ambiguous++; continue; } const sc = cands.map((c) => ({ c, d: Math.abs((approvedById.get(c.user_id) ?? -999) - e.weeks!) })).sort((a, b) => a.d - b.d); if (sc.length >= 2 && sc[0].d === sc[1].d) { ambiguous++; continue; } chosen = sc[0].c; }
    resolvedIds.add(chosen.user_id);
    // 2026-summer 행 없는 카테고리(활동/운영진/검수/기타)는 신규 'active'(또는 결정) 행 필요
    if (!summerAll.has(chosen.user_id)) needRowByCat[e.cat] = (needRowByCat[e.cat] ?? 0) + 1;
  }
  line(`  해석: 단일매칭 ${resolvedIds.size} · 누락 ${missing} · 모호 ${ambiguous}`);

  hr(); line("4. 318 모집단 구성에 필요한 신규 season 행"); hr();
  line(`  2026-summer 행 이미 있음(rest/stopped): ${[...resolvedIds].filter((id) => summerAll.has(id)).length}`);
  line(`  2026-summer 행 없음(신규 필요): ${[...resolvedIds].filter((id) => !summerAll.has(id)).length}`);
  line(`    카테고리별 신규 필요: ${JSON.stringify(needRowByCat)}`);

  hr(); line("5. 633 중 318 SoT 밖(과거/제외 대상) 추정"); hr();
  const opIds = new Set(operating.map((m: any) => m.userId));
  const notInSoT = [...opIds].filter((id) => !resolvedIds.has(id));
  line(`  operating 633 중 318 SoT 밖 = ${notInSoT.length} (기본 목록에서 제외 대상)`);
  // 그 중 growth_status=seasonal_rest(봄 이관 365 등) 표본
  const { data: sample } = await supabaseAdmin.from("user_profiles").select("user_id,display_name,growth_status").in("user_id", notInSoT.slice(0, 500));
  const gsDist: Record<string, number> = {};
  for (const p of (sample ?? []) as any[]) gsDist[p.growth_status ?? "(null)"] = (gsDist[p.growth_status ?? "(null)"] ?? 0) + 1;
  line(`    제외 대상 growth_status 분포(표본): ${JSON.stringify(gsDist)}`);

  hr(); line("DONE");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
