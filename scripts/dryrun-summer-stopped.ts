/**
 * dry-run(read-only): 2026-summer '시즌 중단' 66명 → user_season_statuses(2026-summer, stopped) 계획.
 *   npx tsx --env-file=.env.local scripts/dryrun-summer-stopped.ts
 * 실제 삽입은 별도 --apply 스크립트로 승인 후 진행(이 파일은 write 0).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DUMP = "claudedocs/summer-final-xlsx-dump.json";
const SUMMER_KEY = "2026-summer";
const ORG_MAP: Record<string, string> = { "엥크레": "encre", "오랑캐": "oranke", "팔랑크스": "phalanx" };
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(84));

function excelCategory(status: string): string {
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
  const out: Array<{ org: string; orgSlug: string; name: string; status: string; cat: string; weeks: number | null }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const name = (r[1] ?? "").trim(); if (!name) continue;
    const c2 = (r[2] ?? "").trim(), c3 = (r[3] ?? "").trim(); const c2num = /^\d+$/.test(c2);
    const status = c2num ? c3 : c2; const wr = c2num ? c2 : c3;
    out.push({ org: (r[0] ?? "").trim(), orgSlug: ORG_MAP[(r[0] ?? "").trim()] ?? "", name, status, cat: excelCategory(status), weeks: /^\d+$/.test(wr) ? Number(wr) : null });
  }
  return out;
}

async function main() {
  const stopped = loadExcel().filter((e) => e.cat === "중단");
  hr(); line(`Excel '시즌 중단' 행: ${stopped.length}`); hr();

  // DB 프로필 + approved + markers + 기존 summer status
  const profByOrgName = new Map<string, any[]>(); const profById = new Map<string, any>();
  for (const org of ["encre", "oranke", "phalanx"]) {
    for (let from = 0; ; from += 1000) {
      const { data } = await supabaseAdmin.from("user_profiles").select("user_id,display_name,organization_slug,growth_status").eq("organization_slug", org).order("user_id").range(from, from + 999);
      const rows = (data ?? []) as any[];
      for (const p of rows) { const k = `${org}|${(p.display_name ?? "").trim()}`; const a = profByOrgName.get(k) ?? []; a.push(p); profByOrgName.set(k, a); profById.set(p.user_id, p); }
      if (rows.length < 1000) break;
    }
  }
  const allIds = [...profById.keys()];
  const approvedById = new Map<string, number>();
  for (let i = 0; i < allIds.length; i += 300) { const { data } = await supabaseAdmin.from("user_growth_stats").select("user_id,approved_weeks").in("user_id", allIds.slice(i, i + 300)); for (const g of (data ?? []) as any[]) approvedById.set(g.user_id, g.approved_weeks); }
  const markers = new Set<string>(); { const { data } = await supabaseAdmin.from("test_user_markers").select("user_id"); for (const m of (data ?? []) as any[]) markers.add(m.user_id); }
  // 기존 2026-summer status(rest=50 포함) — 충돌 검사
  const summerStatusById = new Map<string, string>();
  for (let from = 0; ; from += 1000) { const { data } = await supabaseAdmin.from("user_season_statuses").select("user_id,status").eq("season_key", SUMMER_KEY).order("user_id").range(from, from + 999); for (const r of (data ?? []) as any[]) summerStatusById.set(r.user_id, r.status); if ((data ?? []).length < 1000) break; }

  const resolved: Array<{ name: string; org: string; userId: string; approved: number | null; excelWeeks: number | null; existingSummer: string | null; test: boolean }> = [];
  const held: Array<{ name: string; org: string; reason: string }> = [];
  for (const e of stopped) {
    const cands = profByOrgName.get(`${e.orgSlug}|${e.name}`) ?? [];
    if (cands.length === 0) { held.push({ name: e.name, org: e.orgSlug, reason: "user_profiles 매칭 0" }); continue; }
    let chosen = cands[0];
    if (cands.length > 1) {
      if (e.weeks == null) { held.push({ name: e.name, org: e.orgSlug, reason: `동명이인 ${cands.length}·주차없음` }); continue; }
      const sc = cands.map((c) => ({ c, d: Math.abs((approvedById.get(c.user_id) ?? -999) - e.weeks!) })).sort((a, b) => a.d - b.d);
      if (sc.length >= 2 && sc[0].d === sc[1].d) { held.push({ name: e.name, org: e.orgSlug, reason: `동명이인 ${cands.length}·주차동률(approved=${sc.map((x) => approvedById.get(x.c.user_id)).join("/")})` }); continue; }
      chosen = sc[0].c;
    }
    resolved.push({ name: e.name, org: e.orgSlug, userId: chosen.user_id, approved: approvedById.get(chosen.user_id) ?? null, excelWeeks: e.weeks, existingSummer: summerStatusById.get(chosen.user_id) ?? null, test: markers.has(chosen.user_id) });
  }

  const perOrg = (arr: { org: string }[]) => ({ encre: arr.filter((x) => x.org === "encre").length, oranke: arr.filter((x) => x.org === "oranke").length, phalanx: arr.filter((x) => x.org === "phalanx").length });
  line(`확정 ${resolved.length}  ${JSON.stringify(perOrg(resolved))}`);
  line(`보류 ${held.length}: ${held.map((h) => `${h.org}/${h.name}(${h.reason})`).join(", ") || "없음"}`);

  hr(); line("충돌 검사 — 기존 2026-summer 행 보유자(rest 등)"); hr();
  const conflicts = resolved.filter((r) => r.existingSummer);
  line(`기존 2026-summer 행 있는 중단대상: ${conflicts.length}`);
  for (const c of conflicts) line(`  ⚠ ${c.org}/${c.name} ${c.userId.slice(0, 8)} 기존=${c.existingSummer} → stopped 로? (휴식↔중단 상태 충돌 — 수동 판단)`);
  const testCount = resolved.filter((r) => r.test).length;
  line(`(테스트 계정 포함: ${testCount})`);

  hr(); line("삽입 대상 미리보기(상위 20)"); hr();
  line("name | org | approved | ExcelWeeks | 기존summer | test");
  for (const r of resolved.slice(0, 20)) line(`  ${r.name} | ${r.org} | ${r.approved ?? "-"} | ${r.excelWeeks ?? "-"} | ${r.existingSummer ?? "-"} | ${r.test ? "T" : ""}`);
  if (resolved.length > 20) line(`  ... (총 ${resolved.length})`);

  writeFileSync("claudedocs/dryrun-summer-stopped.json", JSON.stringify({ resolvedCount: resolved.length, perOrg: perOrg(resolved), held, conflicts, resolved }, null, 1));
  line(`\n→ claudedocs/dryrun-summer-stopped.json  (write 0 · dry-run)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
