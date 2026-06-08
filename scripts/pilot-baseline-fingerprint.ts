/**
 * Pilot apply 전/후 — 비대상 사용자 무영향 fingerprint (read-only).
 *   npx tsx --env-file=.env.local scripts/pilot-baseline-fingerprint.ts [라벨]
 * 대상 제외: P3 olympus 249·P4 248 의 기존 uuid (apply 가 정당하게 수정) — 그 외 전원 불변 기대.
 */
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const LABEL = process.argv[2] ?? "before";
const OUT = `claudedocs/pilot-baseline-${LABEL}-20260607.json`;
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

async function fetchAll<T>(table: string, select: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).order(order, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  // pilot 대상 uuid (P3/P4 기존 + 신규 3명은 legacy 페어로 식별)
  const { data: p34 } = await sb.from("users").select("id").in("legacy_user_id", [248, 249]).is("source_system", null);
  const { data: sourced } = await sb.from("users").select("id").not("source_system", "is", null);
  const exclude = new Set([
    ...((p34 ?? []) as Array<{ id: string }>).map((r) => r.id),
    ...((sourced ?? []) as Array<{ id: string }>).map((r) => r.id), // apply 후 생성/기록분
  ]);
  const fp: Record<string, { rows: number; hash: string }> = {};
  for (const [t, sel, ord] of [
    ["users", "id,legacy_user_id,source_system", "id"],
    ["user_profiles", "user_id,display_name,organization_slug,updated_at", "user_id"],
    ["user_week_statuses", "id,user_id,week_start_date,status", "id"],
    ["user_weekly_points", "id,user_id,week_start_date,points,advantages,penalty,checks_migrated", "id"],
    ["cluster4_weekly_card_snapshots", "user_id,computed_at,is_stale,dto_version", "user_id"],
  ] as const) {
    const rows = (await fetchAll<any>(t, sel, ord)).filter(
      (r) => !exclude.has(r.user_id ?? r.id),
    );
    fp[t] = { rows: rows.length, hash: sha1(JSON.stringify(rows)) };
  }
  writeFileSync(OUT, JSON.stringify({ label: LABEL, excludeCount: exclude.size, fp }, null, 1));
  console.log(LABEL, JSON.stringify(fp));
  console.log("→", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
