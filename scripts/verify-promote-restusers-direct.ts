/**
 * verify-promote-restusers-direct — 승격자 direct(DB) 전수 검증 (org 단위).
 *   Usage: npx tsx --env-file=.env.local scripts/verify-promote-restusers-direct.ts [--org encre]
 *
 * 전수 검사(빠름·DB only): profile status=active·growth=seasonal_rest, current_team_name=시즌전체휴식,
 *   user_season_statuses(2026-spring,rest), snapshot 행 존재 AND is_stale=false(실제 recompute),
 *   user_growth_stats 존재, archive promotion_status=promoted, 2026-spring uws=0.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL")!, get("SUPABASE_SERVICE_ROLE_KEY")!);
const orgIdx = process.argv.indexOf("--org");
const ORG = orgIdx >= 0 ? process.argv[orgIdx + 1].trim() : null;

async function fetchAll<T>(table: string, select: string, orderCol: string, filt?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const promoted = await fetchAll<any>(
    "legacy_pms_restuser_archive", "source_system,legacy_user_id,name,organization_slug,promoted_user_id", "legacy_user_id",
    (q) => { let x = q.eq("promotion_status", "promoted"); if (ORG) x = x.eq("organization_slug", ORG); return x; });
  console.log(`promoted${ORG ? ` org=${ORG}` : ""}: ${promoted.length}명 전수 검증`);
  const ids = promoted.map((p) => p.promoted_user_id);

  // batch reads
  const prof = new Map<string, any>();
  const ussRest = new Set<string>();
  const snap = new Map<string, boolean>(); // user_id → is_stale
  const gs = new Set<string>();
  const springUws = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const c = ids.slice(i, i + 200);
    const { data: ps } = await sb.from("user_profiles").select("user_id,status,growth_status,current_team_name").in("user_id", c);
    for (const p of ps ?? []) prof.set(p.user_id, p);
    const { data: us } = await sb.from("user_season_statuses").select("user_id").eq("season_key", "2026-spring").eq("status", "rest").in("user_id", c);
    for (const u of us ?? []) ussRest.add(u.user_id);
    const { data: sn } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,is_stale").in("user_id", c);
    for (const s of sn ?? []) snap.set(s.user_id, s.is_stale);
    const { data: g } = await sb.from("user_growth_stats").select("user_id").in("user_id", c);
    for (const x of g ?? []) gs.add(x.user_id);
    const { data: uw } = await sb.from("user_week_statuses").select("user_id").eq("season_key", "2026-spring").in("user_id", c);
    for (const w of uw ?? []) springUws.set(w.user_id, (springUws.get(w.user_id) ?? 0) + 1);
  }

  let bad = 0;
  const fails: string[] = [];
  for (const p of promoted) {
    const uid = p.promoted_user_id;
    const pr = prof.get(uid);
    const errs: string[] = [];
    if (!pr) errs.push("profile 없음");
    else {
      if (pr.status !== "active") errs.push(`status=${pr.status}`);
      if (pr.growth_status !== "seasonal_rest") errs.push(`growth=${pr.growth_status}`);
      if (pr.current_team_name !== "시즌전체휴식") errs.push(`team=${pr.current_team_name}`);
    }
    if (!ussRest.has(uid)) errs.push("2026-spring rest 없음");
    if (!snap.has(uid)) errs.push("snapshot 행 없음");
    else if (snap.get(uid) === true) errs.push("snapshot is_stale=true");
    if (!gs.has(uid)) errs.push("growth_stats 없음");
    if ((springUws.get(uid) ?? 0) > 0) errs.push(`2026-spring uws=${springUws.get(uid)}`);
    if (errs.length) { bad++; fails.push(`✗ ${p.source_system}/${p.legacy_user_id} ${p.name}: ${errs.join(", ")}`); }
  }
  if (fails.length) console.log(fails.slice(0, 30).join("\n"));
  console.log(`\n${bad === 0 ? `✅ direct 전수 통과 (${promoted.length}명)` : `✗ ${bad}/${promoted.length} 실패`}`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
