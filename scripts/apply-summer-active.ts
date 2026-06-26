/**
 * apply-summer-active — 2026 여름 운영 대상자 중 활동/운영진/검수/기타 → user_season_statuses(2026-summer, active).
 *   npx tsx --env-file=.env.local scripts/apply-summer-active.ts            # PREVIEW (write 0)
 *   npx tsx --env-file=.env.local scripts/apply-summer-active.ts --apply
 *   npx tsx --env-file=.env.local scripts/apply-summer-active.ts --rollback <runlog.json>
 *
 * 계약(2026-06-26): 'active'=시즌 참여 멤버십 마커(displayGrowthStatus 무영향). growth_status 무수정·과거 무소급.
 *   대상 = Excel SoT 중 휴식/중단 아닌 행(활동·운영진·검수·기타). 동명이인 approved_weeks 확정(0/동률=보류).
 *   이미 2026-summer 행(rest/stopped/active) 보유자 = skip(충돌 보고). 마이그(active 허용) 선행 필수.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const DUMP = "claudedocs/summer-final-xlsx-dump.json";
const SUMMER_KEY = "2026-summer";
const NOTE = "2026 여름 시즌 참여(활동) — 최종 SoT 2026-06-26";
const ORG_MAP: Record<string, string> = { "엥크레": "encre", "오랑캐": "oranke", "팔랑크스": "phalanx" };
const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/apply-summer-active-${MODE}-${STAMP}.json`;
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const line = (s = "") => console.log(s);

function activeRows() {
  const d = JSON.parse(readFileSync(DUMP, "utf8"));
  const rows: string[][] = d.sheets[0].rows;
  const out: Array<{ orgSlug: string; name: string; cat: string; weeks: number | null }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const name = (r[1] ?? "").trim(); if (!name) continue;
    const c2 = (r[2] ?? "").trim(), c3 = (r[3] ?? "").trim(); const c2num = /^\d+$/.test(c2);
    const status = (c2num ? c3 : c2).replace(/\s+/g, ""); const wr = c2num ? c2 : c3;
    if (status.includes("휴식") || status.includes("중단")) continue; // active-category 만
    const cat = status.includes("운영진") ? "운영진" : status.includes("검수") ? "검수" : status.includes("활동") ? "활동" : "기타";
    out.push({ orgSlug: ORG_MAP[(r[0] ?? "").trim()] ?? "", name, cat, weeks: /^\d+$/.test(wr) ? Number(wr) : null });
  }
  return out;
}

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const ids: string[] = log.insertedIds ?? [];
  let del = 0;
  for (const id of ids) {
    const { data, error } = await sb.from("user_season_statuses").delete().eq("id", id).eq("season_key", SUMMER_KEY).eq("status", "active").select("id");
    if (error) throw new Error(error.message);
    del += (data ?? []).length;
  }
  line(`rollback — ${del}/${ids.length}행 삭제(2026-summer active 가드)`);
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", deleted: del }, null, 1));
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);
  const targets = activeRows();

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

  const resolved: Array<{ name: string; org: string; userId: string; cat: string }> = [];
  const held: Array<{ name: string; org: string; cat: string; reason: string }> = [];
  const usedUserIds = new Set<string>();
  for (const e of targets) {
    const cands = profByOrgName.get(`${e.orgSlug}|${e.name}`) ?? [];
    if (cands.length === 0) { held.push({ name: e.name, org: e.orgSlug, cat: e.cat, reason: "매칭0(미존재/미이관)" }); continue; }
    let chosen: any = cands[0];
    if (cands.length > 1) {
      if (e.weeks == null) { held.push({ name: e.name, org: e.orgSlug, cat: e.cat, reason: "동명이인·주차없음" }); continue; }
      // 이미 다른 행에 쓰였거나 기존 2026-summer 행(rest/stopped 등) 보유 후보는 제외 후 approved 근접 선택.
      //   (예: 김준우 휴식=9d1d0edd 는 제외 → 활동 김준우는 나머지 후보로 분리.)
      const avail = cands.filter((c) => !usedUserIds.has(c.user_id) && !summerStatusById.has(c.user_id));
      const sc = avail.map((c) => ({ c, d: Math.abs((approvedById.get(c.user_id) ?? -999) - e.weeks!) })).sort((a, b) => a.d - b.d);
      if (sc.length === 0) { held.push({ name: e.name, org: e.orgSlug, cat: e.cat, reason: "동명이인 후보 소진(전원 기존행 보유)" }); continue; }
      if (sc.length >= 2 && sc[0].d === sc[1].d) { held.push({ name: e.name, org: e.orgSlug, cat: e.cat, reason: "동명이인·주차동률" }); continue; }
      chosen = sc[0].c;
    } else {
      // 단일 매칭이 이미 2026-summer 행 보유 시 충돌(중복 방지).
      const ex = summerStatusById.get(chosen.user_id);
      if (ex) { held.push({ name: e.name, org: e.orgSlug, cat: e.cat, reason: `기존 2026-summer=${ex}(충돌/중복)` }); continue; }
    }
    usedUserIds.add(chosen.user_id);
    resolved.push({ name: e.name, org: e.orgSlug, userId: chosen.user_id, cat: e.cat });
  }

  const perOrg = (arr: { org: string }[]) => ({ encre: arr.filter((x) => x.org === "encre").length, oranke: arr.filter((x) => x.org === "oranke").length, phalanx: arr.filter((x) => x.org === "phalanx").length });
  const perCat = (arr: { cat: string }[]) => arr.reduce((m: any, x) => ((m[x.cat] = (m[x.cat] ?? 0) + 1), m), {});
  line("═".repeat(64));
  line(`MODE=${MODE} · Excel active-category 행 ${targets.length}`);
  line(`삽입 대상(신규 active): ${resolved.length}  org=${JSON.stringify(perOrg(resolved))} cat=${JSON.stringify(perCat(resolved))}`);
  line(`보류 ${held.length}: ${held.map((h) => `${h.org}/${h.name}[${h.cat}](${h.reason})`).join(", ") || "없음"}`);
  // 예상 total
  const { count: restN } = await sb.from("user_season_statuses").select("user_id", { count: "exact", head: true }).eq("season_key", SUMMER_KEY).eq("status", "rest");
  const { count: stopN } = await sb.from("user_season_statuses").select("user_id", { count: "exact", head: true }).eq("season_key", SUMMER_KEY).eq("status", "stopped");
  line(`예상 2026-summer 합계 = active ${resolved.length} + rest ${restN} + stopped ${stopN} = ${resolved.length + (restN ?? 0) + (stopN ?? 0)}`);
  const report: any = { mode: MODE, targets: targets.length, resolvedCount: resolved.length, perOrg: perOrg(resolved), perCat: perCat(resolved), held, resolved, expect: { active: resolved.length, rest: restN, stopped: stopN, total: resolved.length + (restN ?? 0) + (stopN ?? 0) } };

  if (!APPLY) { writeFileSync(OUT, JSON.stringify(report, null, 1)); line(`\n→ ${OUT}\nPREVIEW — write 0.`); return; }

  const insertedIds: string[] = [];
  for (const r of resolved) {
    const { data, error } = await sb.from("user_season_statuses").insert({ user_id: r.userId, season_key: SUMMER_KEY, status: "active", note: NOTE }).select("id").single();
    if (error) { report.insertedIds = insertedIds; report.failedAt = { name: r.name, error: error.message }; writeFileSync(OUT, JSON.stringify(report, null, 1)); line(`✖ ${r.name} 실패: ${error.message}`); process.exit(1); }
    insertedIds.push((data as any).id);
  }
  report.insertedIds = insertedIds;
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  line(`\napply 완료 — active ${insertedIds.length}행. rollback: --rollback ${OUT}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
