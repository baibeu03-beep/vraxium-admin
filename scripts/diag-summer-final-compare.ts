/**
 * 진단(read-only): '26 여름 최종.xlsx' SoT ↔ Vraxium DB 비교.
 *   npx tsx --env-file=.env.local scripts/diag-summer-final-compare.ts
 *
 * Excel 레이아웃: 엥크레=[org,name,status,weeks], 오랑캐/팔랑크스=[org,name,weeks,status] (스왑) → col2 숫자면 스왑.
 * 매칭: (org, display_name) → user_profiles. 동명이인은 누적주차(user_growth_stats.cumulative_weeks) 근접도로 확정, 그래도 모호하면 fail(보고).
 * DB 여름 상태 파생: summer rest 행 있으면 휴식 / growth_status=suspended→중단 / graduated→졸업 / 그 외 활동.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DUMP = "claudedocs/summer-final-xlsx-dump.json";
const SUMMER_KEY = "2026-summer";
const ORG_MAP: Record<string, string> = { "엥크레": "encre", "오랑캐": "oranke", "팔랑크스": "phalanx" };
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(90));

// Excel 상태 → 카테고리
function excelCategory(status: string): "활동" | "휴식" | "중단" | "운영진" | "검수" | "기타" {
  const s = status.replace(/\s+/g, "");
  if (s.includes("운영진")) return "운영진";
  if (s.includes("휴식")) return "휴식";
  if (s.includes("중단")) return "중단";
  if (s.includes("검수")) return "검수";
  if (s.includes("활동")) return "활동";
  return "기타";
}

type Ex = { org: string; orgSlug: string; name: string; status: string; cat: string; weeks: number | null; note: string };

function loadExcel(): Ex[] {
  const d = JSON.parse(readFileSync(DUMP, "utf8"));
  const rows: string[][] = d.sheets[0].rows;
  const out: Ex[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const org = (r[0] ?? "").trim();
    const name = (r[1] ?? "").trim();
    if (!name) continue;
    const c2 = (r[2] ?? "").trim(), c3 = (r[3] ?? "").trim();
    const c2num = /^\d+$/.test(c2);
    const status = c2num ? c3 : c2;
    const weeksRaw = c2num ? c2 : c3;
    const weeks = /^\d+$/.test(weeksRaw) ? Number(weeksRaw) : null;
    out.push({ org, orgSlug: ORG_MAP[org] ?? org, name, status, cat: excelCategory(status), weeks, note: (r[5] ?? "").trim() });
  }
  return out;
}

async function main() {
  const excel = loadExcel();
  hr(); line(`Excel SoT: ${excel.length}명`);
  const byOrg: Record<string, number> = {}, byCat: Record<string, number> = {};
  for (const e of excel) { byOrg[e.org] = (byOrg[e.org] ?? 0) + 1; byCat[e.cat] = (byCat[e.cat] ?? 0) + 1; }
  line(`  org별: ${JSON.stringify(byOrg)}`);
  line(`  상태 카테고리: ${JSON.stringify(byCat)}`);

  // DB: org별 user_profiles + growth_stats + summer season status + test markers
  const orgs = ["encre", "oranke", "phalanx"];
  const profByOrgName = new Map<string, any[]>(); // `${org}|${name}` -> candidates
  const profById = new Map<string, any>();
  for (const org of orgs) {
    for (let from = 0; ; from += 1000) {
      const { data } = await supabaseAdmin.from("user_profiles")
        .select("user_id,display_name,organization_slug,growth_status,status,current_team_name,current_part_name")
        .eq("organization_slug", org).order("user_id").range(from, from + 999);
      const rows = (data ?? []) as any[];
      for (const p of rows) {
        const k = `${org}|${(p.display_name ?? "").trim()}`;
        const arr = profByOrgName.get(k) ?? [];
        arr.push(p);
        profByOrgName.set(k, arr);
        profById.set(p.user_id, p);
      }
      if (rows.length < 1000) break;
    }
  }
  const allIds = [...profById.keys()];
  // growth_stats
  const gsById = new Map<string, any>();
  for (let i = 0; i < allIds.length; i += 300) {
    const { data } = await supabaseAdmin.from("user_growth_stats").select("user_id,cumulative_weeks,approved_weeks").in("user_id", allIds.slice(i, i + 300));
    for (const g of (data ?? []) as any[]) gsById.set(g.user_id, g);
  }
  // summer rest
  const summerRest = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_season_statuses").select("user_id").eq("season_key", SUMMER_KEY).eq("status", "rest").order("user_id").range(from, from + 999);
    for (const r of (data ?? []) as any[]) summerRest.add(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  const markers = new Set<string>();
  { const { data } = await supabaseAdmin.from("test_user_markers").select("user_id"); for (const m of (data ?? []) as any[]) markers.add(m.user_id); }

  // DB 여름 상태 파생
  const dbStatus = (p: any): string => {
    if (summerRest.has(p.user_id)) return "휴식";
    const g = String(p.growth_status ?? "").toLowerCase();
    if (g === "suspended" || g === "withdrawn" || g === "expelled") return "중단";
    if (g === "graduated") return "졸업";
    return "활동";
  };

  // 매칭
  type Match = { ex: Ex; userId: string | null; reason: string; dbStat?: string; dbCum?: number | null; dbApproved?: number | null };
  const matched: Match[] = [];
  for (const e of excel) {
    const cands = profByOrgName.get(`${e.orgSlug}|${e.name}`) ?? [];
    if (cands.length === 0) { matched.push({ ex: e, userId: null, reason: "missing" }); continue; }
    let chosen = cands[0];
    if (cands.length > 1) {
      // 누적주차 근접도로 확정(Excel weeks ↔ cumulative_weeks). 동률/주차없음이면 fail.
      if (e.weeks == null) { matched.push({ ex: e, userId: null, reason: `ambiguous(${cands.length})·주차없음` }); continue; }
      // Excel 누적주차 = approved_weeks(성공주차)에 대응 → approved 근접도로 동명이인 확정.
      const scored = cands.map((c) => ({ c, diff: Math.abs((gsById.get(c.user_id)?.approved_weeks ?? -999) - e.weeks!) })).sort((a, b) => a.diff - b.diff);
      if (scored.length >= 2 && scored[0].diff === scored[1].diff) { matched.push({ ex: e, userId: null, reason: `ambiguous(${cands.length})·주차동률` }); continue; }
      chosen = scored[0].c;
    }
    const g = gsById.get(chosen.user_id);
    matched.push({ ex: e, userId: chosen.user_id, reason: cands.length > 1 ? "dup-resolved(주차)" : "single", dbStat: dbStatus(chosen), dbCum: g?.cumulative_weeks ?? null, dbApproved: g?.approved_weeks ?? null });
  }

  const ok = matched.filter((m) => m.userId);
  const missing = matched.filter((m) => m.reason === "missing");
  const ambiguous = matched.filter((m) => m.reason.startsWith("ambiguous"));
  hr(); line(`매칭: 성공 ${ok.length} · 누락 ${missing.length} · 모호 ${ambiguous.length}`);
  if (missing.length) line(`  누락: ${missing.map((m) => `${m.ex.org}/${m.ex.name}`).join(", ")}`);
  if (ambiguous.length) line(`  모호: ${ambiguous.map((m) => `${m.ex.org}/${m.ex.name}(${m.reason})`).join(", ")}`);

  // 상태 diff (Excel cat vs DB status) — 운영진=활동 취급(role 별개), 검수/기타=조사
  const norm = (c: string) => (c === "운영진" ? "활동" : c);
  const statusDiff = ok.filter((m) => norm(m.ex.cat) !== m.dbStat && !["검수", "기타"].includes(m.ex.cat));
  const reviewRows = ok.filter((m) => ["검수", "기타"].includes(m.ex.cat));
  hr(); line(`상태 차이(조치 필요): ${statusDiff.length}  /  검수·기타(조사): ${reviewRows.length}`);
  line("이름 | org | DB상태 | Excel상태 | DB누적 | Excel누적 | test | 조치");
  for (const m of statusDiff) {
    const t = markers.has(m.userId!) ? "T" : "";
    line(`  ${m.ex.name} | ${m.ex.orgSlug} | ${m.dbStat} | ${m.ex.cat}(${m.ex.status}) | ${m.dbCum ?? "-"} | ${m.ex.weeks ?? "-"} | ${t} | → ${m.ex.cat}`);
  }
  if (reviewRows.length) { line("  -- 검수/기타 --"); for (const m of reviewRows) line(`  ${m.ex.name} | ${m.ex.orgSlug} | ${m.dbStat} | ${m.ex.status} | 비고:${m.ex.note}`); }

  // 누적주차 diff = Excel ↔ approved_weeks(성공주차) 기준(|Δ|>=1). cumulative_weeks 는 참고만.
  const weekDiff = ok.filter((m) => m.ex.weeks != null && m.dbApproved != null && Math.abs(m.dbApproved - m.ex.weeks) >= 1);
  hr(); line(`누적주차 차이(Excel ↔ approved_weeks, |Δ|>=1): ${weekDiff.length} / 매칭 ${ok.length}`);
  for (const m of weekDiff.slice(0, 60)) {
    const t = markers.has(m.userId!) ? "T" : "";
    line(`  ${m.ex.name} | ${m.ex.orgSlug} | approved=${m.dbApproved}(cum=${m.dbCum}) | Excel=${m.ex.weeks} | Δapproved=${(m.dbApproved ?? 0) - (m.ex.weeks ?? 0)} | ${m.ex.cat}${t ? " T" : ""}`);
  }
  if (weekDiff.length > 60) line(`  ... (총 ${weekDiff.length})`);
  const weekExact = ok.filter((m) => m.ex.weeks != null && m.dbApproved === m.ex.weeks).length;
  line(`  (참고) Excel == approved_weeks 정확 일치: ${weekExact} / ${ok.filter((m) => m.ex.weeks != null).length}`);

  // summer rest 교차: Excel 휴식 ↔ DB summer rest
  const exRestIds = new Set(ok.filter((m) => m.ex.cat === "휴식").map((m) => m.userId!));
  const dbRestMatched = [...summerRest].filter((id) => profById.has(id));
  const exRestNotDb = [...exRestIds].filter((id) => !summerRest.has(id));
  const dbRestNotEx = dbRestMatched.filter((id) => !exRestIds.has(id));
  hr(); line(`여름 휴식 교차: Excel휴식 ${exRestIds.size} · DB summer-rest(매칭) ${dbRestMatched.length}`);
  line(`  Excel휴식인데 DB summer-rest 없음: ${exRestNotDb.length} → ${exRestNotDb.map((id) => profById.get(id)?.display_name).join(", ") || "없음"}`);
  line(`  DB summer-rest인데 Excel휴식 아님: ${dbRestNotEx.length} → ${dbRestNotEx.map((id) => `${profById.get(id)?.display_name}(${ok.find((m) => m.userId === id)?.ex.cat ?? "Excel없음"})`).join(", ") || "없음"}`);

  line("\n(JSON 저장)");
  writeFileSync("claudedocs/summer-final-compare.json", JSON.stringify({ matched, statusDiff, weekDiff, exRestNotDb, dbRestNotEx }, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
