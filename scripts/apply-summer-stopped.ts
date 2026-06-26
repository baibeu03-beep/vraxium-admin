/**
 * apply-summer-stopped — 2026 여름 '시즌 중단' 66명 → user_season_statuses(2026-summer, stopped).
 *   npx tsx --env-file=.env.local scripts/apply-summer-stopped.ts            # PREVIEW (write 0)
 *   npx tsx --env-file=.env.local scripts/apply-summer-stopped.ts --apply
 *   npx tsx --env-file=.env.local scripts/apply-summer-stopped.ts --rollback <runlog.json>
 *
 * 계약(사용자 확정 2026-06-26): growth_status 무수정 · 과거 시즌 무소급 · 후보=Excel '시즌 중단'만.
 *   동명이인은 approved_weeks 근접으로 확정(0/동률 = 보류). 기존 2026-summer 행 보유자 = 충돌 보고(skip).
 *   멱등(이미 stopped 행 있으면 skip). 마이그레이션(2026-06-26_user_season_statuses_stopped.sql) 선행 필수.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const DUMP = "claudedocs/summer-final-xlsx-dump.json";
const SUMMER_KEY = "2026-summer";
const NOTE = "2026 여름 시즌 중단 (최종 SoT 2026-06-26)";
const ORG_MAP: Record<string, string> = { "엥크레": "encre", "오랑캐": "oranke", "팔랑크스": "phalanx" };
const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/apply-summer-stopped-${MODE}-${STAMP}.json`;
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const line = (s = "") => console.log(s);

function loadStopped() {
  const d = JSON.parse(readFileSync(DUMP, "utf8"));
  const rows: string[][] = d.sheets[0].rows;
  const out: Array<{ orgSlug: string; name: string; weeks: number | null }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const name = (r[1] ?? "").trim(); if (!name) continue;
    const c2 = (r[2] ?? "").trim(), c3 = (r[3] ?? "").trim(); const c2num = /^\d+$/.test(c2);
    const status = (c2num ? c3 : c2).replace(/\s+/g, ""); const wr = c2num ? c2 : c3;
    if (!status.includes("중단")) continue;
    out.push({ orgSlug: ORG_MAP[(r[0] ?? "").trim()] ?? "", name, weeks: /^\d+$/.test(wr) ? Number(wr) : null });
  }
  return out;
}

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const ids: string[] = log.insertedIds ?? [];
  let del = 0;
  for (const id of ids) {
    const { data, error } = await sb.from("user_season_statuses").delete().eq("id", id).eq("season_key", SUMMER_KEY).eq("status", "stopped").select("id");
    if (error) throw new Error(error.message);
    del += (data ?? []).length;
  }
  line(`rollback — ${del}/${ids.length}행 삭제(2026-summer stopped 가드)`);
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", deleted: del }, null, 1));
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);
  const stopped = loadStopped();

  // 프로필 + approved + 기존 summer status
  const profByOrgName = new Map<string, any[]>(); const profById = new Map<string, any>();
  for (const org of ["encre", "oranke", "phalanx"]) {
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from("user_profiles").select("user_id,display_name,organization_slug").eq("organization_slug", org).order("user_id").range(from, from + 999);
      const rows = (data ?? []) as any[];
      for (const p of rows) { const k = `${org}|${(p.display_name ?? "").trim()}`; const a = profByOrgName.get(k) ?? []; a.push(p); profByOrgName.set(k, a); profById.set(p.user_id, p); }
      if (rows.length < 1000) break;
    }
  }
  const allIds = [...profById.keys()];
  const approvedById = new Map<string, number>();
  for (let i = 0; i < allIds.length; i += 300) { const { data } = await sb.from("user_growth_stats").select("user_id,approved_weeks").in("user_id", allIds.slice(i, i + 300)); for (const g of (data ?? []) as any[]) approvedById.set(g.user_id, g.approved_weeks); }
  const summerStatusById = new Map<string, string>();
  for (let from = 0; ; from += 1000) { const { data } = await sb.from("user_season_statuses").select("user_id,status").eq("season_key", SUMMER_KEY).order("user_id").range(from, from + 999); for (const r of (data ?? []) as any[]) summerStatusById.set(r.user_id, r.status); if ((data ?? []).length < 1000) break; }

  const resolved: Array<{ name: string; org: string; userId: string }> = [];
  const held: Array<{ name: string; org: string; reason: string }> = [];
  const conflicts: Array<{ name: string; org: string; userId: string; existing: string }> = [];
  for (const e of stopped) {
    const cands = profByOrgName.get(`${e.orgSlug}|${e.name}`) ?? [];
    if (cands.length === 0) { held.push({ name: e.name, org: e.orgSlug, reason: "매칭0" }); continue; }
    let chosen = cands[0];
    if (cands.length > 1) {
      if (e.weeks == null) { held.push({ name: e.name, org: e.orgSlug, reason: "동명이인·주차없음" }); continue; }
      const sc = cands.map((c) => ({ c, d: Math.abs((approvedById.get(c.user_id) ?? -999) - e.weeks!) })).sort((a, b) => a.d - b.d);
      if (sc.length >= 2 && sc[0].d === sc[1].d) { held.push({ name: e.name, org: e.orgSlug, reason: "동명이인·주차동률" }); continue; }
      chosen = sc[0].c;
    }
    const existing = summerStatusById.get(chosen.user_id);
    if (existing && existing !== "stopped") { conflicts.push({ name: e.name, org: e.orgSlug, userId: chosen.user_id, existing }); continue; }
    if (existing === "stopped") { /* 멱등 skip */ continue; }
    resolved.push({ name: e.name, org: e.orgSlug, userId: chosen.user_id });
  }

  const perOrg = (arr: { org: string }[]) => ({ encre: arr.filter((x) => x.org === "encre").length, oranke: arr.filter((x) => x.org === "oranke").length, phalanx: arr.filter((x) => x.org === "phalanx").length });
  line("═".repeat(60));
  line(`MODE=${MODE} · Excel 중단 ${stopped.length}`);
  line(`삽입 대상(신규 stopped): ${resolved.length}  ${JSON.stringify(perOrg(resolved))}`);
  line(`보류 ${held.length}: ${held.map((h) => `${h.org}/${h.name}(${h.reason})`).join(", ") || "없음"}`);
  line(`충돌(기존 summer 행) ${conflicts.length}: ${conflicts.map((c) => `${c.org}/${c.name}=${c.existing}`).join(", ") || "없음"}`);
  const report: any = { mode: MODE, excelStopped: stopped.length, resolvedCount: resolved.length, perOrg: perOrg(resolved), held, conflicts, resolved };

  if (!APPLY) { writeFileSync(OUT, JSON.stringify(report, null, 1)); line(`\n→ ${OUT}\nPREVIEW — write 0.`); return; }
  if (held.length || conflicts.length) { line("⛔ 보류/충돌 존재 — 전원 확정 전 apply 중단(fail-closed)"); process.exit(1); }

  const insertedIds: string[] = [];
  for (const r of resolved) {
    const { data, error } = await sb.from("user_season_statuses").insert({ user_id: r.userId, season_key: SUMMER_KEY, status: "stopped", note: NOTE }).select("id").single();
    if (error) { report.insertedIds = insertedIds; report.failedAt = { name: r.name, error: error.message }; writeFileSync(OUT, JSON.stringify(report, null, 1)); line(`✖ ${r.name} 실패: ${error.message}`); process.exit(1); }
    insertedIds.push((data as any).id);
    line(`✔ ${r.org}/${r.name} (${r.userId.slice(0, 8)}) stopped 생성`);
  }
  report.insertedIds = insertedIds;
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  line(`\napply 완료 — ${insertedIds.length}행. rollback: --rollback ${OUT}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
