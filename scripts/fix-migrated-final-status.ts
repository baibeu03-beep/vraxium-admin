/**
 * 기이관 사용자 최종 상태 보정 — PMS 라이브 State → status/growth_status (2026-06-07).
 *   npx tsx --env-file=.env.local scripts/fix-migrated-final-status.ts            # preview
 *   npx tsx --env-file=.env.local scripts/fix-migrated-final-status.ts --apply
 *   npx tsx --env-file=.env.local scripts/fix-migrated-final-status.ts --rollback <runlog>
 *
 * 대상: users.source_system 보유(이관 기록) 전원. PMS usersinfo.State 재조회 →
 *   resolveAccountStatusFromPmsState 매핑값과 현재 user_profiles 가 다르면 보정.
 * 정책: 최종 상태(status/growth_status)만 갱신 — 시즌 이력/주차 데이터 무접촉
 *   (시즌별 progressStatus 는 인정 주차 기반·독립). graduated override 는 graduated 로.
 * snapshot: growth_status 는 카드 판정에 무관(이력서 배지·시즌이력만) — 재계산 불요.
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { resolveAccountStatusFromPmsState } from "@/lib/pmsMigration";

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK_FILE = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK_FILE ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/fix-final-status-${MODE}-${STAMP}.json`;
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const issues: string[] = [];
  for (const r of log.changes ?? []) {
    const { error } = await sb.from("user_profiles")
      .update({ status: r.prior.status, growth_status: r.prior.growth_status }).eq("user_id", r.uuid);
    if (error) issues.push(`${r.uuid}: ${error.message}`);
  }
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", restored: (log.changes ?? []).length, issues }, null, 1));
  console.log(issues.length ? issues.join("\n") : `rollback 완료 (${(log.changes ?? []).length}행 복원)`);
  process.exit(issues.length ? 1 : 0);
}

async function main() {
  if (ROLLBACK_FILE) return rollback(ROLLBACK_FILE);
  // 이관 사용자 (source_system, legacy_user_id)
  const migrated: Array<{ id: string; source_system: string; legacy_user_id: number }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("users").select("id,source_system,legacy_user_id").not("source_system", "is", null).order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const u of (data ?? []) as any[]) migrated.push(u);
    if ((data ?? []).length < 1000) break;
  }
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });
  const changes: any[] = [];
  for (const u of migrated) {
    const [[info]] = (await conn.query(`SELECT State FROM ${u.source_system}.usersinfo WHERE UserID=?`, [u.legacy_user_id])) as any;
    if (!info) continue;
    const want = resolveAccountStatusFromPmsState(info.State);
    const { data: prof } = await sb.from("user_profiles").select("status,growth_status,display_name").eq("user_id", u.id).maybeSingle();
    const p = prof as any;
    if (!p) continue;
    if (p.status !== want.status || p.growth_status !== want.growthStatus) {
      changes.push({
        uuid: u.id, name: p.display_name, source: u.source_system, legacy: u.legacy_user_id, pmsState: info.State,
        prior: { status: p.status, growth_status: p.growth_status },
        next: { status: want.status, growth_status: want.growthStatus },
      });
    }
  }
  await conn.end();

  console.log(`이관 사용자 ${migrated.length} | 보정 대상 ${changes.length}`);
  for (const c of changes) console.log(` ${c.name} (${c.source} ${c.legacy}) PMS='${c.pmsState}' | ${c.prior.status}/${c.prior.growth_status} → ${c.next.status}/${c.next.growth_status}`);

  const log: any = { mode: MODE, total: changes.length, changes, applied: 0, errors: [] };
  if (APPLY) {
    for (const c of changes) {
      const { data, error } = await sb.from("user_profiles")
        .update({ status: c.next.status, growth_status: c.next.growth_status, updated_at: new Date().toISOString() })
        .eq("user_id", c.uuid).eq("status", c.prior.status).select("user_id"); // 구값 가드
      if (error || (data ?? []).length !== 1) log.errors.push(`${c.uuid}: ${error?.message ?? "rows≠1"}`);
      else log.applied++;
    }
  }
  writeFileSync(OUT, JSON.stringify(log, null, 1));
  console.log(`mode=${MODE}${APPLY ? ` | applied ${log.applied} | errors ${log.errors.length}` : ""}`);
  console.log("→", OUT);
  if (log.errors.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
